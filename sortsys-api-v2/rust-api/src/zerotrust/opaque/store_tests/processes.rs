use super::*;
use tokio::{io::AsyncBufReadExt, process::Child};

pub(super) struct ApiProcess {
    pub endpoint: String,
    pub pid: u32,
    child: Child,
}

impl ApiProcess {
    pub async fn start(settings: &Config, root: &Path, label: &str) -> Self {
        let executable = std::env::var("SORTSYS_NATIVE_API_EXECUTABLE")
            .expect("scripts/test-native-auth must build the isolated API example");
        let log = std::fs::File::create(root.join(format!("api-{label}.log"))).unwrap();
        let mut child = Command::new(executable)
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
            .stdout(Stdio::piped())
            .stderr(log)
            .spawn()
            .unwrap();
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
