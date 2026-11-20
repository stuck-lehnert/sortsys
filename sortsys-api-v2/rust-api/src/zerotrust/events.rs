//! Public change hints only. One shared-store subscription per active tenant
//! and API process fans out committed hints; document values never enter it.
use super::{
    access::{metadata_context_for_domains, metadata_security_for_domains},
    crypto::{encode, frame, random_id, verify},
    document_messages::Room,
    wire::{Action, Effect},
};
use crate::{
    auth::AuthResult,
    error::{ErrorCode, RpcError, RpcResult},
    error::{forbidden, internal},
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
    Objects(String, i64, bool),
    ObjectRecipient(String, String),
    Domain(String),
    ProjectClosure(String),
    Access,
    ToolReturn,
    Account(String),
    Resync,
    DocumentMessage(Room),
}

#[derive(Default)]
struct PendingChanges {
    all: bool,
    control: bool,
    refresh: bool,
    visible: bool,
    tool_returns: bool,
    domains: HashMap<String, Option<i64>>,
    recipient_domains: HashSet<String>,
    closed_projects: Vec<String>,
    document_messages: HashSet<Room>,
}
impl PendingChanges {
    fn include(&mut self, event: Event, subject: &str) {
        match event {
            Event::DocumentMessage(room) => {
                self.document_messages.insert(room);
            }
            Event::Access => {
                self.refresh = true;
            }
            Event::ProjectClosure(project) => {
                self.refresh = true;
                self.closed_projects.push(project);
            }
            Event::ToolReturn => {
                self.tool_returns = true;
            }
            Event::Resync => {
                self.visible = true;
                self.all = true;
                self.refresh = true;
            }
            Event::Domain(domain) => {
                self.visible = true;
                self.refresh = true;
                self.domains.insert(domain, None);
            }
            Event::Account(user) if user == subject => {
                self.visible = true;
                self.all = true;
                self.control = true;
                self.refresh = true;
            }
            Event::ObjectRecipient(user, domain) if user == subject => {
                self.visible = true;
                self.refresh = true;
                self.domains.insert(domain.clone(), None);
                self.recipient_domains.insert(domain);
            }
            Event::Objects(domain, sequence, staged) => {
                self.visible |= !staged;
                self.domains
                    .entry(domain)
                    .and_modify(|head| {
                        if let Some(current) = head {
                            *current = (*current).max(sequence);
                        }
                    })
                    .or_insert(Some(sequence));
            }
            _ => {}
        }
    }
}
struct Channel {
    outgoing: broadcast::Sender<Event>,
    _stop: watch::Sender<()>,
}
struct Subscription {
    _channel: Arc<Channel>,
    incoming: broadcast::Receiver<Event>,
}

pub(crate) struct AccessSubscription {
    subscription: Subscription,
    subject: String,
    domains: HashSet<String>,
}
impl AccessSubscription {
    /// A lagged stream requires a fresh authorization check as well. Document
    /// and object hints do not wake unrelated live model requests.
    pub(crate) async fn changed(&mut self) -> RpcResult<()> {
        loop {
            match self.subscription.incoming.recv().await {
                Ok(Event::Access | Event::Resync) => return Ok(()),
                Ok(Event::Account(subject)) if subject == self.subject => return Ok(()),
                Ok(Event::Domain(domain)) if self.domains.contains(&domain) => return Ok(()),
                Err(broadcast::error::RecvError::Lagged(_)) => return Ok(()),
                Err(broadcast::error::RecvError::Closed) => return Err(unavailable()),
                _ => {}
            }
        }
    }
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
    pub(crate) async fn watch_access(
        &self,
        tenant: &str,
        source: crate::control::Repository,
        subject: String,
        domains: Vec<String>,
    ) -> RpcResult<AccessSubscription> {
        let subscription = self.subscribe(tenant, source).await?;
        Ok(AccessSubscription {
            subscription,
            subject,
            domains: domains.into_iter().collect(),
        })
    }

