use super::super::provider::{self, ChatTurn, DocumentScanInput, ScanOriginal, TokenUsage};
use super::*;
use axum::{
    extract::ws::{Message, WebSocket},
    http::{HeaderMap, HeaderValue},
};
use serde_json::json;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Admission {
    ticket: String,
    proof: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Turn {
    role: String,
    content: String,
}
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
enum Input {
    File {
        name: String,
        mime: String,
        size: usize,
    },
    Chunk {
        data: String,
    },
    EndFile,
    Chat {
        turns: Vec<Turn>,
        locale: Option<String>,
    },
    Import {
        text: String,
        #[serde(rename = "fileNames")]
        file_names: Vec<String>,
    },
    ToolResult {
        id: String,
        result: Option<Value>,
        error: Option<bool>,
    },
    Cancel,
}

struct Registration {
    hub: Arc<Hub>,
    run: String,
    session: Arc<Session>,
}
impl Drop for Registration {
    fn drop(&mut self) {
        if let Ok(mut sessions) = self.hub.sessions.lock() {
            sessions.remove(&self.run);
        }
        self.session.close();
    }
}

pub(super) async fn serve(mut socket: WebSocket, state: Arc<AppState>) -> RpcResult<()> {
    let mut stage = "admission";
    let result = serve_inner(&mut socket, &state, &mut stage).await;
    if let Err(error) = &result {
        tracing::debug!(stage, code = error.code.name(), "Live LLM request ended");
        // Provider messages can echo document contents. Send only a fixed code.
        let _ = send(
            &mut socket,
            json!({"type":"error","code":"LIVE_REQUEST_FAILED"}),
        )
        .await;
    }
    let _ = socket.send(Message::Close(None)).await;
    result
}

async fn serve_inner(
    socket: &mut WebSocket,
    state: &Arc<AppState>,
    stage: &mut &'static str,
) -> RpcResult<()> {
    let admission: Admission = tokio::time::timeout(Duration::from_secs(5), receive(socket))
        .await
        .map_err(|_| forbidden())??;
    let ticket: Ticket = state.auth.verify_challenge_token(&admission.ticket)?;
    if ticket.purpose != "llm-live-browser-v1" || ticket.exp <= now() {
        return Err(forbidden());
    }
    *stage = "identity";
    let auth = authenticate(state, &ticket).await?;
    authorize(state, &auth, ticket.kind).await?;
    *stage = "proof";
    crate::zerotrust::verify_live_identity(
        state,
        &auth,
        &ticket.generation,
        &admission.ticket,
        &admission.proof,
    )
    .await?;
    let _slot = Arc::clone(&state.live_llm.requests)
        .try_acquire_owned()
        .map_err(|_| busy())?;
    *stage = "admission_metadata";
    let admitted = sqlx::query("INSERT INTO __llm_live_admissions(nonce,tenant,session_id,expires_at) VALUES($1,$2,$3,to_timestamp($4)) ON CONFLICT DO NOTHING")
        .bind(&ticket.run).bind(&ticket.tenant).bind(ticket.session.parse::<i64>().map_err(|_| forbidden())?)
        .bind(ticket.exp as f64).execute(state.tenants.master()).await.map_err(|_| unavailable())?;
    if admitted.rows_affected() != 1 {
        return Err(forbidden());
    }
    sqlx::query("DELETE FROM __llm_live_admissions WHERE expires_at < NOW() - INTERVAL '1 minute'")
        .execute(state.tenants.master())
        .await
        .map_err(|_| unavailable())?;
    let owner = state.live_llm.owner(state, &ticket)?;
    let (outgoing, mut calls) = mpsc::channel(8);
    let session = Arc::new(Session {
        closed: std::sync::atomic::AtomicBool::new(false),
        ticket: ticket.clone(),
        outgoing,
        pending: Mutex::new(HashMap::new()),
    });
    state
        .live_llm
        .sessions
        .lock()
        .map_err(|_| unavailable())?
        .insert(ticket.run.clone(), Arc::clone(&session));
    let _registration = Registration {
        hub: Arc::clone(&state.live_llm),
        run: ticket.run.clone(),
        session: Arc::clone(&session),
    };
    send(socket, json!({"type":"ready"})).await?;
    let operation = async {
        *stage = "preparation";
        let request = prepare(socket, ticket.kind).await?;
        *stage = "provider_setup";
        let auth = authenticate(state, &ticket).await?;
        authorize(state, &auth, ticket.kind).await?;
        if crate::zerotrust::live_identity(state, &auth).await?.1 != ticket.generation {
            return Err(forbidden());
        }
        let configuration = match ticket.kind {
            LiveKind::Chat => super::super::load_configuration(state).await?,
            LiveKind::DocumentImport => super::super::load_scan_configuration(state).await?,
        }
        .ok_or_else(unavailable)?;
        let scope = ticket.scope()?;
        let token = state
            .auth
            .issue_mcp_token(&auth, scope)
            .map_err(|_| unavailable())?;
        let base_url = match &state.config.llm_mcp_url {
            Some(url) => url.to_string(),
            None if configuration.provider == "openrouter" => format!(
                "{}/internal/llm/mcp",
                state.live_llm.endpoint.get().ok_or_else(unavailable)?
            ),
            None => return Err(unavailable()),
        };
        let mut url = reqwest::Url::parse(&base_url).map_err(|_| unavailable())?;
        url.query_pairs_mut().append_pair("live", &owner);
        let provider = async {
            match request {
                Request::Chat(turns, locale) => {
                    let reply = provider::complete_live(
                        &configuration,
                        &turns,
                        locale.as_deref().unwrap_or(&auth.user.locale),
                        url.as_str(),
                        &token,
                        scope,
                    )
                    .await?;
                    Ok((reply.content, reply.usage))
                }
                Request::Import(input) => {
                    let reply = provider::parse_document_live(
                        &configuration,
                        input,
                        &auth.user.locale,
                        url.as_str(),
                        &token,
                    )
                    .await?;
                    Ok((reply.content, reply.usage))
                }
            }
        };
        *stage = "provider";
        tokio::pin!(provider);
        let result: RpcResult<(String, TokenUsage)> = loop {
            tokio::select! {
                result = &mut provider => break result,
                call = calls.recv() => {
                    let call = call.ok_or_else(unavailable)?;
                    send(socket, json!({"type":"tool","id":call.id,"name":call.name,"arguments":call.arguments})).await?;
                }
                incoming = receive::<Input>(socket) => match incoming? {
                    Input::ToolResult { id, result, error } => {
                        if id.len() > 128 { return Err(invalid()); }
                        let reply = if error == Some(true) { Err(forbidden()) } else {
                            let value = result.ok_or_else(invalid)?;
                            if serde_json::to_vec(&value).map_err(|_| invalid())?.len() > MAX_TOOL_REPLY { return Err(invalid()); }
                            Ok(value)
                        };
                        session.reply(&id, reply)?;
                    }
                    Input::Cancel => return Err(unavailable()),
                    _ => return Err(invalid()),
                }
            }
        };
        let (content, usage) = match result {
            Ok(result) => result,
            Err(error) => {
                tracing::debug!(code = error.code.name(), "Live model transport failed");
                record(
                    state,
                    &auth,
                    ticket.kind,
                    &configuration,
                    &TokenUsage::default(),
                    true,
                )
                .await?;
                return Err(unavailable());
            }
        };
        *stage = "usage";
        let current = authenticate(state, &ticket).await?;
        authorize(state, &current, ticket.kind).await?;
        if crate::zerotrust::live_identity(state, &current).await?.1 != ticket.generation {
            return Err(forbidden());
        }
        record(state, &auth, ticket.kind, &configuration, &usage, false).await?;
        send(socket, json!({"type":"complete","content":content,"usage":{
            "inputTokens":usage.input_tokens,"outputTokens":usage.output_tokens,"totalTokens":usage.total_tokens}})).await
    };
    tokio::time::timeout(Duration::from_secs(REQUEST_SECONDS), operation)
        .await
        .map_err(|_| unavailable())?
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
    if !ticket.matches(&auth, ticket.scope()?) {
        return Err(forbidden());
    }
    Ok(auth)
}

enum Request {
    Chat(Vec<ChatTurn>, Option<String>),
    Import(DocumentScanInput),
}
async fn prepare(socket: &mut WebSocket, kind: LiveKind) -> RpcResult<Request> {
    let mut originals = Vec::new();
    let mut partial: Option<(ScanOriginal, usize)> = None;
    let mut total = 0usize;
    loop {
        match receive::<Input>(socket).await? {
            Input::File { name, mime, size } if kind == LiveKind::DocumentImport => {
                if partial.is_some()
                    || originals.len() >= 20
                    || name.is_empty()
                    || name.len() > 512
                    || size == 0
                    || size > 20 * 1024 * 1024
                    || total.saturating_add(size) > 100 * 1024 * 1024
                    || !["application/pdf", "image/jpeg", "image/png", "image/webp"]
                        .contains(&mime.as_str())
                {
                    return Err(invalid());
                }
                total += size;
                partial = Some((
                    ScanOriginal {
                        bytes: Vec::with_capacity(size),
                        file_name: name,
                        mime_type: mime,
                    },
                    size,
                ));
                send(socket, json!({"type":"uploadAck"})).await?;
            }
            Input::Chunk { data } => {
                if data.len() > 88_000 {
                    return Err(invalid());
                }
                let (file, size) = partial.as_mut().ok_or_else(invalid)?;
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(data)
                    .map_err(|_| invalid())?;
                if bytes.is_empty() || file.bytes.len().saturating_add(bytes.len()) > *size {
                    return Err(invalid());
                }
                file.bytes.extend_from_slice(&bytes);
                send(socket, json!({"type":"uploadAck"})).await?;
            }
            Input::EndFile => {
                let (file, size) = partial.take().ok_or_else(invalid)?;
                if file.bytes.len() != size {
                    return Err(invalid());
                }
                originals.push(file);
                send(socket, json!({"type":"uploadAck"})).await?;
            }
            Input::Chat { turns, locale } if kind == LiveKind::Chat => {
                if turns.is_empty()
                    || turns.len() > 128
                    || locale
                        .as_deref()
                        .is_some_and(|value| !["de", "en"].contains(&value))
                    || turns
                        .iter()
                        .any(|turn| !["user", "assistant"].contains(&turn.role.as_str()))
                    || turns.iter().map(|turn| turn.content.len()).sum::<usize>() > 1_500_000
                {
                    return Err(invalid());
                }
                return Ok(Request::Chat(
                    turns
                        .into_iter()
                        .map(|turn| ChatTurn {
                            role: turn.role,
                            content: turn.content,
                        })
                        .collect(),
                    locale,
                ));
            }
            Input::Import { text, file_names } if kind == LiveKind::DocumentImport => {
                if partial.is_some()
                    || file_names.is_empty()
                    || file_names.len() > 20
                    || file_names
                        .iter()
                        .any(|name| name.is_empty() || name.len() > 512)
                    || (text.trim().is_empty() && originals.is_empty())
                    || text.len() > 1_500_000
                {
                    return Err(invalid());
                }
                return Ok(Request::Import(DocumentScanInput {
                    ocr_text: text,
                    ocr_confidence: 0.0,
                    ocr_method: "browser".into(),
                    originals,
                    file_names,
                }));
            }
            _ => return Err(invalid()),
        }
    }
}

async fn receive<T: serde::de::DeserializeOwned>(socket: &mut WebSocket) -> RpcResult<T> {
    loop {
        match socket
            .recv()
            .await
            .ok_or_else(unavailable)?
            .map_err(|_| unavailable())?
        {
            Message::Text(value) => return serde_json::from_str(&value).map_err(|_| invalid()),
            Message::Ping(value) => socket
                .send(Message::Pong(value))
                .await
                .map_err(|_| unavailable())?,
            Message::Pong(_) => {}
            _ => return Err(unavailable()),
        }
    }
}
async fn send(socket: &mut WebSocket, value: Value) -> RpcResult<()> {
    let text = serde_json::to_string(&value).map_err(|_| invalid())?;
    if text.len() > WIRE_LIMIT {
        return Err(invalid());
    }
    socket
        .send(Message::Text(text.into()))
        .await
        .map_err(|_| unavailable())
}
async fn record(
    state: &AppState,
    auth: &AuthResult,
    kind: LiveKind,
    configuration: &super::super::ProviderConfiguration,
    usage: &TokenUsage,
    failed: bool,
) -> RpcResult<()> {
    sqlx::query("INSERT INTO __llm_usage(tenant_name,user_id,purpose,provider,model,input_tokens,output_tokens,total_tokens,status,error) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)")
        .bind(&auth.tenant).bind(auth.user.id.parse::<i64>().map_err(|_| forbidden())?)
        .bind(if kind == LiveKind::Chat { "chat" } else { "delivery_note_scan" }).bind(&configuration.provider).bind(&configuration.model)
        .bind(usage.input_tokens.max(0)).bind(usage.output_tokens.max(0)).bind(usage.total_tokens.max(0))
        .bind(if failed { "failed" } else { "succeeded" }).bind(if failed { Some("request_failed") } else { None })
        .execute(state.tenants.master()).await.map_err(|_| unavailable())?;
    Ok(())
}
