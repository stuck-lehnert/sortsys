use std::{collections::VecDeque, sync::Arc};

use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
};
use tokio::sync::Mutex;

use super::*;

const MCP_TOKEN: &str = "scoped-mcp-fixture";
const PROVIDER_KEY: &str = "openrouter-key-fixture";

type RecordedRequests = Mutex<Vec<(HeaderMap, Value)>>;

struct MockState {
    provider_replies: Mutex<VecDeque<(StatusCode, Value)>>,
    provider_requests: RecordedRequests,
    mcp_requests: RecordedRequests,
    tools: Vec<Value>,
    tool_results: Mutex<VecDeque<Value>>,
    reject_method: Option<&'static str>,
    rpc_error: bool,
    wrong_id: bool,
    protocol: &'static str,
    rotate_session: bool,
    redirect_method: Option<&'static str>,
    provider_delay: std::time::Duration,
    provider_started: tokio::sync::Notify,
}

impl MockState {
    fn new(replies: Vec<Value>) -> Self {
        Self {
            provider_replies: Mutex::new(
                replies
                    .into_iter()
                    .map(|reply| (StatusCode::OK, reply))
                    .collect(),
            ),
            provider_requests: Mutex::new(Vec::new()),
            mcp_requests: Mutex::new(Vec::new()),
            tools: vec![tool("sortsys_query"), tool("sortsys_search_products")],
            tool_results: Mutex::new(VecDeque::new()),
            reject_method: None,
            rpc_error: false,
            wrong_id: false,
            protocol: "2025-06-18",
            rotate_session: false,
            redirect_method: None,
            provider_delay: std::time::Duration::ZERO,
            provider_started: tokio::sync::Notify::new(),
        }
    }
}

struct Fixture {
    state: Arc<MockState>,
    server: tokio::task::JoinHandle<()>,
    base: String,
}

impl Fixture {
    async fn start(state: MockState) -> Self {
        let state = Arc::new(state);
        let router = Router::new()
            .route("/mcp", post(mock_mcp))
            .route("/v1/chat/completions", post(mock_provider))
            .with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });

        Self {
            state,
            server,
            base,
        }
    }

    fn configuration(&self) -> ProviderConfiguration {
        ProviderConfiguration {
            provider: "openrouter".to_owned(),
            model: "deepseek/deepseek-v4.1-flash-1017".to_owned(),
            base_url: Some(self.base.clone()),
            api_key: PROVIDER_KEY.to_owned(),
        }
    }

    async fn chat(&self) -> Result<(String, TokenUsage), ProviderError> {
        complete(
            &self.configuration(),
            vec![json!({ "role": "user", "content": "Find projects" })],
            "Use authenticated MCP",
            &format!("{}/mcp", self.base),
            MCP_TOKEN,
            McpScope::Chat(42),
        )
        .await
    }

    async fn tool_call_count(&self) -> usize {
        self.state
            .mcp_requests
            .lock()
            .await
            .iter()
            .filter(|(_, request)| request["method"] == "tools/call")
            .count()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.server.abort();
    }
}

async fn mock_provider(
    State(state): State<Arc<MockState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    state.provider_requests.lock().await.push((headers, body));
    state.provider_started.notify_one();
    tokio::time::sleep(state.provider_delay).await;

    let (status, reply) = state.provider_replies.lock().await.pop_front().unwrap_or((
        StatusCode::INTERNAL_SERVER_ERROR,
        json!({ "error": "Unexpected retry" }),
    ));

    if status.is_redirection() {
        return (status, [("location", "/mcp")], Json(reply)).into_response();
    }

    (status, Json(reply)).into_response()
}

