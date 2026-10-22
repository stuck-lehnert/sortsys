//! OpenRouter function-message adapter; tool discovery and execution stay on MCP.

use std::collections::HashSet;

use base64::Engine as _;
use serde_json::{Value, json};

use super::{
    DocumentScanInput, MCP_REQUEST_TIMEOUT, McpScope, ProviderConfiguration, ProviderError,
    RpcResult, SCAN_MAX_OUTPUT_TOKENS, STANDARD, ScanCompletion, TokenUsage,
    default_provider_base_url, endpoint, mcp::McpClient, require_answer, scan_input_text,
    scan_result_schema,
};

pub(super) async fn complete(
    configuration: &ProviderConfiguration,
    messages: Vec<Value>,
    prompt: &str,
    url: &str,
    token: &str,
    scope: McpScope,
) -> Result<(String, TokenUsage), ProviderError> {
    execute(
        configuration,
        body(configuration, messages, prompt),
        url,
        token,
        scope,
    )
    .await
}

pub(super) async fn scan(
    configuration: &ProviderConfiguration,
    input: &DocumentScanInput,
    prompt: &str,
    url: &str,
    token: &str,
) -> RpcResult<ScanCompletion> {
    let (content, usage) = execute(
        configuration,
        scan_body(configuration, input, prompt),
        url,
        token,
        McpScope::DocumentImport,
    )
    .await
    .map_err(ProviderError::into_rpc)?;

    Ok(ScanCompletion { content, usage })
}

fn body(configuration: &ProviderConfiguration, messages: Vec<Value>, prompt: &str) -> Value {
    let mut conversation = vec![json!({ "role": "system", "content": prompt })];
    conversation.extend(messages);

    json!({
        "model": configuration.model,
        "messages": conversation,
        "stream": false,
        "provider": { "require_parameters": true }
    })
}

fn scan_body(
    configuration: &ProviderConfiguration,
    input: &DocumentScanInput,
    prompt: &str,
) -> Value {
    let mut content = vec![json!({
        "type": "text",
        "text": scan_input_text(input, !input.originals.is_empty(), prompt)
    })];

    for original in &input.originals {
        let data = format!(
            "data:{};base64,{}",
            original.mime_type,
            STANDARD.encode(&original.bytes)
        );
        let part = if original.mime_type == "application/pdf" {
            json!({
                "type": "file",
                "file": { "filename": original.file_name, "file_data": data }
            })
        } else {
            json!({ "type": "image_url", "image_url": { "url": data, "detail": "high" } })
        };

        content.push(part);
    }

    let mut request = body(
        configuration,
        vec![json!({ "role": "user", "content": content })],
        prompt,
    );
    request["max_tokens"] = json!(SCAN_MAX_OUTPUT_TOKENS);
    request["response_format"] = json!({
        "type": "json_schema",
        "json_schema": {
            "name": "document_scan", "strict": true, "schema": scan_result_schema()
        }
    });

    request
}

async fn execute(
    configuration: &ProviderConfiguration,
    body: Value,
    url: &str,
    token: &str,
    scope: McpScope,
) -> Result<(String, TokenUsage), ProviderError> {
    tokio::time::timeout(
        MCP_REQUEST_TIMEOUT,
        conversation(configuration, body, url, token, scope),
    )
    .await
    .map_err(|_| failure("OpenRouter MCP request timed out"))?
}

async fn conversation(
    configuration: &ProviderConfiguration,
    mut body: Value,
    url: &str,
    token: &str,
    scope: McpScope,
) -> Result<(String, TokenUsage), ProviderError> {
    let mut mcp = McpClient::connect(url, token).await?;
    let tools = function_tools(mcp.tools().await?, scope)?;
    let names = tools
        .iter()
        .filter_map(|tool| tool["function"]["name"].as_str().map(str::to_owned))
        .collect::<HashSet<_>>();
    body["tools"] = json!(tools);

    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(ProviderError::transport)?;
    let endpoint = endpoint(
        configuration
            .base_url
            .as_deref()
            .unwrap_or_else(|| default_provider_base_url("openrouter")),
        "v1/chat/completions",
    );
    let mut usage = TokenUsage::default();
    let mut seen_ids = HashSet::new();

    loop {
        let response = client
            .post(&endpoint)
            .bearer_auth(&configuration.api_key)
            .json(&body)
            .send()
            .await
            .map_err(ProviderError::transport)?;
        let value = super::checked_json(response).await?;

        if value.get("error").is_some() {
            return Err(failure(&super::provider_error_message(&value.to_string())));
        }

        add_usage(&mut usage, &value["usage"])?;
        let choice = &value["choices"][0];
        let message = &choice["message"];

        if message["role"] != "assistant" {
            return Err(failure("OpenRouter returned an invalid assistant message"));
        }

        let calls = validated_calls(message, &names, &mut seen_ids)?;

        if calls.is_empty() {
            if choice["finish_reason"] != "stop" {
                return Err(failure("OpenRouter did not finish the answer"));
            }

            let answer = message["content"].as_str().unwrap_or_default().to_owned();

            return Ok((require_answer(answer)?, usage));
        }

        if choice["finish_reason"] != "tool_calls" {
            return Err(failure("OpenRouter returned incomplete tool calls"));
        }

        let messages = body["messages"]
            .as_array_mut()
            .ok_or_else(|| failure("OpenRouter conversation is invalid"))?;

        // Keep reasoning_details and annotations intact across tool continuations.
        messages.push(message.clone());

        for call in calls {
            let result = mcp.call(&call.name, call.arguments).await?;
            messages.push(json!({
                "role": "tool",
                "tool_call_id": call.id,
                "content": result.to_string()
            }));
        }
    }
}