    async fn subscribe(
        &self,
        tenant: &str,
        source: crate::control::Repository,
    ) -> RpcResult<Subscription> {
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
        // Establish the durable cursor before the caller takes its access
        // baseline. Every later commit is replayable, including during admission.
        let mut cursor = source.changes(None, 0).await?.head;
        let (outgoing, incoming) = broadcast::channel(64);
        let (stop, mut stopped) = watch::channel(());
        let channel = Arc::new(Channel {
            outgoing: outgoing.clone(),
            _stop: stop,
        });
        tenants.insert(tenant.to_owned(), Arc::downgrade(&channel));
        tokio::spawn(async move {
            let _slot = slot;
            let mut interrupted = false;
            loop {
                let page = tokio::select! {
                    _ = stopped.changed() => break,
                    result = source.changes(Some(cursor.clone()), 25_000) => result,
                };
                let page = match page {
                    Ok(page) => page,
                    Err(_) => {
                        interrupted = true;
                        tokio::select! {
                            _ = stopped.changed() => break,
                            _ = tokio::time::sleep(Duration::from_secs(1)) => continue,
                        }
                    }
                };
                let (Ok(durable_head), Ok(observed_head)) =
                    (page.head.parse::<u64>(), cursor.parse::<u64>())
                else {
                    let _ = outgoing.send(Event::Resync);
                    break;
                };
                if durable_head < observed_head {
                    cursor = page.head;
                    let _ = outgoing.send(Event::Resync);
                    interrupted = false;
                    continue;
                }
                if page.events.is_empty() && page.head != cursor {
                    // A replaced/pruned journal requires a full resync. Never
                    // spin on a durable head that has no replayable entries.
                    cursor = page.head;
                    let _ = outgoing.send(Event::Resync);
                    interrupted = false;
                    continue;
                }
                for event in page.events {
                    cursor = event.revision;
                    // Session/credential epochs are public control records.
                    // Their changes must revoke sockets even without a UI hint.
                    if event.changed.iter().any(|record| {
                        matches!(
                            record.collection.as_str(),
                            "accounts" | "sessions" | "tenant-status" | "crypto-root"
                        ) || *record == crate::control::content::head_key()
                    }) {
                        let _ = outgoing.send(Event::Access);
                    }
                    for hint in event.hints {
                        if let Some(event) = parse_hint(&hint.channel, &hint.value) {
                            let _ = outgoing.send(event);
                        }
                    }
                }
                if interrupted {
                    interrupted = false;
                    let _ = outgoing.send(Event::Resync);
                }
            }
        });
        Ok(Subscription {
            _channel: channel,
            incoming,
        })
    }
}
fn parse_hint(channel: &str, input: &str) -> Option<Event> {
    if input.len() > 8000 {
        return None;
    }
    let data: Value = serde_json::from_str(input).ok()?;
    match channel {
        "access" => Some(Event::Access),
        "project-closure" => {
            let project = data.get("project")?.as_str()?;
            (super::objects::project_lifecycle::project_scope(project) == Some(project))
                .then(|| Event::ProjectClosure(project.to_owned()))
        }
        "tool-return" if data.as_object()?.is_empty() => Some(Event::ToolReturn),
        "account" => Some(Event::Account(data.get("subject")?.as_str()?.to_owned())),
        "domain" => {
            let domain = data.get("domain")?.as_str()?;
            super::crypto::identifier(domain).ok()?;
            Some(Event::Domain(domain.to_owned()))
        }
        "object" => {
            let domain = data.get("domain")?.as_str()?;
            super::crypto::identifier(domain).ok()?;
            let sequence = super::crypto::revision(data.get("sequence")?.as_str()?).ok()?;
            Some(Event::Objects(
                domain.to_owned(),
                sequence,
                staging_hint(&data)?,
            ))
        }
        "object-recipient" => recipient_hint(&data),
        "document-message" => {
            let mut data = data;
            data.as_object_mut()?
                .insert("kind".into(), Value::String(channel.into()));
            parse(&data.to_string())
        }
        _ => None,
    }
}
fn parse(input: &str) -> Option<Event> {
    if input.len() > 8000 {
        return None;
    }
    let data: Value = serde_json::from_str(input).ok()?;
    match data.get("kind")?.as_str()? {
        "document-message" => {
            let scope = data.get("scope")?.as_str()?;
            let document = data.get("document")?.as_str()?;
            let facet = data.get("facet")?.as_str()?;
            let channel = data.get("channel")?.as_str()?;
            let room = Room {
                scope: scope.into(),
                document: document.into(),
                facet: channel.into(),
            };
            if room.outer().ok()?.name() != facet {
                return None;
            }
            Some(Event::DocumentMessage(room))
        }
        "object" => {
            let domain = data.get("domain")?.as_str()?;
            super::crypto::identifier(domain).ok()?;
            let sequence = data.get("seq")?.as_str()?.parse::<i64>().ok()?;
            let staged = staging_hint(&data)?;
            (sequence > 0).then(|| Event::Objects(domain.to_owned(), sequence, staged))
        }
        "domain" => {
            let domain = data.get("domain")?.as_str()?;
            super::crypto::identifier(domain).ok()?;
            Some(Event::Domain(domain.to_owned()))
        }
        "policy" | "recovery" | "activation" => Some(Event::Access),
        "account" => Some(Event::Account(data.get("user")?.as_str()?.to_owned())),
        "object-recipient" => recipient_hint(&data),
        _ => None,
    }
}