async fn mock_mcp(
    State(state): State<Arc<MockState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    state
        .mcp_requests
        .lock()
        .await
        .push((headers, body.clone()));
    let method = body["method"].as_str().unwrap();

    if state.reject_method == Some(method) {
        return StatusCode::UNAUTHORIZED.into_response();
    }

    if state.redirect_method == Some(method) {
        return (
            StatusCode::TEMPORARY_REDIRECT,
            [("location", "/v1/chat/completions")],
        )
            .into_response();
    }

    if method == "notifications/initialized" {
        return StatusCode::ACCEPTED.into_response();
    }

    if state.rpc_error && method == "tools/call" {
        return Json(json!({
            "jsonrpc": "2.0", "id": body["id"],
            "error": { "code": -32000, "message": "Fixture failure" }
        }))
        .into_response();
    }

    let result = match method {
        "initialize" => json!({
            "protocolVersion": state.protocol,
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "fixture", "version": "1" }
        }),
        "tools/list" => json!({ "tools": state.tools }),
        "tools/call" => state
            .tool_results
            .lock()
            .await
            .pop_front()
            .unwrap_or_else(|| {
                json!({
                    "content": [{ "type": "text", "text": "{\"records\":[]}" }],
                    "structuredContent": { "records": [] }
                })
            }),
        _ => panic!("Unexpected MCP method"),
    };

    let id = if state.wrong_id {
        json!(999)
    } else {
        body["id"].clone()
    };

    let reply = Json(json!({ "jsonrpc": "2.0", "id": id, "result": result }));

    if method == "initialize" {
        return ([("mcp-session-id", "session-fixture")], reply).into_response();
    }

    if state.rotate_session {
        return ([("mcp-session-id", "changed-session")], reply).into_response();
    }

    reply.into_response()
}

fn tool(name: &str) -> Value {
    json!({
        "name": name,
        "description": "Scoped fixture tool",
        "inputSchema": { "type": "object", "properties": { "query": { "type": "string" } } }
    })
}

fn call(id: &str, name: &str, arguments: &str) -> Value {
    json!({
        "id": id, "type": "function",
        "function": { "name": name, "arguments": arguments }
    })
}

fn tool_reply(calls: Vec<Value>) -> Value {
    json!({
        "choices": [{
            "finish_reason": "tool_calls",
            "message": {
                "role": "assistant", "content": null, "tool_calls": calls,
                "reasoning_details": [{ "type": "reasoning.encrypted", "data": "opaque-fixture" }],
                "annotations": [{ "type": "file", "file": { "hash": "fixture" } }]
            }
        }],
        "usage": { "prompt_tokens": 2, "completion_tokens": 3, "total_tokens": 5 }
    })
}

fn answer(text: &str) -> Value {
    json!({
        "choices": [{
            "finish_reason": "stop", "message": { "role": "assistant", "content": text }
        }],
        "usage": { "prompt_tokens": 2, "completion_tokens": 3 }
    })
}

#[tokio::test]
async fn bridges_twenty_rounds_through_authenticated_mcp_and_preserves_reasoning() {
    let mut replies = (0..20)
        .map(|round| {
            tool_reply(vec![call(
                &format!("call-{round}"),
                "sortsys_query",
                "{\"query\":\"x\"}",
            )])
        })
        .collect::<Vec<_>>();
    replies.push(answer("Finished through MCP"));

    let fixture = Fixture::start(MockState::new(replies)).await;
    let (content, usage) = fixture.chat().await.unwrap();

    assert_eq!(content, "Finished through MCP");
    assert_eq!(
        (usage.input_tokens, usage.output_tokens, usage.total_tokens),
        (42, 63, 105)
    );
    assert_eq!(fixture.tool_call_count().await, 20);

    let requests = fixture.state.provider_requests.lock().await;

    for (round, (headers, body)) in requests.iter().enumerate() {
        assert_eq!(headers["authorization"], format!("Bearer {PROVIDER_KEY}"));
        assert!(headers.get("mcp-session-id").is_none());
        assert!(!body.to_string().contains(MCP_TOKEN));
        assert!(!body.to_string().contains("/mcp"));
        assert_eq!(body["model"], "deepseek/deepseek-v4.1-flash-1017");
        assert_eq!(body["provider"]["require_parameters"], true);
        assert_eq!(body["tools"][0]["type"], "function");
        assert_eq!(body["tools"][0]["function"]["parameters"]["type"], "object");
        assert_eq!(body["messages"].as_array().unwrap().len(), 2 + round * 2);

        if round > 0 {
            let previous = &body["messages"][round * 2];
            assert_eq!(previous["reasoning_details"][0]["data"], "opaque-fixture");
            assert_eq!(previous["annotations"][0]["file"]["hash"], "fixture");
            assert_eq!(body["messages"][round * 2 + 1]["role"], "tool");
        }
    }

    let requests = fixture.state.mcp_requests.lock().await;
    assert_eq!(requests[0].1["method"], "initialize");
    assert_eq!(requests[1].1["method"], "notifications/initialized");
    assert_eq!(requests[2].1["method"], "tools/list");

    for (index, (headers, body)) in requests.iter().enumerate() {
        assert_eq!(headers["authorization"], format!("Bearer {MCP_TOKEN}"));
        assert_eq!(headers["mcp-protocol-version"], "2025-06-18");
        assert!(!body.to_string().contains(PROVIDER_KEY));

        if index > 0 {
            assert_eq!(headers["mcp-session-id"], "session-fixture");
        }
    }
}

