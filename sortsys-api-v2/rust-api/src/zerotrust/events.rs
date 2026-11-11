//! Public change hints only. One PostgreSQL listener per active tenant and API
//! process fans out committed notifications; document values never enter it.
use super::{
    access::security,
    crypto::{encode, frame, random_id, verify},
    wire::{Action, Effect},
};
use crate::{
    AppState,
    auth::AuthResult,
    error::{ErrorCode, RpcError, RpcResult},
    procedures::common::{forbidden, internal},
    rpc::{ProcedureRegistryBuilder, RequestContext},
};
use axum::{
    Router,
    extract::{
        State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::{HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{
    PgPool,
    postgres::{PgListener, PgPoolOptions},
};
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Weak},
    time::Duration,
};
use tokio::sync::{Mutex, Semaphore, broadcast, watch};
use ts_rs::TS;

pub const WS_PATH: &str = "/zerotrust/events";
#[derive(Clone)]
enum Event {
    Objects(String, i64),
    Domain(String),
    Access,
    Account(String),
    Resync,
}
struct Channel {
    outgoing: broadcast::Sender<Event>,
    _stop: watch::Sender<()>,
}
struct Subscription {
    _channel: Arc<Channel>,
    incoming: broadcast::Receiver<Event>,
}
pub struct Hub {
    tenants: Mutex<HashMap<String, Weak<Channel>>>,
    listeners: Arc<Semaphore>,
    sockets: Arc<Semaphore>,
}
impl Default for Hub {
    fn default() -> Self {
        Self {
            tenants: Mutex::new(HashMap::new()),
            listeners: Arc::new(Semaphore::new(64)),
            sockets: Arc::new(Semaphore::new(512)),
        }
    }
}
impl Hub {
    async fn subscribe(&self, tenant: &str, source: &PgPool) -> RpcResult<Subscription> {
        let mut tenants = self.tenants.lock().await;
        tenants.retain(|_, value| value.strong_count() > 0);
        if let Some(channel) = tenants.get(tenant).and_then(Weak::upgrade) {
            return Ok(Subscription {
                incoming: channel.outgoing.subscribe(),
                _channel: channel,
            });
        }
        let slot = Arc::clone(&self.listeners)
            .try_acquire_owned()
            .map_err(|_| unavailable())?;
        // A dedicated connection leaves the ordinary five-slot request pool free.
        let pool = PgPoolOptions::new()
            .max_connections(1)
            .min_connections(0)
            .connect_lazy_with((*source.connect_options()).clone());
        let listener = connect(&pool).await?;
        let (outgoing, incoming) = broadcast::channel(64);
        let (stop, mut stopped) = watch::channel(());
        let channel = Arc::new(Channel {
            outgoing: outgoing.clone(),
            _stop: stop,
        });
        tenants.insert(tenant.to_owned(), Arc::downgrade(&channel));
        tokio::spawn(async move {
            let _slot = slot;
            let mut current = Some(listener);
            loop {
                let mut listener = match current.take() {
                    Some(listener) => listener,
                    None => {
                        let next = tokio::select! { _ = stopped.changed() => break, value = connect(&pool) => value };
                        match next {
                            Ok(listener) => {
                                let _ = outgoing.send(Event::Resync);
                                listener
                            }
                            Err(_) => {
                                tokio::select! { _ = stopped.changed() => break, _ = tokio::time::sleep(Duration::from_secs(1)) => {} };
                                continue;
                            }
                        }
                    }
                };
                loop {
                    let next = tokio::select! { _ = stopped.changed() => break, value = listener.try_recv() => value };
                    match next {
                        Ok(Some(notification)) => {
                            if let Some(event) = parse(notification.payload()) {
                                let _ = outgoing.send(event);
                            }
                        }
                        Ok(None) => {
                            let _ = outgoing.send(Event::Resync);
                        }
                        Err(_) => break,
                    }
                }
                drop(listener);
                if stopped.has_changed().is_err() {
                    break;
                }
            }
            pool.close().await;
        });
        Ok(Subscription {
            _channel: channel,
            incoming,
        })
    }
}
async fn connect(pool: &PgPool) -> RpcResult<PgListener> {
    tokio::time::timeout(Duration::from_secs(3), async {
        let mut listener = PgListener::connect_with(pool).await?;
        listener.listen("sortsys_zerotrust").await?;
        Ok::<_, sqlx::Error>(listener)
    })
    .await
    .map_err(|_| unavailable())?
    .map_err(|_| unavailable())
}
fn parse(input: &str) -> Option<Event> {
    if input.len() > 8000 {
        return None;
    }
    let data: Value = serde_json::from_str(input).ok()?;
    match data.get("kind")?.as_str()? {
        "object" => {
            let domain = data.get("domain")?.as_str()?;
            super::crypto::identifier(domain).ok()?;
            let sequence = data.get("seq")?.as_str()?.parse::<i64>().ok()?;
            (sequence > 0).then(|| Event::Objects(domain.to_owned(), sequence))
        }
        "domain" => {
            let domain = data.get("domain")?.as_str()?;
            super::crypto::identifier(domain).ok()?;
            Some(Event::Domain(domain.to_owned()))
        }
        "policy" | "recovery" => Some(Event::Access),
        "account" => Some(Event::Account(data.get("user")?.as_str()?.to_owned())),
        _ => None,
    }
}
fn unavailable() -> RpcError {
    RpcError::new(
        ErrorCode::InternalServerError,
        "Encrypted event connection unavailable",
    )
    .with_http_code(503)
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Ticket {
    purpose: String,
    tenant: String,
    session: String,
    user: String,
    subject: String,
    generation: String,
    exp: u64,
}
#[derive(Serialize, TS)]
struct Open {
    ticket: String,
    subject: String,
    generation: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Admission {
    ticket: String,
    proof: String,
}
struct Snapshot {
    subject: String,
    generation: String,
    version: i64,
    fingerprint: String,
    capabilities: HashMap<[u8; 32], u8>,
    roles: Vec<String>,
    allowed: HashSet<String>,
    signing_key: Vec<u8>,
}

pub(super) fn register(
    builder: ProcedureRegistryBuilder,
    state: Arc<AppState>,
) -> ProcedureRegistryBuilder {
    builder.mutation(
        "zerotrust.events.open",
        move |ctx: RequestContext, _: ()| {
            let state = Arc::clone(&state);
            async move {
                let auth = state.auth.authenticate(&ctx.headers).await?;
                let snapshot = snapshot(&state, &auth).await?;
                let ticket = Ticket {
                    purpose: "encrypted-events-v1".into(),
                    tenant: auth.tenant,
                    session: auth.session.id,
                    user: auth.user.id,
                    subject: snapshot.subject.clone(),
                    generation: snapshot.generation.clone(),
                    exp: (chrono::Utc::now().timestamp() + 60) as u64,
                };
                Ok(Open {
                    ticket: state.auth.issue_challenge_token(&ticket)?,
                    subject: snapshot.subject,
                    generation: snapshot.generation,
                })
            }
        },
    )
}
pub(super) fn register_contract(builder: ProcedureRegistryBuilder) -> ProcedureRegistryBuilder {
    builder.mutation_stub::<(), Open>("zerotrust.events.open")
}
pub fn router(state: Arc<AppState>) -> Router {
    Router::new().route(WS_PATH, get(upgrade)).with_state(state)
}
async fn upgrade(State(state): State<Arc<AppState>>, ws: WebSocketUpgrade) -> Response {
    let Ok(slot) = Arc::clone(&state.encrypted_events.sockets).try_acquire_owned() else {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    };
    ws.max_message_size(16384)
        .max_frame_size(16384)
        .on_upgrade(move |mut socket| async move {
            let _slot = slot;
            if let Err(error) = serve(&mut socket, &state).await {
                // Fixed control code only, never ticket, proof or database diagnostics.
                if matches!(error.code, ErrorCode::Forbidden | ErrorCode::Unauthorized) {
                    let _ = send(&mut socket, json!({"type":"revoked"})).await;
                }
            }
            let _ = socket.send(Message::Close(None)).await;
        })
}
async fn authenticate(state: &AppState, ticket: &Ticket) -> RpcResult<AuthResult> {
    let token = state
        .auth
        .issue_user_token(&ticket.tenant, &ticket.session)
        .map_err(|_| forbidden())?;
    let mut headers = HeaderMap::new();
    headers.insert(
        "authorization",
        HeaderValue::from_str(&format!("Bearer {token}")).map_err(|_| forbidden())?,
    );
    let auth = state.auth.authenticate(&headers).await?;
    if auth.user.id != ticket.user
        || auth.tenant != ticket.tenant
        || auth.session.id != ticket.session
    {
        return Err(forbidden());
    }
    Ok(auth)
}
fn scope_key(scope: &str, facet: &str) -> [u8; 32] {
    Sha256::digest(frame("sortsys/event-scope/v1", &[scope, facet])).into()
}
fn action_bit(action: Action) -> u8 {
    match action {
        Action::Read => 1,
        Action::Create => 2,
        Action::Update => 4,
        Action::Delete => 8,
        Action::Approve => 16,
        Action::Grant => 32,
    }
}
fn capabilities(
    policy: &super::wire::SignedPolicy,
    subject: &str,
    inherited: &[super::wire::Rule],
) -> HashMap<[u8; 32], u8> {
    let mut allowed = HashMap::new();
    let mut denied = HashMap::new();
    for rule in policy.rules.iter().chain(inherited) {
        if rule.subject != subject {
            continue;
        }
        let mask = rule
            .actions
            .iter()
            .fold(0, |mask, action| mask | action_bit(*action));
        let target = if rule.effect == Effect::Deny {
            &mut denied
        } else {
            &mut allowed
        };
        *target
            .entry(scope_key(&rule.scope, rule.facet.name()))
            .or_insert(0) |= mask;
    }
    for (scope, denied) in denied {
        if let Some(mask) = allowed.get_mut(&scope) {
            *mask &= !denied;
        }
    }
    allowed.retain(|_, mask| *mask != 0);
    allowed
}
impl Snapshot {
    fn loses_to(&self, next: &Self) -> bool {
        self.capabilities
            .iter()
            .any(|(scope, mask)| next.capabilities.get(scope).copied().unwrap_or(0) & mask != *mask)
            || self.roles.iter().any(|role| !next.roles.contains(role))
    }
}
async fn snapshot(state: &AppState, auth: &AuthResult) -> RpcResult<Snapshot> {
    let pool = state
        .tenants
        .tenant_pool(&auth.tenant)
        .await
        .map_err(internal)?;
    let mut tx = pool.begin().await.map_err(internal)?;
    let guard = security(&mut tx, state.tenants.master(), auth, false).await?;
    let domains: Vec<(String, String, String)> =
        sqlx::query_as("SELECT id,scope,facet FROM __zerotrust_domains ORDER BY id LIMIT 2001")
            .fetch_all(&mut *tx)
            .await
            .map_err(internal)?;
    if domains.len() > 2000 {
        return Err(unavailable());
    }
    // Hash scope/facet pairs and combine action bits once. The small retained
    // masks distinguish revocation from an added right without rescanning rules.
    let capabilities = capabilities(&guard.policy, &guard.subject, &guard.inherited);
    let allowed = domains
        .into_iter()
        .filter_map(|(id, scope, facet)| {
            (capabilities
                .get(&scope_key(&scope, &facet))
                .copied()
                .unwrap_or(0)
                & 1
                != 0)
                .then_some(id)
        })
        .collect();
    let mut roles = auth.roles.clone();
    roles.sort();
    let mut rights = capabilities
        .iter()
        .map(|(scope, mask)| (encode(scope), mask))
        .collect::<Vec<_>>();
    rights.sort();
    let fingerprint = encode(&Sha256::digest(
        serde_json::to_vec(&(rights, &roles)).map_err(internal)?,
    ));
    Ok(Snapshot {
        subject: guard.subject,
        generation: guard.root.generation.to_string(),
        version: guard.root.policy_version,
        fingerprint,
        capabilities,
        roles,
        allowed,
        signing_key: guard.signing_key,
    })
}
async fn send(socket: &mut WebSocket, value: Value) -> RpcResult<()> {
    tokio::time::timeout(
        Duration::from_secs(5),
        socket.send(Message::Text(value.to_string().into())),
    )
    .await
    .map_err(|_| unavailable())?
    .map_err(|_| unavailable())
}
async fn serve(socket: &mut WebSocket, state: &Arc<AppState>) -> RpcResult<()> {
    let nonce = random_id()?;
    send(socket, json!({"type":"challenge","nonce":nonce})).await?;
    let admission = tokio::time::timeout(Duration::from_secs(5), socket.recv())
        .await
        .map_err(|_| forbidden())?
        .ok_or_else(forbidden)?
        .map_err(|_| forbidden())?;
    let Message::Text(admission) = admission else {
        return Err(forbidden());
    };
    let admission: Admission = serde_json::from_str(&admission).map_err(|_| forbidden())?;
    let ticket: Ticket = state.auth.verify_challenge_token(&admission.ticket)?;
    if ticket.purpose != "encrypted-events-v1"
        || ticket.exp <= chrono::Utc::now().timestamp() as u64
    {
        return Err(forbidden());
    }
    let auth = authenticate(state, &ticket).await?;
    let identity = snapshot(state, &auth).await?;
    if identity.subject != ticket.subject || identity.generation != ticket.generation {
        return Err(forbidden());
    }
    verify(
        &identity.signing_key,
        &admission.proof,
        &frame(
            "sortsys/events-browser/v1",
            &[
                &ticket.tenant,
                &ticket.subject,
                &ticket.generation,
                &encode(&Sha256::digest(admission.ticket.as_bytes())),
                &nonce,
            ],
        ),
    )?;
    let pool = state
        .tenants
        .tenant_pool(&ticket.tenant)
        .await
        .map_err(internal)?;
    let mut subscription = state
        .encrypted_events
        .subscribe(&ticket.tenant, &pool)
        .await?;
    // LISTEN is established before this baseline. Commits during admission are
    // either included here or remain queued, including policy/key changes.
    let mut current = snapshot(state, &authenticate(state, &ticket).await?).await?;
    if current.generation != ticket.generation {
        return Err(forbidden());
    }
    send(
        socket,
        json!({"type":"ready","fingerprint":current.fingerprint}),
    )
    .await?;
    let mut heartbeat = tokio::time::interval(Duration::from_secs(30));
    heartbeat.tick().await;
    loop {
        let event = tokio::select! {
            input = socket.recv() => { match input { Some(Ok(Message::Pong(_))) => continue, Some(Ok(Message::Ping(value))) => { socket.send(Message::Pong(value)).await.map_err(|_| unavailable())?; continue; }, _ => return Ok(()) } }
            _ = heartbeat.tick() => {
                let next = snapshot(state, &authenticate(state, &ticket).await?).await?;
                if next.generation != ticket.generation { return Err(forbidden()); }
                let changed = next.version != current.version || next.allowed != current.allowed || next.fingerprint != current.fingerprint;
                let reset = current.loses_to(&next);
                current = next;
                if changed { send(socket, json!({"type":"changed","reset":reset,"all":true,"control":true,"domains":{},"fingerprint":current.fingerprint})).await?; }
                socket.send(Message::Ping(Vec::new().into())).await.map_err(|_| unavailable())?; continue;
            }
            value = subscription.incoming.recv() => value,
        };
        tokio::time::sleep(Duration::from_millis(80)).await;
        let mut all = false;
        let mut refresh = false;
        let mut domains = HashMap::<String, Option<i64>>::new();
        let mut fold = |event: Event| match event {
            Event::Access | Event::Resync => {
                all = true;
                refresh = true;
            }
            Event::Domain(domain) => {
                refresh = true;
                domains.insert(domain, None);
            }
            Event::Account(user) if user == current.subject => {
                all = true;
                refresh = true;
            }
            Event::Objects(domain, sequence) => {
                domains
                    .entry(domain)
                    .and_modify(|head| {
                        if let Some(current) = head {
                            *current = (*current).max(sequence);
                        }
                    })
                    .or_insert(Some(sequence));
            }
            _ => {}
        };
        match event {
            Ok(event) => fold(event),
            Err(broadcast::error::RecvError::Lagged(_)) => fold(Event::Resync),
            Err(_) => return Err(unavailable()),
        }
        for _ in 0..64 {
            match subscription.incoming.try_recv() {
                Ok(event) => fold(event),
                Err(broadcast::error::TryRecvError::Lagged(_)) => fold(Event::Resync),
                Err(broadcast::error::TryRecvError::Empty) => break,
                Err(_) => return Err(unavailable()),
            }
        }
        let mut reset = false;
        if refresh {
            let next = snapshot(state, &authenticate(state, &ticket).await?).await?;
            reset = current.loses_to(&next);
            current = next;
            if current.generation != ticket.generation {
                return Err(forbidden());
            }
        }
        domains.retain(|domain, _| current.allowed.contains(domain));
        let domains = domains
            .into_iter()
            .map(|(domain, sequence)| (domain, sequence.map(|n| n.to_string())))
            .collect::<HashMap<_, _>>();
        if all || reset || !domains.is_empty() {
            send(
                socket,
                json!({"type":"changed","reset":reset,"all":all,"control":refresh,"domains":domains,"fingerprint":current.fingerprint}),
            )
            .await?;
        }
    }
}

pub(super) async fn notify_account(tx: &mut sqlx::PgConnection, user: &str) -> RpcResult<()> {
    sqlx::query("SELECT pg_notify('sortsys_zerotrust',$1)")
        .bind(json!({"kind":"account","user":user}).to_string())
        .execute(tx)
        .await
        .map_err(internal)?;
    Ok(())
}
pub(super) async fn notify_domain(tx: &mut sqlx::PgConnection, domain: &str) -> RpcResult<()> {
    sqlx::query("SELECT pg_notify('sortsys_zerotrust',$1)")
        .bind(json!({"kind":"domain","domain":domain}).to_string())
        .execute(tx)
        .await
        .map_err(internal)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn effective_rights_ignore_gains_but_detect_denied_actions_and_removed_roles() {
        let make = |rules: Value, roles: Vec<String>| {
            let policy: super::super::wire::SignedPolicy = serde_json::from_value(
                json!({"tenant":"test","version":"1","signature":"unused","rules":rules}),
            )
            .unwrap();
            Snapshot {
                subject: "user:1".into(),
                generation: "1".into(),
                version: 1,
                fingerprint: String::new(),
                capabilities: capabilities(&policy, "user:1", &[]),
                roles,
                allowed: HashSet::new(),
                signing_key: vec![],
            }
        };
        let read = json!({"subject":"user:1","scope":"catalog:a","facet":"master-data","actions":["read","update"],"effect":"allow"});
        let added = json!({"subject":"user:1","scope":"catalog:b","facet":"master-data","actions":["read"],"effect":"allow"});
        let denied = json!({"subject":"user:1","scope":"catalog:a","facet":"master-data","actions":["update"],"effect":"deny"});
        let before = make(json!([read.clone()]), vec![":llm".into()]);
        let gain = make(
            json!([read.clone(), added]),
            vec![":llm".into(), "view:products".into()],
        );
        assert!(!before.loses_to(&gain));
        assert!(gain.loses_to(&before));
        let restricted = make(json!([read.clone(), denied]), vec![":llm".into()]);
        assert!(before.loses_to(&restricted));
        assert_eq!(
            restricted.capabilities[&scope_key("catalog:a", "master-data")],
            1
        );
        assert!(before.loses_to(&make(json!([read]), vec![])));
    }
    #[test]
    fn notification_decoder_retains_only_routing_and_commit_metadata() {
        let data = json!({"kind":"object","domain":"assistant:user:1:master-data","seq":"9223372036854775807","id":"must-not-be-forwarded","content":"not-an-event-field"});
        assert!(
            matches!(parse(&data.to_string()), Some(Event::Objects(domain, i64::MAX)) if domain=="assistant:user:1:master-data")
        );
        assert!(parse("not json").is_none());
        assert!(parse(r#"{"kind":"object","domain":"catalog:products","seq":"-1"}"#).is_none());
        assert!(parse(&"x".repeat(8001)).is_none());
        assert!(parse(r#"{"kind":"object","id":"missing-domain"}"#).is_none());
        assert!(matches!(
            parse(r#"{"kind":"policy","version":"3"}"#),
            Some(Event::Access)
        ));
    }
}