fn function_tools(tools: Vec<Value>, scope: McpScope) -> Result<Vec<Value>, ProviderError> {
    let mut functions = Vec::new();
    let mut names = HashSet::new();

    for tool in tools {
        let name = tool["name"]
            .as_str()
            .filter(|name| {
                !name.is_empty()
                    && name.len() <= 64
                    && name
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
            })
            .ok_or_else(|| failure("MCP server advertised an invalid tool name"))?;

        if !names.insert(name.to_owned()) || tool["inputSchema"]["type"] != "object" {
            return Err(failure("MCP server advertised an invalid tool definition"));
        }

        if matches!(scope, McpScope::DocumentImport) && name != "sortsys_search_products" {
            continue;
        }

        functions.push(json!({
            "type": "function",
            "function": {
                "name": name,
                "description": tool["description"].as_str().unwrap_or_default(),
                "parameters": tool["inputSchema"]
            }
        }));
    }

    if functions.is_empty() {
        return Err(failure("MCP server advertised no tools for this use case"));
    }

    Ok(functions)
}

struct ToolCall {
    id: String,
    name: String,
    arguments: Value,
}

fn validated_calls(
    message: &Value,
    names: &HashSet<String>,
    seen_ids: &mut HashSet<String>,
) -> Result<Vec<ToolCall>, ProviderError> {
    let Some(raw) = message.get("tool_calls").filter(|value| !value.is_null()) else {
        return Ok(Vec::new());
    };

    let calls = raw
        .as_array()
        .ok_or_else(|| failure("OpenRouter returned invalid tool calls"))?;
    let mut validated = Vec::new();

    // Validate the entire batch before any MCP call can create a proposal.
    for call in calls {
        let id = call["id"]
            .as_str()
            .filter(|id| !id.is_empty())
            .ok_or_else(|| failure("OpenRouter tool call has no id"))?;
        let name = call["function"]["name"]
            .as_str()
            .filter(|name| names.contains(*name))
            .ok_or_else(|| failure("OpenRouter requested an unadvertised MCP tool"))?;

        if call["type"] != "function" || !seen_ids.insert(id.to_owned()) {
            return Err(failure(
                "OpenRouter returned an invalid or repeated tool call",
            ));
        }

        let arguments = call["function"]["arguments"]
            .as_str()
            .and_then(|encoded| serde_json::from_str::<Value>(encoded).ok())
            .filter(Value::is_object)
            .ok_or_else(|| failure("OpenRouter tool arguments must be a JSON object"))?;
        validated.push(ToolCall {
            id: id.to_owned(),
            name: name.to_owned(),
            arguments,
        });
    }

    Ok(validated)
}

fn add_usage(usage: &mut TokenUsage, value: &Value) -> Result<(), ProviderError> {
    let read = |field| match value.get(field) {
        None | Some(Value::Null) => Ok(0),
        Some(count) => count
            .as_i64()
            .filter(|count| *count >= 0)
            .ok_or_else(|| failure("OpenRouter returned invalid token usage")),
    };

    let input = read("prompt_tokens")?;
    let output = read("completion_tokens")?;
    let total = if value
        .get("total_tokens")
        .is_some_and(|count| !count.is_null())
    {
        read("total_tokens")?
    } else {
        input.saturating_add(output)
    };

    usage.input_tokens = usage.input_tokens.saturating_add(input);
    usage.output_tokens = usage.output_tokens.saturating_add(output);
    usage.total_tokens = usage.total_tokens.saturating_add(total);

    Ok(())
}

fn failure(message: &str) -> ProviderError {
    ProviderError::transport(message)
}

#[cfg(test)]
mod tests;