#[tokio::test]
async fn passes_multiple_results_and_recoverable_errors_back_for_model_repair() {
    let first = tool_reply(vec![
        call("bad-query", "sortsys_query", "{}"),
        call(
            "catalogue",
            "sortsys_search_products",
            "{\"query\":\"plaster\"}",
        ),
    ]);
    let mut state = MockState::new(vec![first, answer("Repaired")]);
    state.tool_results = Mutex::new(VecDeque::from([json!({
        "isError": true,
        "content": [{ "type": "text", "text": "BAD_REQUEST: missing path" }]
    })]));
    let fixture = Fixture::start(state).await;
    let (content, _) = fixture.chat().await.unwrap();

    assert_eq!(content, "Repaired");
    assert_eq!(fixture.tool_call_count().await, 2);

    let requests = fixture.state.provider_requests.lock().await;
    let messages = &requests[1].1["messages"];
    let result: Value = serde_json::from_str(messages[3]["content"].as_str().unwrap()).unwrap();

    assert_eq!(messages[3]["tool_call_id"], "bad-query");
    assert_eq!(messages[4]["tool_call_id"], "catalogue");
    assert_eq!(result["isError"], true);
    assert_eq!(result["content"][0]["text"], "BAD_REQUEST: missing path");
}

#[tokio::test]
async fn validates_whole_batches_before_any_mcp_execution() {
    let valid = call("first", "sortsys_query", "{}");
    let mut invalid_type = call("second", "sortsys_query", "{}");
    invalid_type["type"] = json!("custom");
    let mut missing_id = call("second", "sortsys_query", "{}");
    missing_id.as_object_mut().unwrap().remove("id");

    for invalid in [
        call("second", "unadvertised", "{}"),
        call("second", "sortsys_query", "not JSON"),
        call("second", "sortsys_query", "[]"),
        call("first", "sortsys_query", "{}"),
        invalid_type,
        missing_id,
    ] {
        let fixture = Fixture::start(MockState::new(vec![tool_reply(vec![
            valid.clone(),
            invalid,
        ])]))
        .await;

        assert!(fixture.chat().await.is_err());
        assert_eq!(fixture.tool_call_count().await, 0);
        assert_eq!(fixture.state.provider_requests.lock().await.len(), 1);
    }
}

#[tokio::test]
async fn refuses_repeated_ids_across_rounds_without_replaying_the_tool() {
    let reply = tool_reply(vec![call("same-id", "sortsys_query", "{}")]);
    let fixture = Fixture::start(MockState::new(vec![reply.clone(), reply])).await;

    assert!(
        fixture
            .chat()
            .await
            .unwrap_err()
            .message
            .contains("repeated")
    );
    assert_eq!(fixture.tool_call_count().await, 1);
}

#[tokio::test]
async fn mcp_auth_and_rpc_failures_stop_without_fallback() {
    for method in [
        "initialize",
        "notifications/initialized",
        "tools/list",
        "tools/call",
    ] {
        let mut state = MockState::new(vec![tool_reply(vec![call("one", "sortsys_query", "{}")])]);
        state.reject_method = Some(method);
        let fixture = Fixture::start(state).await;

        assert!(fixture.chat().await.is_err());
        assert_eq!(
            fixture.state.provider_requests.lock().await.len(),
            usize::from(method == "tools/call")
        );
    }

    let mut state = MockState::new(vec![tool_reply(vec![call("one", "sortsys_query", "{}")])]);
    state.rpc_error = true;
    let fixture = Fixture::start(state).await;

    assert!(
        fixture
            .chat()
            .await
            .unwrap_err()
            .message
            .contains("JSON-RPC")
    );
    assert_eq!(fixture.state.provider_requests.lock().await.len(), 1);
}

