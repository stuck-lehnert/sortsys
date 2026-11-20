//! Browser-owned, transient LLM context. Only admission/usage metadata is durable.
//! Routing proofs select a concrete API peer without putting context on a bus.

mod mcp;
mod persistence;
mod socket;

use crate::{
    auth::AuthService,
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
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::sync::{Semaphore, mpsc, oneshot};
use ts_rs::TS;

pub(crate) struct Runtime {
    pub auth: Arc<AuthService>,
    pub live_llm: Arc<Hub>,
    pub settings: Arc<super::control::Settings>,
    pub events: Arc<crate::zerotrust::events::Hub>,
}
impl Runtime {
    pub(crate) fn new(
        auth: Arc<AuthService>,
        settings: Arc<super::control::Settings>,
    ) -> Arc<Self> {
        Arc::new(Self {
            auth,
            live_llm: Arc::new(Hub::default()),
            settings,
            events: Arc::new(crate::zerotrust::events::Hub::default()),
        })
    }
}

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
    #[serde(default)]
    #[ts(optional)]
    documents: Option<bool>,
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
    documents: bool,
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
    closed: AtomicBool,
    ticket: Ticket,
    outgoing: mpsc::Sender<Call>,
    pending: Mutex<HashMap<String, oneshot::Sender<Reply>>>,
}

struct PendingCall<'a> {
    session: &'a Session,
    id: &'a str,
}

impl Drop for PendingCall<'_> {
    fn drop(&mut self) {
        if let Ok(mut pending) = self.session.pending.lock() {
            pending.remove(self.id);
        }
    }
}

impl Session {
    fn is_open(&self) -> bool {
        !self.closed.load(Ordering::Acquire)
    }

