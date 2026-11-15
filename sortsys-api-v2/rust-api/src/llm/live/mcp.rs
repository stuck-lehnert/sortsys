use super::*;
use axum::{
    Json,
    http::{HeaderMap, StatusCode},
};
use futures_util::StreamExt;
use serde_json::json;

pub(in crate::llm) async fn handle(
    state: Arc<Runtime>,
    headers: HeaderMap,
    request: super::super::McpRequest,
    route: &str,
) -> Response {
    let id = request.id.clone().unwrap_or(Value::Null);
    let checked = async {
        super::super::validate_mcp_headers(&headers, state.settings.mcp_url.as_deref())?;
        let (auth, scope) = state.auth.authenticate_mcp(&headers).await?;
        let owner: Owner = state.auth.verify_challenge_token(route)?;
        if owner.purpose != "llm-live-owner-v1"
            || owner.exp <= now()
            || owner.tenant != auth.tenant
            || owner.session != auth.session.id
            || owner.user != auth.user.id
        {
            return Err(forbidden());
        }
        let expected = match (owner.kind, owner.chat_id) {
            (LiveKind::Chat, Some(id)) => McpScope::Chat(id.0),
            (LiveKind::DocumentImport, None) => McpScope::DocumentImport,
            _ => return Err(forbidden()),
        };
        if scope != expected {
            return Err(forbidden());
        }
        authorize(&state, &auth, owner.kind).await?;
        if crate::zerotrust::live_identity(&state.auth, &auth).await?.1 != owner.generation {
            return Err(forbidden());
        }
        Ok((owner, auth, scope))
    }
    .await;
    let (owner, auth, scope) = match checked {
        Ok(value) => value,
        Err(error) => {
            tracing::debug!(code = error.code.name(), "Live MCP authorization failed");
            return (
                StatusCode::FORBIDDEN,
                Json(super::super::mcp_error(
                    id,
                    -32000,
                    "Live MCP access denied",
                )),
            )
                .into_response();
        }
    };
    if request.jsonrpc != "2.0" {
        return (
            StatusCode::BAD_REQUEST,
            Json(super::super::mcp_error(
                id,
                -32600,
                "Invalid JSON-RPC version",
            )),
        )
            .into_response();
    }
    if owner.instance != state.live_llm.instance {
        return forward(&headers, request, &owner, route)
            .await
            .unwrap_or_else(|error| {
                tracing::debug!(code = error.code.name(), "Live MCP peer unavailable");
                (
                    StatusCode::BAD_GATEWAY,
                    Json(super::super::mcp_error(
                        id,
                        -32000,
                        "Live MCP client is unavailable",
                    )),
                )
                    .into_response()
            });
    }
    let session = state
        .live_llm
        .sessions
        .lock()
        .ok()
        .and_then(|sessions| sessions.get(&owner.run).cloned());
    let Some(session) = session.filter(|session| {
        session.ticket.matches(&auth, scope) && session.ticket.generation == owner.generation
    }) else {
        return (
            StatusCode::FORBIDDEN,
            Json(super::super::mcp_error(
                id,
                -32000,
                "Live MCP client is unavailable",
            )),
        )
            .into_response();
    };
    if request.id.is_none() {
        return if request.method.starts_with("notifications/") {
            StatusCode::ACCEPTED.into_response()
        } else {
            StatusCode::BAD_REQUEST.into_response()
        };
    }
    let result = match request.method.as_str() {
        "initialize" => Ok(
            json!({"protocolVersion": request.params.get("protocolVersion").and_then(Value::as_str)
            .filter(|version| super::super::MCP_PROTOCOL_VERSIONS.contains(version)).unwrap_or("2025-06-18"),
            "capabilities":{"tools":{}},"serverInfo":{"name":"sortsys","version":env!("CARGO_PKG_VERSION")}}),
        ),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({"tools": definitions(&session.ticket)})),
        "tools/call" => {
            let name = request
                .params
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("");
            let arguments = request
                .params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            super::super::mcp_tool_result(tool(&session, name, arguments).await)
        }
        _ => Err(invalid()),
    };
    match result {
        Ok(value) => Json(json!({"jsonrpc":"2.0","id":id,"result":value})).into_response(),
        Err(_) => Json(super::super::mcp_error(
            id,
            -32000,
            "Live MCP request could not be completed",
        ))
        .into_response(),
    }
}

async fn forward(
    headers: &HeaderMap,
    request: super::super::McpRequest,
    owner: &Owner,
    route: &str,
) -> RpcResult<Response> {
    if headers.contains_key("x-sortsys-live-forwarded") {
        return Err(forbidden());
    }
    let endpoint = validate_endpoint(&owner.endpoint)?;
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(65))
        .build()
        .map_err(|_| unavailable())?;
    let mut body = json!({"jsonrpc":request.jsonrpc,"id":request.id,"method":request.method,"params":request.params});
    if request.id.is_none() {
        body.as_object_mut().ok_or_else(invalid)?.remove("id");
    }
    let mut call = client
        .post(format!("{endpoint}/internal/llm/mcp"))
        .query(&[("live", route)])
        .header("x-sortsys-live-forwarded", "1")
        .json(&body);
    for key in ["authorization", "mcp-protocol-version", "origin"] {
        if let Some(value) = headers.get(key) {
            call = call.header(key, value);
        }
    }
    let response = call.send().await.map_err(|_| unavailable())?;
    let status = response.status();
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| unavailable())?;
        if bytes.len().saturating_add(chunk.len()) > WIRE_LIMIT {
            return Err(invalid());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok((status, [("content-type", "application/json")], bytes).into_response())
}

