//! Real application MCP coverage with a deterministic OpenRouter model fixture.

use axum::http::HeaderMap;

use super::*;

const MODEL: &str = "deepseek/deepseek-v4.1-flash-1017";
const API_KEY: &str = "openrouter-integration-fixture";

pub(super) async fn verify(
    rpc: &RpcClient,
    fixture: &Fixture,
    admin_token: &str,
    token: &str,
    scan_product_id: i64,
) {
    let provider = MockProvider::start().await;

    rpc.mutation(
        "admin.llm.providers.update",
        json!({ "provider": "openrouter", "baseUrl": provider.url, "apiKey": API_KEY }),
        Some(admin_token),
    )
    .await;

    for use_case in ["chat", "documentImport"] {
        rpc.mutation(
            "admin.llm.useCases.update",
            json!({ "useCase": use_case, "provider": "openrouter", "model": MODEL }),
            Some(admin_token),
        )
        .await;
    }

    let status = rpc.query("llm.status", Value::Null, Some(token)).await;
    assert_eq!(status["available"], true);
    assert_eq!(status["scanProviderConfigured"], true);

    let chat = rpc
        .mutation("llm.chats.create", json!({}), Some(token))
        .await;
    let chat_id = chat["id"].as_str().unwrap();
    let costs = rpc
        .mutation(
            "llm.messages.send",
            json!({ "chatId": chat_id, "content": "Zeige die aktuellen Projektkosten." }),
            Some(token),
        )
        .await;
    assert_eq!(
        costs["messages"].as_array().unwrap().last().unwrap()["content"],
        "Die aktuelle Projektkostenübersicht wurde geladen."
    );
    // The ordinary read has one tool call followed by its final answer.
    assert_eq!(provider.requests.lock().await.len(), 2);

    let before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM projects")
        .fetch_one(&fixture.tenant_pool)
        .await
        .unwrap();
    let proposed = rpc
        .mutation(
            "llm.messages.send",
            json!({
                "chatId": chat_id,
                "content": concat!(
                    "Lege das Projekt „Test Projekt LLM“ mit der Adresse ",
                    "„Musterstr. 42, Musterstadt“ an."
                ),
                "locale": "de"
            }),
            Some(token),
        )
        .await;
    let proposal = proposed["proposals"].as_array().unwrap().last().unwrap();
    assert_eq!(proposal["status"], "pending");
    assert_eq!(proposal["operations"][0]["path"], "projects.create");
    assert_eq!(
        proposal["operations"][0]["input"]["address"]["city"],
        "Musterstadt"
    );
    // Schema lookup, rejected input, corrected proposal, then the final answer.
    assert_eq!(provider.requests.lock().await.len(), 2 + 4);

    let after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM projects")
        .fetch_one(&fixture.tenant_pool)
        .await
        .unwrap();
    assert_eq!(
        after, before,
        "MCP proposals must not execute their mutations"
    );

    rpc.mutation(
        "llm.proposals.review",
        json!({ "proposalId": proposal["id"], "decision": "decline", "comment": null }),
        Some(token),
    )
    .await;

    verify_scan(rpc, token, scan_product_id).await;

    let usage = rpc.query("llm.admin.usage", Value::Null, Some(token)).await;

    // Usage rows count application requests; token totals include all model turns.
    for (purpose, application_requests, total_tokens) in
        [("chat", 2, 720), ("delivery_note_scan", 1, 240)]
    {
        let row = usage
            .as_array()
            .unwrap()
            .iter()
            .find(|row| {
                row["provider"] == "openrouter"
                    && row["model"] == MODEL
                    && row["purpose"] == purpose
            })
            .expect("OpenRouter usage must be persisted by purpose");
        assert_eq!(row["requestCount"], application_requests);
        assert_eq!(row["failedRequests"], 0);
        assert_eq!(row["totalTokens"], total_tokens);
    }

    let requests = provider.requests.lock().await;
    // Read: two turns; proposal: four; scan: catalogue search and answer.
    assert_eq!(requests.len(), 2 + 4 + 2);
    assert!(requests.iter().all(|request| {
        request["model"] == MODEL
            && request["tools"]
                .as_array()
                .unwrap()
                .iter()
                .all(|tool| tool["type"] == "function")
            && !request.to_string().contains("authorization")
            && !request.to_string().contains("server_url")
    }));

    let scan_requests = requests
        .iter()
        .filter(|request| request.get("response_format").is_some())
        .collect::<Vec<_>>();
    assert_eq!(scan_requests.len(), 2);

    for request in scan_requests {
        assert_eq!(request["tools"].as_array().unwrap().len(), 1);
        assert_eq!(
            request["tools"][0]["function"]["name"],
            "sortsys_search_products"
        );
    }

    drop(requests);

    // Keep the surrounding native scenario's final configuration unchanged.
    for use_case in ["chat", "documentImport"] {
        rpc.mutation(
            "admin.llm.useCases.update",
            json!({ "useCase": use_case, "provider": "openai", "model": "gpt-5.6-luna" }),
            Some(admin_token),
        )
        .await;
    }

    rpc.mutation(
        "llm.chats.delete",
        json!({ "chatId": chat_id }),
        Some(token),
    )
    .await;
}

