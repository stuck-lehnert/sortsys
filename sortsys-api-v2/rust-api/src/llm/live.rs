//! Browser-owned, transient LLM context. Only admission/usage metadata is durable.
//! Routing proofs select a concrete API peer without putting context on a bus.

mod mcp;
mod socket;

use crate::{
    AppState,
    auth::{AuthResult, McpScope},
    error::{ErrorCode, RpcError, RpcResult},
    ids::Id,
    rpc::{ProcedureKind, ProcedureRegistryBuilder, RequestContext},
};
use axum::{
    Router,
    extract::State,
    extract::ws::WebSocketUpgrade,
    response::{IntoResponse, Response},
    routing::get,
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    net::SocketAddr,
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};
use tokio::sync::{Semaphore, mpsc, oneshot};
use ts_rs::TS;

pub const WS_PATH: &str = "/llm/live";
const WIRE_LIMIT: usize = 2 * 1024 * 1024;
const MAX_TOOL_REPLY: usize = 768 * 1024;
const REQUEST_SECONDS: u64 = 600;

#[derive(Clone, Copy, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "snake_case")]
enum LiveKind {
    Chat,
    DocumentImport,
}

#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OpenInput {
    kind: LiveKind,
    chat_id: Option<Id>,
    queries: Vec<String>,
    mutations: Vec<String>,
}
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct OpenOutput {
    ticket: String,
    subject: String,
    generation: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Ticket {
    purpose: String,
    run: String,
    tenant: String,
    session: String,
    user: String,
    subject: String,
    generation: String,
    kind: LiveKind,
    chat_id: Option<Id>,
    queries: Vec<String>,
    mutations: Vec<String>,
    exp: u64,
}
impl Ticket {
    fn scope(&self) -> RpcResult<McpScope> {
        match (self.kind, self.chat_id) {
            (LiveKind::Chat, Some(id)) => Ok(McpScope::Chat(id.0)),
            (LiveKind::DocumentImport, None) => Ok(McpScope::DocumentImport),
            _ => Err(invalid()),
        }
    }
    fn matches(&self, auth: &AuthResult, scope: McpScope) -> bool {
        self.tenant == auth.tenant
            && self.session == auth.session.id
            && self.user == auth.user.id
            && self.scope().is_ok_and(|expected| expected == scope)
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Owner {
    purpose: String,
    run: String,
    instance: String,
    endpoint: String,
    tenant: String,
    session: String,
    user: String,
    generation: String,
    kind: LiveKind,
    chat_id: Option<Id>,
    exp: u64,
}

struct Call {
    id: String,
    name: String,
    arguments: Value,
}
type Reply = RpcResult<Value>;
struct Session {
    closed: std::sync::atomic::AtomicBool,
    ticket: Ticket,
    outgoing: mpsc::Sender<Call>,
    pending: Mutex<HashMap<String, oneshot::Sender<Reply>>>,
}
impl Session {
    async fn call(&self, name: &str, arguments: Value) -> Reply {
        let id = random()?;
        let (tx, rx) = oneshot::channel();
        {
            let mut pending = self.pending.lock().map_err(|_| unavailable())?;
            if self.closed.load(std::sync::atomic::Ordering::Acquire) {
                return Err(unavailable());
            }
            if pending.len() >= 8 {
                return Err(busy());
            }
            pending.insert(id.clone(), tx);
        }
        if self
            .outgoing
            .try_send(Call {
                id: id.clone(),
                name: name.into(),
                arguments,
            })
            .is_err()
        {
            self.pending.lock().map_err(|_| unavailable())?.remove(&id);
            return Err(busy());
        }
        let result = tokio::time::timeout(Duration::from_secs(60), rx).await;
        self.pending.lock().map_err(|_| unavailable())?.remove(&id);
        result
            .map_err(|_| unavailable())?
            .map_err(|_| unavailable())?
    }
    fn reply(&self, id: &str, output: Reply) -> RpcResult<()> {
        let sender = self
            .pending
            .lock()
            .map_err(|_| unavailable())?
            .remove(id)
            .ok_or_else(invalid)?;
        let _ = sender.send(output);
        Ok(())
    }
    fn close(&self) {
        if let Ok(mut pending) = self.pending.lock() {
            self.closed
                .store(true, std::sync::atomic::Ordering::Release);
            for (_, sender) in pending.drain() {
                let _ = sender.send(Err(unavailable()));
            }
        }
    }
}

pub struct Hub {
    instance: String,
    endpoint: OnceLock<String>,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    sockets: Arc<Semaphore>,
    requests: Arc<Semaphore>,
}
impl Default for Hub {
    fn default() -> Self {
        Self {
            instance: random().expect("OS randomness is required"),
            endpoint: OnceLock::new(),
            sessions: Mutex::new(HashMap::new()),
            sockets: Arc::new(Semaphore::new(32)),
            requests: Arc::new(Semaphore::new(4)),
        }
    }
}
impl Hub {
    /// Called after binding, also by tests with a real ephemeral listening port.
    pub async fn bind_listener(
        &self,
        config: &crate::config::Config,
        address: SocketAddr,
    ) -> RpcResult<()> {
        let endpoint = if let Some(configured) = &config.llm_live_internal_url {
            validate_endpoint(configured)?
        } else {
            let ip = if address.ip().is_unspecified() {
                use std::str::FromStr;
                let pg = sqlx::postgres::PgConnectOptions::from_str(&config.master_dsn)
                    .map_err(|_| unavailable())?;
                let peer = tokio::net::lookup_host((pg.get_host(), pg.get_port()))
                    .await
                    .map_err(|_| unavailable())?
                    .next()
                    .ok_or_else(unavailable)?;
                let socket = tokio::net::UdpSocket::bind(if peer.is_ipv6() {
                    "[::]:0"
                } else {
                    "0.0.0.0:0"
                })
                .await
                .map_err(|_| unavailable())?;
                socket.connect(peer).await.map_err(|_| unavailable())?;
                socket.local_addr().map_err(|_| unavailable())?.ip()
            } else {
                address.ip()
            };
            format!("http://{}", SocketAddr::new(ip, address.port()))
        };
        self.endpoint.set(endpoint).map_err(|_| unavailable())
    }
    fn owner(&self, state: &AppState, ticket: &Ticket) -> RpcResult<String> {
        state.auth.issue_challenge_token(&Owner {
            purpose: "llm-live-owner-v1".into(),
            run: ticket.run.clone(),
            instance: self.instance.clone(),
            endpoint: self.endpoint.get().ok_or_else(unavailable)?.clone(),
            tenant: ticket.tenant.clone(),
            session: ticket.session.clone(),
            user: ticket.user.clone(),
            generation: ticket.generation.clone(),
            kind: ticket.kind,
            chat_id: ticket.chat_id,
            exp: now() + REQUEST_SECONDS,
        })
    }
}

pub(crate) fn validate_endpoint(value: &str) -> RpcResult<String> {
    let url = reqwest::Url::parse(value).map_err(|_| invalid())?;
    if !["http", "https"].contains(&url.scheme())
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(invalid());
    }
    Ok(url.as_str().trim_end_matches('/').into())
}

pub fn router(state: Arc<AppState>) -> Router {
    Router::new().route(WS_PATH, get(upgrade)).with_state(state)
}
async fn upgrade(State(state): State<Arc<AppState>>, ws: WebSocketUpgrade) -> Response {
    let Ok(slot) = Arc::clone(&state.live_llm.sockets).try_acquire_owned() else {
        return axum::http::StatusCode::TOO_MANY_REQUESTS.into_response();
    };
    ws.max_message_size(WIRE_LIMIT)
        .max_frame_size(WIRE_LIMIT)
        .on_upgrade(move |socket| async move {
            let _slot = slot;
            // Errors may contain selected model context. Never log their Display.
            let _ = socket::serve(socket, state).await;
        })
}

pub(crate) fn register(
    builder: ProcedureRegistryBuilder,
    state: Arc<AppState>,
) -> ProcedureRegistryBuilder {
    builder.mutation("zerotrust.llm.open", move |ctx, input: OpenInput| {
        let state = Arc::clone(&state);
        async move { open(&state, &ctx, input).await }
    })
}
pub(crate) fn register_contract(builder: ProcedureRegistryBuilder) -> ProcedureRegistryBuilder {
    builder.mutation_stub::<OpenInput, OpenOutput>("zerotrust.llm.open")
}
async fn open(
    state: &AppState,
    context: &RequestContext,
    mut input: OpenInput,
) -> RpcResult<OpenOutput> {
    let auth = state.auth.authenticate(&context.headers).await?;
    authorize(state, &auth, input.kind).await?;
    let (subject, generation) = crate::zerotrust::live_identity(state, &auth).await?;
    for (paths, kind) in [
        (&mut input.queries, ProcedureKind::Query),
        (&mut input.mutations, ProcedureKind::Mutation),
    ] {
        if paths.len() > 512 {
            return Err(invalid());
        }
        paths.sort();
        paths.dedup();
        for path in paths.iter() {
            if !super::is_user_facing_procedure(path)
                || super::contract_specification(path)?.kind != kind
            {
                return Err(invalid());
            }
        }
    }
    let ticket = Ticket {
        purpose: "llm-live-browser-v1".into(),
        run: random()?,
        tenant: auth.tenant.clone(),
        session: auth.session.id.clone(),
        user: auth.user.id.clone(),
        subject: subject.clone(),
        generation: generation.clone(),
        kind: input.kind,
        chat_id: input.chat_id,
        queries: input.queries,
        mutations: input.mutations,
        exp: now() + 60,
    };
    ticket.scope()?;
    if ticket.kind == LiveKind::DocumentImport
        && (ticket.queries != ["products.list"] || !ticket.mutations.is_empty())
    {
        return Err(invalid());
    }
    Ok(OpenOutput {
        ticket: state.auth.issue_challenge_token(&ticket)?,
        subject,
        generation,
    })
}
async fn authorize(state: &AppState, auth: &AuthResult, kind: LiveKind) -> RpcResult<()> {
    match kind {
        LiveKind::Chat => {
            super::ensure_user_access(state, auth).await?;
        }
        LiveKind::DocumentImport => {
            super::ensure_scan_access(state, auth).await?;
            if !auth.can_do("manage:deliveryNotes") || !auth.can_do("view:products") {
                return Err(forbidden());
            }
        }
    }
    Ok(())
}

fn random() -> RpcResult<String> {
    let mut bytes = [0; 32];
    getrandom::fill(&mut bytes).map_err(|_| unavailable())?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}
fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn invalid() -> RpcError {
    RpcError::new(ErrorCode::BadRequest, "Invalid live LLM request")
}
fn forbidden() -> RpcError {
    RpcError::new(ErrorCode::Forbidden, "Live LLM access denied")
}
fn unavailable() -> RpcError {
    RpcError::new(
        ErrorCode::PreconditionFailed,
        "The live LLM client is unavailable",
    )
}
fn busy() -> RpcError {
    RpcError::new(ErrorCode::TooManyRequests, "Too many live LLM requests")
}

pub(super) use mcp::handle as handle_mcp;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    pub(super) fn ticket(kind: LiveKind) -> Ticket {
        Ticket {
            purpose: "llm-live-browser-v1".into(),
            run: "run".into(),
            tenant: "tenant".into(),
            session: "1".into(),
            user: "2".into(),
            subject: "user:2".into(),
            generation: "1".into(),
            kind,
            chat_id: if kind == LiveKind::Chat {
                Some(Id(1))
            } else {
                None
            },
            queries: vec!["products.list".into()],
            mutations: vec![],
            exp: now() + 60,
        }
    }

    #[test]
    fn owner_endpoints_cannot_smuggle_credentials_paths_or_redirects() {
        assert_eq!(
            validate_endpoint("http://127.0.0.1:3001/").unwrap(),
            "http://127.0.0.1:3001"
        );
        for endpoint in [
            "file:///tmp/data",
            "https://user:password@example.test",
            "https://example.test/mcp",
            "https://example.test/?next=internal",
            "https://example.test/#fragment",
        ] {
            assert!(validate_endpoint(endpoint).is_err());
        }
    }

    #[tokio::test]
    async fn tool_replies_are_request_scoped_and_close_releases_waiters() {
        let (outgoing, mut calls) = mpsc::channel(8);
        let session = Arc::new(Session {
            closed: std::sync::atomic::AtomicBool::new(false),
            ticket: ticket(LiveKind::DocumentImport),
            outgoing,
            pending: Mutex::new(HashMap::new()),
        });
        assert!(session.reply("forged-id", Ok(json!({}))).is_err());
        let first = Arc::clone(&session);
        let caller = tokio::spawn(async move {
            first
                .call("sortsys_search_products", json!({"query":"Putz"}))
                .await
        });
        let call = calls.recv().await.unwrap();
        assert_eq!(call.arguments["query"], "Putz");
        session.reply(&call.id, Ok(json!({"records":[]}))).unwrap();
        assert_eq!(caller.await.unwrap().unwrap(), json!({"records":[]}));
        assert!(session.reply(&call.id, Ok(json!({}))).is_err());
        let second = Arc::clone(&session);
        let caller =
            tokio::spawn(async move { second.call("sortsys_search_products", json!({})).await });
        calls.recv().await.unwrap();
        session.close();
        assert!(caller.await.unwrap().is_err());
        assert!(session.pending.lock().unwrap().is_empty());
        assert!(
            session
                .call("sortsys_search_products", json!({}))
                .await
                .is_err()
        );
    }
}