#[tokio::test]
async fn validates_mcp_protocol_and_json_rpc_ids_before_contacting_provider() {
    for wrong_id in [false, true] {
        let mut state = MockState::new(vec![answer("Never reached")]);
        state.wrong_id = wrong_id;
        state.protocol = if wrong_id {
            "2025-06-18"
        } else {
            "unsupported"
        };

        let fixture = Fixture::start(state).await;

        assert!(fixture.chat().await.is_err());
        assert!(fixture.state.provider_requests.lock().await.is_empty());
    }
}

#[tokio::test]
async fn provider_errors_and_truncated_or_empty_answers_do_not_retry() {
    let mut truncated = answer("Incomplete");
    truncated["choices"][0]["finish_reason"] = json!("length");
    let mut incomplete_calls = tool_reply(vec![call("one", "sortsys_query", "{}")]);
    incomplete_calls["choices"][0]["finish_reason"] = json!("length");

    for reply in [
        answer("  "),
        truncated,
        incomplete_calls,
        json!({ "choices": [] }),
        json!({ "error": { "message": "Unsupported model parameter" } }),
    ] {
        let fixture = Fixture::start(MockState::new(vec![reply])).await;

        assert!(fixture.chat().await.is_err());
        assert_eq!(fixture.tool_call_count().await, 0);
        assert_eq!(fixture.state.provider_requests.lock().await.len(), 1);
    }

    let mut state = MockState::new(Vec::new());
    state.provider_replies = Mutex::new(VecDeque::from([(
        StatusCode::BAD_REQUEST,
        json!({ "error": { "message": "Model does not support tools" } }),
    )]));
    let fixture = Fixture::start(state).await;
    let error = fixture.chat().await.unwrap_err();

    assert_eq!(error.status, Some(400));
    assert_eq!(error.message, "Model does not support tools");
    assert_eq!(fixture.state.provider_requests.lock().await.len(), 1);
}

#[tokio::test]
async fn document_import_uses_catalogue_mcp_and_preserves_schema_and_originals() {
    let fixture = Fixture::start(MockState::new(vec![
        tool_reply(vec![call(
            "catalogue",
            "sortsys_search_products",
            "{\"query\":\"plaster\"}",
        )]),
        answer("{\"lines\":[]}"),
    ]))
    .await;
    let input = DocumentScanInput {
        ocr_text: "Supplier plaster 25 kg".to_owned(),
        ocr_confidence: 0.4,
        ocr_method: "fixture".to_owned(),
        file_names: vec!["scan.pdf".to_owned(), "scan.png".to_owned()],
        originals: vec![
            super::super::ScanOriginal {
                bytes: b"%PDF-fixture".to_vec(),
                mime_type: "application/pdf".to_owned(),
                file_name: "scan.pdf".to_owned(),
            },
            super::super::ScanOriginal {
                bytes: vec![1, 2, 3],
                mime_type: "image/png".to_owned(),
                file_name: "scan.png".to_owned(),
            },
        ],
    };

    let completion = scan(
        &fixture.configuration(),
        &input,
        "Scan prompt",
        &format!("{}/mcp", fixture.base),
        MCP_TOKEN,
    )
    .await
    .unwrap();

    assert_eq!(completion.content, "{\"lines\":[]}");
    assert_eq!(completion.usage.total_tokens, 10);
    assert_eq!(fixture.tool_call_count().await, 1);

    let requests = fixture.state.provider_requests.lock().await;

    for (_, request) in requests.iter() {
        assert_eq!(request["tools"].as_array().unwrap().len(), 1);
        assert_eq!(
            request["tools"][0]["function"]["name"],
            "sortsys_search_products"
        );
        assert_eq!(request["max_tokens"], 65_536);
        assert_eq!(request["response_format"]["type"], "json_schema");
        assert_eq!(request["response_format"]["json_schema"]["strict"], true);
        assert_eq!(
            request["response_format"]["json_schema"]["schema"],
            scan_result_schema()
        );
    }

    let content = &requests[0].1["messages"][1]["content"];
    assert!(
        content[0]["text"]
            .as_str()
            .unwrap()
            .contains("Supplier plaster 25 kg")
    );
    assert_eq!(content[1]["type"], "file");
    assert_eq!(content[1]["file"]["filename"], "scan.pdf");
    assert_eq!(
        content[1]["file"]["file_data"],
        "data:application/pdf;base64,JVBERi1maXh0dXJl"
    );
    assert_eq!(content[2]["type"], "image_url");
    assert_eq!(content[2]["image_url"]["url"], "data:image/png;base64,AQID");
}

