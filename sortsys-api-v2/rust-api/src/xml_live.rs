//! Authenticated shared field text, document notifications and presence. Native
//! XML editing remains client-side; durable writes use versioned file storage.

use std::{collections::HashMap, sync::Arc, time::Duration};

use axum::{
    Router,
    extract::{
        State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::{HeaderMap, HeaderValue},
    response::Response,
    routing::get,
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::{Mutex, broadcast};

use crate::{
    AppState,
    auth::AuthResult,
    error::{ErrorCode, RpcError, RpcResult},
    ids::Id,
    xml_documents,
};

mod cluster;

pub const WS_PATH: &str = "/documents/xml/live";
type Room = (String, String, i64, i64);

#[derive(Clone)]
struct Event {
    room: Room,
    version: Option<i64>,
    update: Option<Arc<Vec<u8>>>,
    resync: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Participant {
    id: String,
    name: String,
    color: String,
    field: Option<String>,
    start: Option<u32>,
    end: Option<u32>,
    anchor: Option<serde_json::Value>,
    head: Option<serde_json::Value>,
    direction: Option<String>,
}

pub struct Hub {
    events: broadcast::Sender<Event>,
    peers: Mutex<HashMap<Room, HashMap<String, Participant>>>,
    buses: Mutex<HashMap<String, std::sync::Weak<cluster::Bus>>>,
}
impl Default for Hub {
    fn default() -> Self {
        Self {
            events: broadcast::channel(128).0,
            peers: Mutex::new(HashMap::new()),
            buses: Mutex::new(HashMap::new()),
        }
    }
}
impl Hub {
    async fn presence(&self, room: &Room) -> serde_json::Value {
        let peers = self.peers.lock().await;
        let mut participants: Vec<_> = peers
            .get(room)
            .into_iter()
            .flat_map(|room| room.values().cloned())
            .collect();
        participants.sort_by(|a, b| a.id.cmp(&b.id));
        json!({"type": "presence", "participants": participants})
    }
    fn notify_presence(&self, room: &Room) {
        let _ = self.events.send(Event {
            room: room.clone(),
            version: None,
            update: None,
            resync: false,
        });
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Ticket {
    scope: String,
    purpose: String,
    tenant: String,
    session: String,
    project: i64,
    file: i64,
    exp: usize,
}

pub fn ticket(state: &AppState, auth: &AuthResult, project: Id, file: Id) -> RpcResult<String> {
    state.auth.issue_challenge_token(&Ticket {
        scope: "project".into(),
        purpose: "xml-live".into(),
        tenant: auth.tenant.clone(),
        session: auth.session.id.clone(),
        project: project.0,
        file: file.0,
        exp: (Utc::now().timestamp() + 90) as usize,
    })
}

pub fn commercial_ticket(
    state: &AppState,
    auth: &AuthResult,
    case_id: Id,
    file: Id,
) -> RpcResult<String> {
    state.auth.issue_challenge_token(&Ticket {
        scope: "commercial".into(),
        purpose: "xml-live".into(),
        tenant: auth.tenant.clone(),
        session: auth.session.id.clone(),
        project: case_id.0,
        file: file.0,
        exp: (Utc::now().timestamp() + 90) as usize,
    })
}
async fn current_version(
    state: &AppState,
    headers: &HeaderMap,
    scope: &str,
    owner: Id,
    file: Id,
) -> RpcResult<(AuthResult, i64, bool)> {
    if scope == "commercial" {
        crate::procedures::commercial_documents::live_version(state, headers, owner, file).await
    } else if scope == "project" {
        xml_documents::live_version(state, headers, owner, file).await
    } else {
        Err(invalid("Invalid document scope"))
    }
}
pub fn router(state: Arc<AppState>) -> Router {
    Router::new().route(WS_PATH, get(upgrade)).with_state(state)
}
async fn upgrade(State(state): State<Arc<AppState>>, socket: WebSocketUpgrade) -> Response {
    socket
        .max_message_size(32 * 1024 * 1024)
        .on_upgrade(move |socket| async move {
            let _ = serve(socket, state).await;
        })
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Hello {
    ticket: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    field: Option<String>,
    #[serde(default)]
    start: Option<u32>,
    #[serde(default)]
    end: Option<u32>,
    #[serde(default)]
    anchor: Option<serde_json::Value>,
    #[serde(default)]
    head: Option<serde_json::Value>,
    #[serde(default)]
    direction: Option<String>,
}

async fn send(socket: &mut WebSocket, value: serde_json::Value) -> Result<(), axum::Error> {
    socket.send(Message::Text(value.to_string().into())).await
}

async fn case_snapshot(
    state: &AppState,
    headers: &HeaderMap,
    tenant: &str,
    owner: Id,
    stamp: &mut String,
) -> RpcResult<Option<serde_json::Value>> {
    let pool = state.tenants.tenant_pool(tenant).await.map_err(invalid)?;
    let current: String = sqlx::query_scalar("SELECT md5(row_to_json(c)::text || COALESCE((SELECT string_agg(d.id::text || ':' || d.version::text || ':' || d.read_only::text, ',' ORDER BY d.id) FROM commercial_documents d WHERE d.case_id=c.id),'') || COALESCE((SELECT MAX(e.id)::text FROM commercial_case_events e WHERE e.case_id=c.id),'')) FROM commercial_cases c WHERE c.id=$1")
        .bind(owner).fetch_one(&pool).await.map_err(invalid)?;
    if current == *stamp {
        return Ok(None);
    }
    let detail = crate::procedures::commercial::get_case(
        state,
        &crate::rpc::RequestContext {
            headers: headers.clone(),
        },
        owner,
    )
    .await?;
    let mut detail = serde_json::to_value(detail).map_err(invalid)?;
    // JSON numbers cannot represent every i64. Match the typed RPC's bigint
    // semantics without sending lossy numeric revisions over the socket.
    if let Some(documents) = detail["documents"].as_array_mut() {
        for document in documents {
            for name in ["version", "sourceVersion", "sourceCurrentVersion"] {
                if let Some(value) = document[name].as_i64() {
                    document[name] = json!(value.to_string());
                }
            }
        }
    }
    *stamp = current;
    Ok(Some(json!({ "type":"case", "detail": detail })))
}

async fn serve(mut socket: WebSocket, state: Arc<AppState>) -> RpcResult<()> {
    let Some(Ok(Message::Text(raw))) = tokio::time::timeout(Duration::from_secs(5), socket.recv())
        .await
        .ok()
        .flatten()
    else {
        return Ok(());
    };
    let hello: Hello = serde_json::from_str(&raw).map_err(invalid)?;
    let claims: Ticket = state.auth.verify_challenge_token(&hello.ticket)?;
    if claims.purpose != "xml-live" {
        return Err(invalid("Invalid document ticket"));
    }
    let token = state
        .auth
        .issue_user_token(&claims.tenant, &claims.session)
        .map_err(invalid)?;
    let mut headers = HeaderMap::new();
    headers.insert(
        "authorization",
        HeaderValue::from_str(&format!("Bearer {token}")).map_err(invalid)?,
    );
    let project = Id(claims.project);
    let file = Id(claims.file);
    let (auth, mut version, mut editable) =
        current_version(&state, &headers, &claims.scope, project, file).await?;
    let room = (auth.tenant.clone(), claims.scope.clone(), project.0, file.0);
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(invalid)?;
    let id = bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let colors = [
        "#2563eb", "#9333ea", "#047857", "#b45309", "#be185d", "#0e7490",
    ];
    let name = format!(
        "{} {}",
        auth.user.first_name,
        auth.user.last_name.as_deref().unwrap_or("")
    )
    .trim()
    .chars()
    .take(80)
    .collect::<String>();
    let mut peer = Participant {
        id: id.clone(),
        name,
        color: colors[usize::from(bytes[0]) % colors.len()].into(),
        field: None,
        start: None,
        end: None,
        anchor: None,
        head: None,
        direction: None,
    };
    let mut events = state.xml_live.events.subscribe();
    let mut case_stamp = String::new();
    let pool = state
        .tenants
        .tenant_pool(&auth.tenant)
        .await
        .map_err(invalid)?;
    let bus = state.xml_live.bus(&auth.tenant, pool).await?;
    let epoch = bus.join(&room, peer.clone()).await?;
    // Every exit path after registration runs through the cleanup below.
    let result = async {
        send(&mut socket, json!({"type":"ready", "clientId":id, "version":version.to_string(), "collaboration":true, "epoch":epoch.to_string()})).await?;
        send(&mut socket, json!({"type":"sync", "data": STANDARD.encode(bus.state(&room).await.map_err(axum::Error::new)?)})).await?;
        send(&mut socket, state.xml_live.presence(&room).await).await?;
        if claims.scope == "commercial"
            && let Some(value) = case_snapshot(&state, &headers, &auth.tenant, project, &mut case_stamp).await.map_err(axum::Error::new)? {
            send(&mut socket, value).await?;
        }
        let mut check = tokio::time::interval(Duration::from_secs(30));
        check.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut last_pong = std::time::Instant::now();
        let mut cursors = tokio::time::interval(Duration::from_millis(100));
        cursors.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut pending_cursor = false;
        loop {
            tokio::select! {
                message = socket.recv() => {
                    match message {
                        Some(Ok(Message::Text(raw))) => {
                            let Ok(message) = serde_json::from_str::<serde_json::Value>(&raw) else { break; };
                            if let Some(kind) = message["type"].as_str() {
                                if !editable { break; }
                                match kind {
                                    "initialize" => {
                                        let (Some(key), Some(value)) = (message["key"].as_str(), message["value"].as_str()) else { break; };
                                        if key.len() > 200 || key.starts_with("__") || value.len() > 20 * 1024 * 1024 { break; }
                                        if bus.initialize(&room, &id, epoch, key, value).await.is_err() { break; }
                                    }
                                    "update" => {
                                        let Some(data) = message["data"].as_str() else { break; };
                                        let Ok(update) = STANDARD.decode(data) else { break; };
                                        if bus.append(&room, &id, epoch, &update, None).await.is_err() { break; }
                                    }
                                    _ => break,
                                }
                                continue;
                            }
                            let Ok(cursor) = serde_json::from_str::<Cursor>(&raw) else { break; };
                            if raw.len() > 4096 || cursor.field.as_ref().is_some_and(|field| field.len() > 200)
                                || cursor.start.is_some_and(|value| value > 20_000_000) || cursor.end.is_some_and(|value| value > 20_000_000)
                                || cursor.direction.as_deref().is_some_and(|value| !["forward", "backward", "none"].contains(&value)) { break; }
                            if peer.field != cursor.field || peer.start != cursor.start || peer.end != cursor.end
                                || peer.anchor != cursor.anchor || peer.head != cursor.head || peer.direction != cursor.direction {
                                peer.field = cursor.field;
                                peer.start = cursor.start; peer.end = cursor.end;
                                peer.anchor = cursor.anchor; peer.head = cursor.head;
                                peer.direction = cursor.direction;
                                pending_cursor = true;
                            }
                        }
                        Some(Ok(Message::Ping(bytes))) => socket.send(Message::Pong(bytes)).await?,
                        Some(Ok(Message::Pong(_))) => { last_pong = std::time::Instant::now(); },
                        _ => break,
                    }
                }
                event = events.recv() => {
                    if matches!(&event, Err(broadcast::error::RecvError::Lagged(_)))
                        || matches!(&event, Ok(event) if event.room == room && event.resync) {
                        if !bus.active(&room, &id, epoch).await.map_err(axum::Error::new)? { break; }
                        send(&mut socket, json!({"type":"sync", "data": STANDARD.encode(bus.state(&room).await.map_err(axum::Error::new)?)})).await?;
                        bus.refresh_presence(&room).await.map_err(axum::Error::new)?;
                        let (_, next, can_edit) = current_version(&state, &headers, &claims.scope, project, file).await.map_err(axum::Error::new)?;
                        editable = can_edit;
                        if next != version { version = next; send(&mut socket,json!({"type":"changed","version":version.to_string()})).await?; }
                        if claims.scope == "commercial"
                            && let Some(value) = case_snapshot(&state, &headers, &auth.tenant, project, &mut case_stamp).await.map_err(axum::Error::new)? { send(&mut socket,value).await?; }
                        send(&mut socket, state.xml_live.presence(&room).await).await?;
                        continue;
                    }
                    if let Ok(event) = &event
                        && claims.scope == "commercial" && event.room.0 == room.0 && event.room.1 == room.1 && event.room.2 == room.2
                        && (event.version.is_some() || event.room.3 == 0)
                        && let Some(value) = case_snapshot(&state, &headers, &auth.tenant, project, &mut case_stamp).await.map_err(axum::Error::new)? {
                        send(&mut socket, value).await?;
                    }
                    match event {
                        Ok(event) if event.room == room => {
                            if let Some(update) = event.update {
                                send(&mut socket, json!({"type":"sync", "data": STANDARD.encode(&*update)})).await?;
                            } else if let Some(next) = event.version {
                                let (_, _, can_edit) = current_version(&state, &headers, &claims.scope, project, file).await.map_err(axum::Error::new)?;
                                editable = can_edit;
                                if next > version {
                                    version = next;
                                    send(&mut socket, json!({"type":"changed", "version":version.to_string()})).await?;
                                }
                            } else { send(&mut socket, state.xml_live.presence(&room).await).await?; }
                        }
                        Err(broadcast::error::RecvError::Closed) => break,
                        _ => {},
                    }
                }
                _ = cursors.tick(), if pending_cursor => {
                    bus.cursor(&room, &id, &peer).await.map_err(axum::Error::new)?;
                    pending_cursor = false;
                }
                _ = check.tick() => {
                    if last_pong.elapsed() > Duration::from_secs(65) || !bus.active(&room, &id, epoch).await.map_err(axum::Error::new)? { break; }
                    // Periodic authorization/lease verification is a fallback.
                    // Live edits and business writes arrive through LISTEN.
                    let Ok((_, next, can_edit)) = current_version(&state, &headers, &claims.scope, project, file).await else { break; };
                    editable = can_edit;
                    if next != version {
                        version = next;
                        send(&mut socket, json!({"type":"changed", "version":version.to_string()})).await?;
                    }
                    socket.send(Message::Ping(Vec::new().into())).await?;
                }
            }
        }
        Ok::<_, axum::Error>(())
    }.await;
    bus.leave(&room, &id).await;
    result.map_err(invalid)
}
fn invalid(error: impl std::fmt::Display) -> RpcError {
    RpcError::new(ErrorCode::BadRequest, error.to_string()).with_http_code(400)
}
