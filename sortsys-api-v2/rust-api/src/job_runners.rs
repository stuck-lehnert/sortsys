//! Authenticated WebSocket protocol for external media-processing workers.
//!
//! Runners poll queue summaries, explicitly acquire work, renew leases, and
//! report completion or failure. Work still owned when a socket closes is
//! returned to the queue.

use std::{collections::HashMap, sync::Arc};

use axum::{
    Router,
    extract::{
        State,
        ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade},
    },
    response::Response,
    routing::get,
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{
    AppState,
    error::RpcError,
    job_queue::{self, QueueJob},
    job_runner_media,
};

pub const WS_PATH: &str = "/internal/job-runners/ws";

const MAX_MESSAGE_BYTES: usize = 2 * 1024 * 1024;
const DEFAULT_POLL_LIMIT: i64 = 10;
const DEFAULT_RETRY_SECONDS: i32 = 30;

pub fn router(state: Arc<AppState>) -> Router {
    Router::new().route(WS_PATH, get(upgrade)).with_state(state)
}

async fn upgrade(State(state): State<Arc<AppState>>, websocket: WebSocketUpgrade) -> Response {
    websocket
        .max_message_size(MAX_MESSAGE_BYTES)
        .on_upgrade(move |socket| serve_socket(socket, state))
}

async fn serve_socket(mut socket: WebSocket, state: Arc<AppState>) {
    let mut context = SocketContext::new();

    while let Some(message) = socket.recv().await {
        let response = match message {
            Ok(Message::Text(text)) => handle_message(&state, &mut context, text.as_str()).await,
            Ok(Message::Binary(bytes)) => match std::str::from_utf8(&bytes) {
                Ok(text) => handle_message(&state, &mut context, text).await,
                Err(_) => Some(OutboundMessage::error(
                    None,
                    "bad_request",
                    "Invalid message format",
                )),
            },
            Ok(Message::Close(_)) | Err(_) => break,
            Ok(Message::Ping(_) | Message::Pong(_)) => None,
        };

        let Some(response) = response else {
            continue;
        };
        let close_after_response = context.close_after_response;

        if send(&mut socket, response).await.is_err() {
            break;
        }

        if close_after_response {
            let _ = socket
                .send(Message::Close(Some(CloseFrame {
                    code: 1008,
                    reason: "Unauthorized".into(),
                })))
                .await;
            break;
        }
    }

    release_socket_jobs(&state, &mut context).await;
}

async fn handle_message(
    state: &AppState,
    context: &mut SocketContext,
    raw_message: &str,
) -> Option<OutboundMessage> {
    let message = match serde_json::from_str::<InboundMessage>(raw_message) {
        Ok(message) if !message.message_type.trim().is_empty() => message,
        _ => {
            return Some(OutboundMessage::error(
                None,
                "bad_request",
                "Invalid message format",
            ));
        }
    };
    let request_id = message.request_id.clone();

    match dispatch_message(state, context, message).await {
        Ok(response) => Some(response),
        Err(error) => Some(OutboundMessage::error(
            request_id,
            &error.code,
            &error.message,
        )),
    }
}

async fn dispatch_message(
    state: &AppState,
    context: &mut SocketContext,
    message: InboundMessage,
) -> Result<OutboundMessage, ProtocolError> {
    let request_id = message.request_id.clone();
    let payload = message.payload.unwrap_or_else(|| json!({}));

    if message.message_type == "hello" {
        return hello(state, context, request_id, payload);
    }

    if !context.authenticated {
        return Err(ProtocolError::new("unauthorized", "Send hello first"));
    }

    match message.message_type.as_str() {
        "jobs.poll" => poll_jobs(state, request_id, payload).await,
        "jobs.acquire" => acquire_job(state, context, request_id, payload).await,
        "jobs.heartbeat" => heartbeat(state, context, request_id, payload).await,
        "jobs.complete" => complete_job(state, context, request_id, payload).await,
        "jobs.fail" => fail_job(state, context, request_id, payload).await,
        unsupported => Err(ProtocolError::new(
            "not_implemented",
            format!("Unsupported message type '{unsupported}'"),
        )),
    }
}

fn hello(
    state: &AppState,
    context: &mut SocketContext,
    request_id: Option<String>,
    payload: Value,
) -> Result<OutboundMessage, ProtocolError> {
    let hello: HelloPayload = parse_payload(payload)?;

    if hello.token.trim() != state.config.job_runner_token.as_ref() {
        context.close_after_response = true;
        return Err(ProtocolError::new("unauthorized", "Invalid runner token"));
    }

    if let Some(runner_id) = nonempty(hello.runner_id) {
        if runner_id.len() > 255 {
            return Err(ProtocolError::new("bad_request", "runnerId is too long"));
        }

        context.runner_id = runner_id;
    }

    if let Some(lease_seconds) = hello.lease_sec {
        validate_lease_seconds(lease_seconds)?;
        context.lease_seconds = lease_seconds;
    }

    context.authenticated = true;

    Ok(OutboundMessage::new(
        "hello.ok",
        request_id,
        json!({
            "runnerId": context.runner_id,
            "leaseSec": context.lease_seconds,
            "serverTime": Utc::now(),
        }),
    ))
}