#[tokio::test]
async fn document_import_cannot_invoke_a_chat_tool_even_if_mcp_advertises_it() {
    let fixture = Fixture::start(MockState::new(vec![tool_reply(vec![call(
        "escape",
        "sortsys_query",
        "{}",
    )])]))
    .await;
    let result = execute(
        &fixture.configuration(),
        body(&fixture.configuration(), Vec::new(), "Scan prompt"),
        &format!("{}/mcp", fixture.base),
        MCP_TOKEN,
        McpScope::DocumentImport,
    )
    .await;

    assert!(result.unwrap_err().message.contains("unadvertised"));
    assert_eq!(fixture.tool_call_count().await, 0);
}

#[tokio::test]
async fn rejects_session_changes_before_contacting_the_provider() {
    let mut state = MockState::new(vec![answer("Never reached")]);
    state.rotate_session = true;
    let fixture = Fixture::start(state).await;

    assert!(
        fixture
            .chat()
            .await
            .unwrap_err()
            .message
            .contains("session id")
    );
    assert!(fixture.state.provider_requests.lock().await.is_empty());
    assert_eq!(fixture.tool_call_count().await, 0);
}

#[tokio::test]
async fn uses_the_negotiated_supported_protocol_on_subsequent_requests() {
    let mut state = MockState::new(vec![answer("Negotiated")]);
    state.protocol = "2025-03-26";
    let fixture = Fixture::start(state).await;

    assert_eq!(fixture.chat().await.unwrap().0, "Negotiated");

    let requests = fixture.state.mcp_requests.lock().await;
    assert_eq!(requests[0].0["mcp-protocol-version"], "2025-06-18");

    for (headers, _) in requests.iter().skip(1) {
        assert_eq!(headers["mcp-protocol-version"], "2025-03-26");
    }
}

#[tokio::test]
async fn refuses_redirects_without_forwarding_either_credential() {
    let mut state = MockState::new(Vec::new());
    state.redirect_method = Some("initialize");
    let fixture = Fixture::start(state).await;

    assert_eq!(fixture.chat().await.unwrap_err().status, Some(307));
    assert!(fixture.state.provider_requests.lock().await.is_empty());
    assert_eq!(fixture.state.mcp_requests.lock().await.len(), 1);

    let mut state = MockState::new(Vec::new());
    state.provider_replies = Mutex::new(VecDeque::from([(
        StatusCode::TEMPORARY_REDIRECT,
        json!({ "error": { "message": "Do not follow" } }),
    )]));
    let fixture = Fixture::start(state).await;

    assert_eq!(fixture.chat().await.unwrap_err().status, Some(307));
    assert_eq!(fixture.state.provider_requests.lock().await.len(), 1);
    assert_eq!(fixture.state.mcp_requests.lock().await.len(), 3);
}

#[tokio::test]
async fn cancelling_a_provider_request_cannot_start_later_mcp_calls() {
    let mut state = MockState::new(vec![tool_reply(vec![call("one", "sortsys_query", "{}")])]);
    state.provider_delay = std::time::Duration::from_millis(50);
    let fixture = Fixture::start(state).await;
    let mut request = Box::pin(fixture.chat());

    tokio::select! {
        _ = fixture.state.provider_started.notified() => {},
        result = &mut request => panic!("Provider completed before cancellation: {result:?}"),
    }

    drop(request);
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;

    assert_eq!(fixture.state.provider_requests.lock().await.len(), 1);
    assert_eq!(fixture.tool_call_count().await, 0);
}

#[test]
fn rejects_invalid_catalogues_and_usage_without_panics() {
    for tools in [
        Vec::new(),
        vec![tool("invalid name")],
        vec![tool("same"), tool("same")],
        vec![json!({ "name": "missing_schema" })],
    ] {
        assert!(function_tools(tools, McpScope::Chat(42)).is_err());
    }

    let mut usage = TokenUsage::default();
    assert!(add_usage(&mut usage, &json!({ "prompt_tokens": -1 })).is_err());
    assert!(add_usage(&mut usage, &json!({ "completion_tokens": "invalid" })).is_err());

    for _ in 0..2 {
        add_usage(&mut usage, &json!({ "prompt_tokens": i64::MAX })).unwrap();
    }

    assert_eq!(usage.input_tokens, i64::MAX);
    assert_eq!(usage.total_tokens, i64::MAX);
}
