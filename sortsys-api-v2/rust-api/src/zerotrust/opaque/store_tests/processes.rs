use super::*;
use futures_util::FutureExt;
use std::panic::{AssertUnwindSafe, resume_unwind};
use tokio::{io::AsyncBufReadExt, process::Child};

pub(super) async fn run_browser(settings: &Config, root: &Path, mode: &str) {
    run_browser_sequence(settings, root, &[mode], None).await;
}

pub(super) async fn run_browser_with_mcp(settings: &Config, root: &Path, mode: &str) {
    let first = ApiProcess::start(settings, root, "first").await;
    let mcp_url = format!("{}internal/llm/mcp", first.endpoint);
    let second = ApiProcess::start_with_mcp(settings, root, "second", Some(&mcp_url)).await;
    run_browser_on_pair(root, &[mode], None, first, second).await;
}

pub(super) async fn run_browser_sequence(
    settings: &Config,
    root: &Path,
    modes: &[&str],
    tenant: Option<&str>,
) {
    let first = ApiProcess::start(settings, root, "first").await;
    let second = ApiProcess::start(settings, root, "second").await;
    run_browser_on_pair(root, modes, tenant, first, second).await;
}

async fn run_browser_on_pair(
    root: &Path,
    modes: &[&str],
    tenant: Option<&str>,
    mut first: ApiProcess,
    mut second: ApiProcess,
) {
    assert_ne!(first.pid, second.pid);
    assert_ne!(first.endpoint, second.endpoint);
    let endpoints = [first.endpoint.clone(), second.endpoint.clone()];
    let path = root.join("api-processes.json");
    let mut report = serde_json::json!({
        "parentPid": std::process::id(),
        "apiPids": [first.pid, second.pid],
        "endpoints": endpoints,
        "stopped": false,
    });
    std::fs::write(&path, report.to_string()).unwrap();
    let result = AssertUnwindSafe(async {
        for mode in modes {
            browser_with_tenant(mode, root, Some(&endpoints), tenant).await;
        }
    })
    .catch_unwind()
    .await;
    first.stop().await;
    second.stop().await;
    report["stopped"] = serde_json::json!(true);
    std::fs::write(path, report.to_string()).unwrap();
    if let Err(failure) = result {
        resume_unwind(failure);
    }
}

pub(super) struct ApiProcess {
    pub endpoint: String,
    pub pid: u32,
    child: Child,
}

impl ApiProcess {
    pub async fn start(settings: &Config, root: &Path, label: &str) -> Self {
        Self::start_with_mcp(settings, root, label, None).await
    }

    async fn start_with_mcp(
        settings: &Config,
        root: &Path,
        label: &str,
        mcp_url: Option<&str>,
    ) -> Self {
        let executable = std::env::var("SORTSYS_NATIVE_API_EXECUTABLE")
            .expect("scripts/test-native-auth must build the isolated API example");
        let log = std::fs::File::create(root.join(format!("api-{label}.log"))).unwrap();
        let mut command = Command::new(executable);
        command
            .kill_on_drop(true)
            .env("SORTSYS_DISPOSABLE_AUTH_TEST", "1")
            .env(
                "SORTSYS_ISOLATED_API_CONTROL_URL",
                settings.store.control_url.as_ref(),
            )
            .env(
                "SORTSYS_ISOLATED_API_QUACK_URI",
                settings.store.uri.as_ref(),
            )
            .env(
                "SORTSYS_ISOLATED_API_SERVICE_TOKEN",
                settings.store.token.as_ref(),
            )
            .env(
                "SORTSYS_ISOLATED_API_EXTENSIONS",
                &settings.store.extensions,
            )
            .env(
                "SORTSYS_ISOLATED_API_JWT_SECRET",
                std::str::from_utf8(&settings.jwt_secret).unwrap(),
            )
            .env(
                "SORTSYS_ISOLATED_API_ADMIN_HASH",
                settings.admin_hash.as_ref(),
            )
            .env(
                "SORTSYS_ISOLATED_API_OFFICE_ORIGIN",
                settings.editors.office_origin.as_deref().unwrap_or(""),
            )
            .env_remove("LLM_LIVE_INTERNAL_URL")
            .env_remove("LLM_MCP_URL")
            .env("LLM_ENCRYPTION_KEY", "disposable-native-test-provider-key")
            .stdout(Stdio::piped())
            .stderr(log);
        if let Some(url) = mcp_url {
            command.env("LLM_MCP_URL", url);
        }
        let mut child = command.spawn().unwrap();
        let pid = child.id().unwrap();
        assert_ne!(pid, std::process::id());
        let stdout = child.stdout.take().unwrap();
        let mut lines = tokio::io::BufReader::new(stdout).lines();
        let ready = tokio::time::timeout(std::time::Duration::from_secs(15), lines.next_line())
            .await
            .expect("isolated API startup deadline")
            .unwrap()
            .expect("isolated API exited before startup; inspect its log");
        let ready: serde_json::Value = serde_json::from_str(&ready).unwrap();
        assert_eq!(ready["pid"].as_u64(), Some(u64::from(pid)));
        let endpoint = ready["endpoint"].as_str().unwrap().to_owned();
        let url = url::Url::parse(&endpoint).unwrap();
        assert_eq!(url.scheme(), "http");
        assert_eq!(url.host_str(), Some("127.0.0.1"));
        assert!(url.port().is_some());
        Self {
            endpoint,
            pid,
            child,
        }
    }

    pub async fn stop(&mut self) {
        self.child.kill().await.unwrap();
        self.child.wait().await.unwrap();
    }
}