fn allowed(ticket: &Ticket, path: &str) -> bool {
    ticket
        .queries
        .iter()
        .chain(&ticket.mutations)
        .any(|candidate| candidate == path)
}
fn definitions(ticket: &Ticket) -> Vec<Value> {
    let mut tools = super::super::mcp_tool_definitions(ticket.scope().expect("validated ticket"));
    if ticket.kind == LiveKind::Chat {
        tools.retain(|tool| match tool["name"].as_str().unwrap_or("") {
            "sortsys_find_procedures" | "sortsys_get_schema" => true,
            "sortsys_query" => !ticket.queries.is_empty(),
            "sortsys_propose_change" => !ticket.mutations.is_empty(),
            "sortsys_search" => ticket.queries.iter().any(|path| path == "products.list"),
            _ => false,
        });
        for tool in &mut tools {
            if tool["name"] == "sortsys_search" {
                tool["inputSchema"]["properties"]["resource"]["enum"] = json!(["products"]);
            }
            if tool["name"] == "sortsys_propose_change" {
                tool["inputSchema"]["properties"]["operations"]["items"]["properties"]["path"]["enum"] =
                    json!(ticket.mutations);
            }
        }
    }
    tools
}
async fn tool(session: &Session, name: &str, arguments: Value) -> RpcResult<Value> {
    let ticket = &session.ticket;
    if !definitions(ticket).iter().any(|tool| tool["name"] == name) {
        return Err(forbidden());
    }
    match name {
        "sortsys_find_procedures" => {
            let mut value = super::super::find_procedures(arguments)?;
            if let Some(procedures) = value["procedures"].as_array_mut() {
                procedures.retain(|procedure| {
                    procedure["path"]
                        .as_str()
                        .is_some_and(|path| allowed(ticket, path))
                });
            }
            Ok(value)
        }
        "sortsys_get_schema" => {
            if !arguments
                .get("path")
                .and_then(Value::as_str)
                .is_some_and(|path| allowed(ticket, path))
            {
                return Err(forbidden());
            }
            super::super::get_procedure_schema(arguments)
        }
        "sortsys_query" => {
            if !arguments
                .get("path")
                .and_then(Value::as_str)
                .is_some_and(|path| ticket.queries.iter().any(|p| p == path))
            {
                return Err(forbidden());
            }
            session.call(name, arguments).await
        }
        "sortsys_propose_change" => {
            let operations = arguments
                .get("operations")
                .and_then(Value::as_array)
                .filter(|ops| !ops.is_empty() && ops.len() <= 10)
                .ok_or_else(invalid)?;
            if operations.iter().any(|op| {
                !op.get("path")
                    .and_then(Value::as_str)
                    .is_some_and(|path| ticket.mutations.iter().any(|p| p == path))
            }) {
                return Err(forbidden());
            }
            session.call(name, arguments).await
        }
        "sortsys_search"
            if arguments.get("resource").and_then(Value::as_str) != Some("products") =>
        {
            Err(forbidden())
        }
        _ => session.call(name, arguments).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn discovery_and_dispatch_never_broaden_the_browser_capabilities() {
        let ticket = super::super::tests::ticket(LiveKind::Chat);
        let (outgoing, _calls) = mpsc::channel(8);
        let session = Session {
            closed: std::sync::atomic::AtomicBool::new(false),
            ticket,
            outgoing,
            pending: Mutex::new(HashMap::new()),
        };
        let found = tool(&session, "sortsys_find_procedures", json!({}))
            .await
            .unwrap();
        assert_eq!(
            found["procedures"],
            json!([{"path":"products.list","kind":"query"}])
        );
        for path in [
            "zerotrust.keys.get",
            "auth.sessionInfo",
            "projects.list",
            "products.priceRecords.list",
        ] {
            assert!(
                tool(&session, "sortsys_get_schema", json!({"path":path}))
                    .await
                    .is_err()
            );
            assert!(
                tool(&session, "sortsys_query", json!({"path":path}))
                    .await
                    .is_err()
            );
        }
        assert!(
            tool(
                &session,
                "sortsys_search",
                json!({"resource":"project_costs"})
            )
            .await
            .is_err()
        );
        assert!(
            tool(
                &session,
                "sortsys_propose_change",
                json!({"operations":[{"path":"products.create"}]})
            )
            .await
            .is_err()
        );
        let import = super::super::tests::ticket(LiveKind::DocumentImport);
        assert_eq!(
            definitions(&import)
                .iter()
                .map(|tool| tool["name"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["sortsys_search_products"]
        );
    }
}