fn recipient_hint(data: &Value) -> Option<Event> {
    let subject = data.get("subject")?.as_str()?;
    let domain = data.get("domain")?.as_str()?;
    super::crypto::identifier(subject).ok()?;
    super::crypto::identifier(domain).ok()?;
    Some(Event::ObjectRecipient(
        subject.to_owned(),
        domain.to_owned(),
    ))
}

fn staging_hint(data: &Value) -> Option<bool> {
    match data.get("staged") {
        None => Some(false),
        Some(value) => value.as_bool(),
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
    content: Option<String>,
    fingerprint: String,
    capabilities: HashMap<[u8; 32], u8>,
    roles: Vec<String>,
    allowed: HashSet<String>,
    signing_key: Vec<u8>,
}

pub(crate) fn register_metadata(
    builder: ProcedureRegistryBuilder,
    service: Arc<crate::auth::AuthService>,
) -> ProcedureRegistryBuilder {
    builder.mutation(
        "zerotrust.events.open",
        move |ctx: RequestContext, _: ()| {
            let service = Arc::clone(&service);
            async move {
                let context = metadata_context_for_domains(&service, &ctx, Some(&[])).await?;
                context.transaction.validate().await?;
                let auth = context.auth;
                let subject = context.security.subject;
                let generation = context.security.root.generation.to_string();
                let ticket = Ticket {
                    purpose: "encrypted-events-v1".into(),
                    tenant: auth.tenant,
                    session: auth.session.id,
                    user: auth.user.id,
                    subject: subject.clone(),
                    generation: generation.clone(),
                    exp: (chrono::Utc::now().timestamp() + 60) as u64,
                };
                Ok(Open {
                    ticket: service.issue_challenge_token(&ticket)?,
                    subject,
                    generation,
                })
            }
        },
    )
}
pub(super) fn register_contract(builder: ProcedureRegistryBuilder) -> ProcedureRegistryBuilder {
    builder.mutation_stub::<(), Open>("zerotrust.events.open")
}

#[derive(Clone)]
struct EventService {
    auth: Arc<crate::auth::AuthService>,
    encrypted_events: Arc<Hub>,
}
pub(crate) fn router_metadata(auth: Arc<crate::auth::AuthService>, hub: Arc<Hub>) -> Router {
    let service = Arc::new(EventService {
        auth,
        encrypted_events: hub,
    });
    Router::new()
        .route(WS_PATH, get(upgrade))
        .with_state(service)
}
async fn upgrade(State(state): State<Arc<EventService>>, ws: WebSocketUpgrade) -> Response {
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
async fn authenticate(state: &EventService, ticket: &Ticket) -> RpcResult<AuthResult> {
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

async fn verify_admission(
    state: &EventService,
    ticket: &Ticket,
    admission: &Admission,
    nonce: &str,
) -> RpcResult<Vec<u8>> {
    let auth = authenticate(state, ticket).await?;
    let repository = state.auth.records()?.tenant(&auth.tenant)?;
    let mut transaction = repository.transaction()?;
    let identity = metadata_security_for_domains(&mut transaction, &auth, Some(&[])).await?;
    if identity.subject != ticket.subject
        || identity.root.generation.to_string() != ticket.generation
    {
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
                nonce,
            ],
        ),
    )?;
    transaction.validate().await?;
    Ok(identity.signing_key)
}

fn scope_key(scope: &str, facet: &str) -> [u8; 32] {
    Sha256::digest(frame("sortsys/event-scope/v1", &[scope, facet])).into()
}
fn capabilities(
    policy: &super::wire::SignedPolicy,
    subject: &str,
    inherited: &[super::wire::Rule],
) -> HashMap<[u8; 32], u8> {
    if policy
        .suspended
        .as_ref()
        .is_some_and(|members| members.iter().any(|member| member == subject))
    {
        return HashMap::new();
    }
    let mut allowed = HashMap::new();
    let mut denied = HashMap::new();
    for rule in policy.rules.iter().chain(inherited) {
        if rule.subject != subject {
            continue;
        }
        let mask = rule
            .actions
            .iter()
            .fold(0, |mask, action| mask | action.bit());
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
    fn check_identity(&self, ticket: &Ticket, signing_key: &[u8]) -> RpcResult<()> {
        if self.subject != ticket.subject
            || self.generation != ticket.generation
            || self.signing_key != signing_key
        {
            return Err(forbidden());
        }
        Ok(())
    }

    fn same_access(&self, next: &Self) -> bool {
        self.subject == next.subject
            && self.generation == next.generation
            && self.version == next.version
            && self.content == next.content
            && self.capabilities == next.capabilities
            && self.roles == next.roles
            && self.allowed == next.allowed
            && self.signing_key == next.signing_key
    }

    fn loses_to(&self, next: &Self) -> bool {
        self.capabilities
            .iter()
            .any(|(scope, mask)| next.capabilities.get(scope).copied().unwrap_or(0) & mask != *mask)
            || self.roles.iter().any(|role| !next.roles.contains(role))
            || !self.allowed.is_subset(&next.allowed)
    }

    fn resets_for(&self, next: &Self) -> bool {
        self.content != next.content || self.loses_to(next)
    }
}
async fn snapshot(service: &crate::auth::AuthService, auth: &AuthResult) -> RpcResult<Snapshot> {
    Ok(snapshot_after_changes(service, auth, &[]).await?.0)
}

async fn snapshot_after_changes(
    service: &crate::auth::AuthService,
    auth: &AuthResult,
    closed_projects: &[String],
) -> RpcResult<(Snapshot, bool)> {
    let repository = service.records()?.tenant(&auth.tenant)?;
    let mut transaction = repository.transaction()?;
    let guard = metadata_security_for_domains(&mut transaction, auth, None).await?;
    let mut assignment_closed = false;
    for project in closed_projects {
        if super::object_shares::has_project_assignment(&mut transaction, &guard, project).await? {
            assignment_closed = true;
            break;
        }
    }
    // Content restores and key changes can happen while a socket is closed
    // even when the member's effective rights have not changed.
    let content = transaction
        .content_epoch()
        .await?
        .map(|head| head.fingerprint())
        .transpose()?;
    let key_version = super::objects::metadata_domain_access_version(&mut transaction).await?;
    // Hash scope/facet pairs and combine action bits once. The small retained
    // masks distinguish revocation from an added right without rescanning rules.
    let capabilities = capabilities(&guard.policy, &guard.subject, &guard.inherited);
    let allowed: HashSet<_> = super::objects::metadata_catalog(&mut transaction, |area| {
        let actions = capabilities
            .get(&scope_key(&area.scope, area.facet.name()))
            .copied()
            .unwrap_or(0);
        actions & Action::Read.bit() != 0
    })
    .await?
    .into_iter()
    .map(|area| area.id)
    .collect();
    let mut visible_domains: Vec<_> = allowed.iter().collect();
    visible_domains.sort();
    let mut roles = auth.roles.clone();
    roles.sort();
    let mut rights = capabilities
        .iter()
        .map(|(scope, mask)| (encode(scope), mask))
        .collect::<Vec<_>>();
    rights.sort();
    let fingerprint = encode(&Sha256::digest(
        serde_json::to_vec(&(
            &auth.tenant,
            &guard.subject,
            guard.root.generation,
            guard.root.policy_version,
            &guard.policy.signature,
            &guard.signing_key,
            &key_version,
            &content,
            rights,
            &roles,
            visible_domains,
        ))
        .map_err(internal)?,
    ));
    transaction.validate().await?;
    Ok((
        Snapshot {
            subject: guard.subject,
            generation: guard.root.generation.to_string(),
            version: guard.root.policy_version,
            content,
            fingerprint,
            capabilities,
            roles,
            allowed,
            signing_key: guard.signing_key,
        },
        assignment_closed,
    ))
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
async fn serve(socket: &mut WebSocket, state: &Arc<EventService>) -> RpcResult<()> {
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
    let signing_key = verify_admission(state, &ticket, &admission, &nonce).await?;
    let repository = state.auth.records()?.tenant(&ticket.tenant)?;
    let mut subscription = state
        .encrypted_events
        .subscribe(&ticket.tenant, repository)
        .await?;
    // The durable change cursor is established before this baseline. Commits
    // during admission are either included here or remain queued.
    let mut current = snapshot(&state.auth, &authenticate(state, &ticket).await?).await?;
    current.check_identity(&ticket, &signing_key)?;
    send(
        socket,
        json!({"type":"ready","fingerprint":current.fingerprint}),
    )
    .await?;
    let mut heartbeat = tokio::time::interval(Duration::from_secs(30));
    heartbeat.tick().await;
    loop {
        let event = tokio::select! {
            input = socket.recv() => {
                match input {
                    Some(Ok(Message::Pong(_))) => continue,
                    Some(Ok(Message::Ping(value))) => {
                        socket.send(Message::Pong(value)).await.map_err(|_| unavailable())?;
                        continue;
                    }
                    _ => return Ok(()),
                }
            }
            _ = heartbeat.tick() => {
                let next = snapshot(&state.auth, &authenticate(state, &ticket).await?).await?;
                next.check_identity(&ticket, &signing_key)?;
                let changed = !current.same_access(&next);
                let reset = current.resets_for(&next);
                current = next;
                if changed {
                    send(socket, json!({
                        "type": "changed",
                        "reset": reset,
                        "all": true,
                        "control": true,
                        "domains": {},
                        "fingerprint": current.fingerprint,
                    })).await?;
                }
                socket.send(Message::Ping(Vec::new().into())).await.map_err(|_| unavailable())?;
                continue;
            }
            value = subscription.incoming.recv() => value,
        };
        tokio::time::sleep(Duration::from_millis(80)).await;
        let mut pending = PendingChanges::default();
        match event {
            Ok(event) => pending.include(event, &current.subject),
            Err(broadcast::error::RecvError::Lagged(_)) => {
                pending.include(Event::Resync, &current.subject)
            }
            Err(_) => return Err(unavailable()),
        }
        for _ in 0..64 {
            match subscription.incoming.try_recv() {
                Ok(event) => pending.include(event, &current.subject),
                Err(broadcast::error::TryRecvError::Lagged(_)) => {
                    pending.include(Event::Resync, &current.subject)
                }
                Err(broadcast::error::TryRecvError::Empty) => break,
                Err(_) => return Err(unavailable()),
            }
        }
        let PendingChanges {
            mut all,
            mut control,
            refresh,
            visible,
            tool_returns,
            mut domains,
            recipient_domains,
            closed_projects,
            document_messages,
        } = pending;
        let mut reset = false;
        if refresh {
            let (next, assignment_closed) = snapshot_after_changes(
                &state.auth,
                &authenticate(state, &ticket).await?,
                &closed_projects,
            )
            .await?;
            next.check_identity(&ticket, &signing_key)?;
            let changed = !current.same_access(&next) || assignment_closed;
            all |= changed;
            control |= changed;
            reset = current.resets_for(&next) || assignment_closed;
            current = next;
        }
        domains.retain(|domain, _| {
            current.allowed.contains(domain) || recipient_domains.contains(domain)
        });
        // Availability and project costs can be read independently of the
        // booking. Refresh those views without forwarding the booking ID.
        let tool_returns = tool_returns
            && current.allowed.iter().any(|domain| {
                domain.starts_with("tool:")
                    || domain.starts_with("tool-tracking:")
                    || domain.ends_with(":tool-usage:master-data")
            });
        // Replaying a gap can refresh data without invalidating the verified
        // access context. Actual losses still retire the affected session.
        let domains = domains
            .into_iter()
            .map(|(domain, sequence)| (domain, sequence.map(|n| n.to_string())))
            .collect::<HashMap<_, _>>();
        if all || reset || tool_returns || !domains.is_empty() {
            let mut message = json!({
                "type": "changed",
                "reset": reset,
                "all": all,
                "control": control,
                "domains": domains,
                "fingerprint": current.fingerprint,
                "staged": !visible && !control && !tool_returns,
            });
            if tool_returns {
                message["toolReturns"] = json!(true);
            }
            send(socket, message).await?;
        }
        for room in document_messages {
            let outer = room.outer()?;
            if current
                .allowed
                .contains(&format!("{}:{}", room.scope, outer.name()))
            {
                send(
                    socket,
                    json!({"type":"document-message","scope":room.scope,"document":room.document,"facet":room.facet}),
                )
                .await?;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn journal_resync_and_account_changes_have_distinct_invalidation() {
        let mut changes = PendingChanges::default();
        changes.include(Event::Resync, "user:1");
        assert!(changes.all && changes.visible && changes.refresh);
        assert!(!changes.control);

        changes.include(Event::Account("user:2".into()), "user:1");
        assert!(!changes.control);

        changes.include(Event::Account("user:1".into()), "user:1");
        assert!(changes.control);
    }

    #[test]
    fn recipient_hints_only_refresh_the_intended_members_object_view() {
        let domain = "project:2:planning:master-data";
        let hint = serde_json::json!({"subject": "user:1", "domain": domain});
        let event = parse_hint("object-recipient", &hint.to_string()).unwrap();
        let mut other = PendingChanges::default();
        other.include(event.clone(), "user:2");
        assert!(!other.visible);
        assert!(!other.refresh);
        assert!(other.domains.is_empty());
        assert!(other.recipient_domains.is_empty());
        let mut own = PendingChanges::default();
        own.include(event, "user:1");
        assert!(own.visible);
        assert!(own.refresh);
        assert!(!own.all);
        assert_eq!(own.domains[domain], None);
        assert!(own.recipient_domains.contains(domain));
        assert!(parse_hint("object-recipient", r#"{"subject":"user:1"}"#).is_none());
    }
    #[test]
    fn domain_key_hints_recheck_authorization_without_invalidating_unrelated_views() {
        let mut changes = PendingChanges::default();
        changes.include(
            Event::Domain("tool-tracking:2:master-data".into()),
            "user:1",
        );
        assert!(changes.refresh);
        assert!(changes.visible);
        assert!(!changes.all);
        assert_eq!(changes.domains.len(), 1);
        assert_eq!(changes.domains["tool-tracking:2:master-data"], None);
    }
    #[test]
    fn staging_hints_never_hide_visible_changes_in_a_combined_batch() {
        let mut changes = PendingChanges::default();
        changes.include(
            Event::Objects("commercial:2:scope".into(), 2, true),
            "user:1",
        );
        assert!(!changes.visible);
        changes.include(Event::Access, "user:1");
        assert!(changes.refresh);
        assert!(!changes.visible);
        changes.include(
            Event::Objects("commercial:2:scope".into(), 3, false),
            "user:1",
        );
        changes.include(
            Event::Objects("commercial:2:scope".into(), 4, true),
            "user:1",
        );
        assert!(changes.visible);
        assert_eq!(changes.domains["commercial:2:scope"], Some(4));
        let mut access = PendingChanges::default();
        access.include(
            Event::Objects("commercial:2:scope".into(), 1, true),
            "user:1",
        );
        access.include(Event::Domain("commercial:2:scope".into()), "user:1");
        assert!(access.visible);
        assert!(access.refresh);
        assert_eq!(access.domains["commercial:2:scope"], None);
        assert!(matches!(
            parse_hint(
                "object",
                r#"{"domain":"commercial:2:scope","sequence":"2","staged":true}"#
            ),
            Some(Event::Objects(_, 2, true))
        ));
        assert!(
            parse_hint(
                "object",
                r#"{"domain":"commercial:2:scope","sequence":"2","staged":"yes"}"#
            )
            .is_none()
        );
    }
    #[test]
    fn unchanged_session_checks_preserve_context_but_access_changes_do_not() {
        let baseline = || Snapshot {
            subject: "user:1".into(),
            generation: "1".into(),
            version: 1,
            content: None,
            fingerprint: "rights-and-roles".into(),
            capabilities: HashMap::new(),
            roles: vec!["admin".into()],
            allowed: HashSet::from(["catalog:products:master-data".into()]),
            signing_key: vec![1; 32],
        };
        let before = baseline();
        assert!(before.same_access(&baseline()));
        let mut restored = baseline();
        restored.content = Some("content-head".into());
        assert!(before.resets_for(&restored));
        assert!(!before.resets_for(&baseline()));
        let mut policy = baseline();
        policy.version += 1;
        assert!(!before.same_access(&policy));
        let mut authority = baseline();
        authority.generation = "2".into();
        assert!(!before.same_access(&authority));
        let mut rights = baseline();
        rights.capabilities.insert([1; 32], 1);
        assert!(!before.same_access(&rights));
        let mut domains = baseline();
        domains.allowed.clear();
        assert!(!before.same_access(&domains));
        let mut identity = baseline();
        identity.signing_key = vec![2; 32];
        assert!(!before.same_access(&identity));
        let mut subject = baseline();
        subject.subject = "user:2".into();
        assert!(!before.same_access(&subject));
    }
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
                content: None,
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
            matches!(parse(&data.to_string()), Some(Event::Objects(domain, i64::MAX, false)) if domain=="assistant:user:1:master-data")
        );
        assert!(parse("not json").is_none());
        assert!(parse(r#"{"kind":"object","domain":"catalog:products","seq":"-1"}"#).is_none());
        assert!(parse(&"x".repeat(8001)).is_none());
        assert!(parse(r#"{"kind":"object","id":"missing-domain"}"#).is_none());
        assert!(matches!(
            parse(r#"{"kind":"policy","version":"3"}"#),
            Some(Event::Access)
        ));
        assert!(matches!(
            parse(r#"{"kind":"activation"}"#),
            Some(Event::Access)
        ));
    }

    #[test]
    fn document_notifications_bind_the_channel_to_its_required_outer_key() {
        let hint = json!({"kind":"document-message","scope":"commercial:2","document":"3","facet":"billing","channel":"billing"});
        assert!(
            matches!(parse(&hint.to_string()), Some(Event::DocumentMessage(room)) if room.facet == "billing")
        );
        let mut changed = hint.clone();
        changed["facet"] = "scope".into();
        assert!(parse(&changed.to_string()).is_none());
        changed["channel"] = "opaque".into();
        assert!(
            matches!(parse(&changed.to_string()), Some(Event::DocumentMessage(room)) if room.facet == "opaque")
        );
        changed["scope"] = "project:2".into();
        assert!(parse(&changed.to_string()).is_none());
    }
}