async fn poll_jobs(
    state: &AppState,
    request_id: Option<String>,
    payload: Value,
) -> Result<OutboundMessage, ProtocolError> {
    let payload: PollPayload = parse_payload(payload)?;
    let limit = payload.limit.unwrap_or(DEFAULT_POLL_LIMIT);

    if !(1..=50).contains(&limit) {
        return Err(ProtocolError::new(
            "bad_request",
            "limit must be between 1 and 50",
        ));
    }

    let job_type = nonempty(payload.job_type);
    let jobs = job_queue::list_open(state, limit, job_type.as_deref()).await?;

    Ok(OutboundMessage::new(
        "jobs.poll.result",
        request_id,
        json!({ "jobs": jobs }),
    ))
}

async fn acquire_job(
    state: &AppState,
    context: &mut SocketContext,
    request_id: Option<String>,
    payload: Value,
) -> Result<OutboundMessage, ProtocolError> {
    let payload: AcquirePayload = parse_payload(payload)?;
    let job_id = parse_job_id(&payload.job_id)?;
    let lease_seconds = payload.lease_sec.unwrap_or(context.lease_seconds);
    validate_lease_seconds(lease_seconds)?;

    let Some(job) = job_queue::acquire(state, job_id, &context.runner_id, lease_seconds).await?
    else {
        return Ok(OutboundMessage::new(
            "jobs.acquire.result",
            request_id,
            json!({ "acquired": false }),
        ));
    };

    match job_runner_media::prepare(state, &job).await {
        Ok(runner_job) => {
            job_runner_media::mark_processing(state, &job).await?;
            context.acquired_jobs.insert(job.id, job);

            Ok(OutboundMessage::new(
                "jobs.acquire.result",
                request_id,
                json!({
                    "acquired": true,
                    "job": runner_job,
                }),
            ))
        }
        Err(error) => {
            let reason = error.to_string();
            let _ = job_queue::fail(state, &context.runner_id, job.id, &reason, 60).await;
            let _ = job_runner_media::mark_failed(state, &job, true, Some(&reason)).await;

            Ok(OutboundMessage::new(
                "jobs.acquire.result",
                request_id,
                json!({ "acquired": false }),
            ))
        }
    }
}

async fn heartbeat(
    state: &AppState,
    context: &SocketContext,
    request_id: Option<String>,
    payload: Value,
) -> Result<OutboundMessage, ProtocolError> {
    let payload: HeartbeatPayload = parse_payload(payload)?;
    let job_id = payload.job_id.as_deref().map(parse_job_id).transpose()?;
    let lease_seconds = payload.lease_sec.unwrap_or(context.lease_seconds);
    validate_lease_seconds(lease_seconds)?;

    let updated = job_queue::heartbeat(state, &context.runner_id, job_id, lease_seconds).await?;

    Ok(OutboundMessage::new(
        "jobs.heartbeat.result",
        request_id,
        json!({ "updated": updated }),
    ))
}

async fn complete_job(
    state: &AppState,
    context: &mut SocketContext,
    request_id: Option<String>,
    payload: Value,
) -> Result<OutboundMessage, ProtocolError> {
    let payload: CompletePayload = parse_payload(payload)?;
    let job_id = parse_job_id(&payload.job_id)?;
    let result = payload.result.unwrap_or(Value::Null);

    let Some(job) = job_queue::complete(state, &context.runner_id, job_id, result.clone()).await?
    else {
        return Err(ProtocolError::new(
            "conflict",
            "Job is not acquired by this runner",
        ));
    };

    job_runner_media::complete(state, &job, &result).await?;
    context.acquired_jobs.remove(&job.id);

    Ok(OutboundMessage::new(
        "jobs.complete.result",
        request_id,
        json!({
            "success": true,
            "jobId": job.id.to_string(),
        }),
    ))
}