    async fn call(&self, name: &str, arguments: Value) -> Reply {
        let id = random()?;
        let (tx, rx) = oneshot::channel();
        {
            let mut pending = self.pending.lock().map_err(|_| unavailable())?;
            if !self.is_open() {
                return Err(unavailable());
            }
            if pending.len() >= 8 {
                return Err(busy());
            }
            pending.insert(id.clone(), tx);
        }
        let _pending = PendingCall {
            session: self,
            id: &id,
        };
        self.outgoing
            .try_send(Call {
                id: id.clone(),
                name: name.into(),
                arguments,
            })
            .map_err(|_| busy())?;
        tokio::time::timeout(Duration::from_secs(60), rx)
            .await
            .map_err(|_| unavailable())?
            .map_err(|_| unavailable())?
    }
    fn reply(&self, id: &str, output: Reply) -> RpcResult<bool> {
        let sender = self.pending.lock().map_err(|_| unavailable())?.remove(id);
        // A cancelled tool call can still have a reply on the browser socket.
        Ok(sender.is_some_and(|sender| sender.send(output).is_ok()))
    }
    fn close(&self) {
        self.closed.store(true, Ordering::Release);
        if let Ok(mut pending) = self.pending.lock() {
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
    pub(crate) async fn bind_to(
        &self,
        configured: Option<&str>,
        store_url: Option<&str>,
        address: SocketAddr,
    ) -> RpcResult<()> {
        let endpoint = if let Some(configured) = configured {
            validate_endpoint(configured)?
        } else {
            let ip = if address.ip().is_unspecified() {
                let target = reqwest::Url::parse(store_url.ok_or_else(unavailable)?)
                    .map_err(|_| unavailable())?;
                let peer = tokio::net::lookup_host((
                    target.host_str().ok_or_else(unavailable)?,
                    target.port_or_known_default().ok_or_else(unavailable)?,
                ))
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
    fn owner(&self, state: &Runtime, ticket: &Ticket) -> RpcResult<String> {
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

pub(crate) fn router_native(state: Arc<Runtime>) -> Router {
    Router::new()
        .route(WS_PATH, get(upgrade))
        .route("/internal/llm/mcp", axum::routing::post(native_mcp))
        .with_state(state)
}
async fn native_mcp(
    State(state): State<Arc<Runtime>>,
    axum::extract::Query(parameters): axum::extract::Query<HashMap<String, String>>,
    headers: axum::http::HeaderMap,
    axum::Json(request): axum::Json<super::McpRequest>,
) -> Response {
    let Some(route) = parameters.get("live") else {
        return axum::http::StatusCode::FORBIDDEN.into_response();
    };
    mcp::handle(state, headers, request, route).await
}
async fn upgrade(State(state): State<Arc<Runtime>>, ws: WebSocketUpgrade) -> Response {
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

pub(crate) fn register_native(
    builder: ProcedureRegistryBuilder,
    state: Arc<Runtime>,
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
    state: &Runtime,
    context: &RequestContext,
    mut input: OpenInput,
) -> RpcResult<OpenOutput> {
    let auth = state.auth.authenticate(&context.headers).await?;
    let (subject, generation) =
        persistence::authorize_for_admission(&state.auth, &auth, input.kind).await?;
    configured_provider(state, input.kind).await?;
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
        documents: input.documents.unwrap_or_default(),
        exp: now() + 60,
    };
    ticket.scope()?;
    if ticket.kind == LiveKind::DocumentImport
        && (ticket.queries != ["products.list"] || !ticket.mutations.is_empty() || ticket.documents)
    {
        return Err(invalid());
    }
    Ok(OpenOutput {
        ticket: state.auth.issue_challenge_token(&ticket)?,
        subject,
        generation,
    })
}

async fn configured_provider(
    state: &Runtime,
    kind: LiveKind,
) -> RpcResult<super::ProviderConfiguration> {
    let use_case = match kind {
        LiveKind::Chat => super::CHAT_USE_CASE,
        LiveKind::DocumentImport => super::DOCUMENT_IMPORT_USE_CASE,
    };
    let configuration = super::control::configuration(&state.auth, &state.settings, use_case)
        .await?
        .ok_or_else(unavailable)?;
    if !super::provider::supports_mcp(&configuration.provider)
        || configuration.provider != "openrouter" && state.settings.mcp_url.is_none()
    {
        return Err(unavailable());
    }
    Ok(configuration)
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
            documents: false,
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
            closed: AtomicBool::new(false),
            ticket: ticket(LiveKind::DocumentImport),
            outgoing,
            pending: Mutex::new(HashMap::new()),
        });
        assert!(!session.reply("unmatched-id", Ok(json!({}))).unwrap());
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
        assert!(!session.reply(&call.id, Ok(json!({}))).unwrap());
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

    #[tokio::test]
    async fn cancelling_a_tool_call_releases_its_slot_and_discards_a_late_reply() {
        let (outgoing, mut calls) = mpsc::channel(8);
        let session = Arc::new(Session {
            closed: AtomicBool::new(false),
            ticket: ticket(LiveKind::DocumentImport),
            outgoing,
            pending: Mutex::new(HashMap::new()),
        });
        let caller = Arc::clone(&session);
        let request = tokio::spawn(async move {
            caller
                .call("sortsys_search_products", json!({"query":"Putz"}))
                .await
        });
        let abandoned = calls.recv().await.unwrap();
        assert_eq!(session.pending.lock().unwrap().len(), 1);
        request.abort();
        assert!(request.await.unwrap_err().is_cancelled());
        assert!(session.pending.lock().unwrap().is_empty());

        let caller = Arc::clone(&session);
        let request = tokio::spawn(async move {
            caller
                .call("sortsys_search_products", json!({"query":"Kalk"}))
                .await
        });
        let current = calls.recv().await.unwrap();
        assert!(!session.reply(&abandoned.id, Ok(json!({}))).unwrap());
        assert!(
            session
                .reply(&current.id, Ok(json!({"records":[]})))
                .unwrap()
        );
        assert_eq!(request.await.unwrap().unwrap(), json!({"records":[]}));
        assert!(session.is_open());
    }
}