async fn verify_scan(rpc: &RpcClient, token: &str, product_id: i64) {
    let bytes = include_bytes!("../fixtures/delivery-note-ocr.png").to_vec();
    let upload = rpc
        .mutation(
            "deliveryNotes.scan.createUpload",
            json!({
                "fileName": "openrouter-lieferschein.png",
                "mimeType": "image/png",
                "sizeBytes": bytes.len()
            }),
            Some(token),
        )
        .await;
    let uploaded = rpc
        .http
        .put(upload["uploadUrl"].as_str().unwrap())
        .header("content-type", "image/png")
        .body(bytes.clone())
        .send()
        .await
        .unwrap();
    assert!(uploaded.status().is_success());

    let scan = rpc
        .mutation(
            "deliveryNotes.scan.start",
            json!({ "documents": [{
                "objectKey": upload["objectKey"],
                "fileName": "openrouter-lieferschein.png",
                "mimeType": "image/png",
                "sizeBytes": bytes.len()
            }] }),
            Some(token),
        )
        .await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);

    loop {
        let status = rpc
            .query(
                "deliveryNotes.scan.status",
                json!({ "scanId": scan["scanId"] }),
                Some(token),
            )
            .await;

        if status["state"] == "completed" {
            break;
        }

        assert!(matches!(
            status["state"].as_str(),
            Some("queued" | "ocr" | "matching")
        ));
        assert!(
            tokio::time::Instant::now() < deadline,
            "OpenRouter scan timed out"
        );
        sleep(Duration::from_millis(100)).await;
    }

    let parsed = rpc
        .mutation(
            "deliveryNotes.scan.complete",
            json!({ "scanId": scan["scanId"] }),
            Some(token),
        )
        .await;
    assert_eq!(parsed["documentType"], "deliveryNote");
    assert_eq!(
        parsed["deliveryNote"]["records"][0]["productId"],
        Id(product_id).encode()
    );
    assert_eq!(parsed["deliveryNote"]["records"][0]["quantity"], 50.0);
}

struct MockProvider {
    url: String,
    requests: OpenAiRequestLog,
    server: tokio::task::JoinHandle<()>,
}

impl MockProvider {
    async fn start() -> Self {
        let requests = OpenAiRequestLog::default();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let router = Router::new()
            .route("/v1/chat/completions", post(model_turn))
            .with_state(requests.clone());
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });

        Self {
            url,
            requests,
            server,
        }
    }
}

impl Drop for MockProvider {
    fn drop(&mut self) {
        self.server.abort();
    }
}

async fn model_turn(
    State(requests): State<OpenAiRequestLog>,
    headers: HeaderMap,
    Json(request): Json<Value>,
) -> Json<Value> {
    assert_eq!(headers["authorization"], format!("Bearer {API_KEY}"));
    let messages = request["messages"].as_array().unwrap();
    let mut input = Vec::new();

    for message in messages {
        if message["role"] == "tool" {
            let result: Value = serde_json::from_str(message["content"].as_str().unwrap()).unwrap();
            let output = if result["isError"] == true {
                let text = result["content"][0]["text"].as_str().unwrap();
                let (code, message) = text.split_once(": ").unwrap();

                json!({ "error": { "code": code, "message": message } })
            } else {
                result["structuredContent"].clone()
            };

            input.push(json!({ "type": "mcp_tool_result", "output": output.to_string() }));
        } else {
            let mut message = message.clone();

            if let Some(parts) = message["content"].as_array_mut() {
                for part in parts {
                    if part["type"] == "text" {
                        part["type"] = json!("input_text");
                    }
                }
            }

            input.push(message);
        }
    }

    let scan = request.get("response_format").is_some();
    let response = mock_openai_model_turn(&json!({
        "input": input,
        "text": if scan { json!({ "format": { "name": "document_scan" } }) } else { Value::Null }
    }));
    let calls = response["output"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|item| item["type"] == "mcp_call")
        .map(|item| {
            json!({
                "id": item["call_id"], "type": "function",
                "function": { "name": item["name"], "arguments": item["arguments"] }
            })
        })
        .collect::<Vec<_>>();
    let has_calls = !calls.is_empty();
    let message = if has_calls {
        json!({ "role": "assistant", "content": null, "tool_calls": calls })
    } else {
        let text = response["output"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|item| item["content"].as_array().into_iter().flatten())
            .filter(|part| part["type"] == "output_text")
            .filter_map(|part| part["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n");

        json!({ "role": "assistant", "content": text })
    };

    requests.lock().await.push(request);

    Json(json!({
        "choices": [{
            "message": message,
            "finish_reason": if has_calls { "tool_calls" } else { "stop" }
        }],
        "usage": { "prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120 }
    }))
}