async fn fail_job(
    state: &AppState,
    context: &mut SocketContext,
    request_id: Option<String>,
    payload: Value,
) -> Result<OutboundMessage, ProtocolError> {
    let payload: FailPayload = parse_payload(payload)?;
    let job_id = parse_job_id(&payload.job_id)?;
    let error = payload.error.trim();

    if error.is_empty() || error.len() > 5_000 {
        return Err(ProtocolError::new("bad_request", "Invalid job error"));
    }

    let retry_after_seconds = payload.retry_after_sec.unwrap_or(DEFAULT_RETRY_SECONDS);
    if !(0..=24 * 60 * 60).contains(&retry_after_seconds) {
        return Err(ProtocolError::new("bad_request", "Invalid retryAfterSec"));
    }

    let Some(failed) = job_queue::fail(
        state,
        &context.runner_id,
        job_id,
        error,
        retry_after_seconds,
    )
    .await?
    else {
        return Err(ProtocolError::new(
            "conflict",
            "Job is not acquired by this runner",
        ));
    };

    job_runner_media::mark_failed(state, &failed.job, failed.should_retry, Some(error)).await?;
    context.acquired_jobs.remove(&failed.job.id);

    Ok(OutboundMessage::new(
        "jobs.fail.result",
        request_id,
        json!({
            "success": true,
            "jobId": failed.job.id.to_string(),
            "shouldRetry": failed.should_retry,
        }),
    ))
}

async fn release_socket_jobs(state: &AppState, context: &mut SocketContext) {
    for job in context.acquired_jobs.values() {
        let _ = job_runner_media::mark_failed(state, job, true, None).await;
    }

    context.acquired_jobs.clear();
    let _ = job_queue::release_runner_jobs(state, &context.runner_id).await;
}

async fn send(socket: &mut WebSocket, message: OutboundMessage) -> Result<(), axum::Error> {
    let encoded = serde_json::to_string(&message).unwrap_or_else(|_| {
        r#"{"type":"error","payload":{"code":"internal_error","message":"Failed to encode response"}}"#
            .to_owned()
    });

    socket.send(Message::Text(encoded.into())).await
}

fn parse_payload<T: for<'de> Deserialize<'de>>(payload: Value) -> Result<T, ProtocolError> {
    serde_json::from_value(payload).map_err(ProtocolError::bad_payload)
}

fn parse_job_id(value: &str) -> Result<i64, ProtocolError> {
    value
        .trim()
        .parse::<i64>()
        .ok()
        .filter(|id| *id > 0)
        .ok_or_else(|| ProtocolError::new("bad_request", "Invalid jobId"))
}

fn validate_lease_seconds(value: i32) -> Result<(), ProtocolError> {
    if (1..=15 * 60).contains(&value) {
        Ok(())
    } else {
        Err(ProtocolError::new("bad_request", "Invalid leaseSec"))
    }
}

fn nonempty(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn random_runner_id() -> String {
    let mut random = [0_u8; 8];
    getrandom::fill(&mut random).expect("operating system random source must be available");

    format!("runner-{}", hex::encode(random))
}

#[derive(Debug)]
struct SocketContext {
    authenticated: bool,
    close_after_response: bool,
    runner_id: String,
    lease_seconds: i32,
    acquired_jobs: HashMap<i64, QueueJob>,
}

impl SocketContext {
    fn new() -> Self {
        Self {
            authenticated: false,
            close_after_response: false,
            runner_id: random_runner_id(),
            lease_seconds: 90,
            acquired_jobs: HashMap::new(),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InboundMessage {
    #[serde(rename = "type")]
    message_type: String,

    #[serde(default)]
    request_id: Option<String>,

    #[serde(default)]
    payload: Option<Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OutboundMessage {
    #[serde(rename = "type")]
    message_type: String,

    #[serde(skip_serializing_if = "Option::is_none")]
    request_id: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    payload: Option<Value>,
}

impl OutboundMessage {
    fn new(message_type: &str, request_id: Option<String>, payload: Value) -> Self {
        Self {
            message_type: message_type.to_owned(),
            request_id,
            payload: Some(payload),
        }
    }

    fn error(request_id: Option<String>, code: &str, message: &str) -> Self {
        Self::new(
            "error",
            request_id,
            json!({
                "code": code,
                "message": message,
                "at": Utc::now(),
            }),
        )
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HelloPayload {
    token: String,
    runner_id: Option<String>,
    lease_sec: Option<i32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PollPayload {
    limit: Option<i64>,

    #[serde(rename = "type")]
    job_type: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AcquirePayload {
    job_id: String,
    lease_sec: Option<i32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HeartbeatPayload {
    job_id: Option<String>,
    lease_sec: Option<i32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CompletePayload {
    job_id: String,
    result: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FailPayload {
    job_id: String,
    error: String,
    retry_after_sec: Option<i32>,
}

#[derive(Debug)]
struct ProtocolError {
    code: String,
    message: String,
}

impl ProtocolError {
    fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }

    fn bad_payload(error: impl std::fmt::Display) -> Self {
        Self::new("bad_request", error.to_string())
    }
}

impl From<RpcError> for ProtocolError {
    fn from(error: RpcError) -> Self {
        Self::new("internal_error", error.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::validate_lease_seconds;

    #[test]
    fn validates_protocol_lease_bounds() {
        assert!(validate_lease_seconds(1).is_ok());
        assert!(validate_lease_seconds(900).is_ok());
        assert!(validate_lease_seconds(0).is_err());
        assert!(validate_lease_seconds(901).is_err());
    }
}
