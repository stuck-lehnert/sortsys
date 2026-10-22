//! Authenticated JSON-RPC client for the application's Streamable HTTP MCP endpoint.

use reqwest::{Client, header::HeaderValue};
use serde_json::{Value, json};

use super::{MCP_REQUEST_TIMEOUT, ProviderError};

pub(super) struct McpClient<'a> {
    client: Client,
    url: &'a str,
    token: &'a str,
    protocol: &'static str,
    session: Option<HeaderValue>,
    next_id: u64,
}

impl<'a> McpClient<'a> {
    pub(super) async fn connect(url: &'a str, token: &'a str) -> Result<Self, ProviderError> {
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(MCP_REQUEST_TIMEOUT)
            .build()
            .map_err(ProviderError::transport)?;
        let mut connection = Self {
            client,
            url,
            token,
            protocol: "2025-06-18",
            session: None,
            next_id: 1,
        };

        let (initialized, session) = connection
            .request(
                "initialize",
                json!({
                    "protocolVersion": connection.protocol,
                    "capabilities": {},
                    "clientInfo": { "name": "sortsys-openrouter", "version": "1" }
                }),
            )
            .await?;

        connection.protocol = match initialized["protocolVersion"].as_str() {
            Some("2025-06-18") => "2025-06-18",
            Some("2025-03-26") => "2025-03-26",
            _ => return Err(failure("MCP server negotiated an unsupported protocol")),
        };

        if !initialized["capabilities"]["tools"].is_object() {
            return Err(failure("MCP server does not advertise tools"));
        }

        connection.session = session;
        let response = connection
            .post()
            .json(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }))
            .send()
            .await
            .map_err(ProviderError::transport)?;

        if response.status() != reqwest::StatusCode::ACCEPTED {
            return Err(failure(
                "MCP server did not accept the initialized notification",
            ));
        }

        connection.validate_session(response.headers())?;

        Ok(connection)
    }

    pub(super) async fn tools(&mut self) -> Result<Vec<Value>, ProviderError> {
        let (result, _) = self.request("tools/list", json!({})).await?;

        // The application's endpoint publishes its complete scoped catalogue in one page.
        if result
            .get("nextCursor")
            .is_some_and(|cursor| !cursor.is_null())
        {
            return Err(failure(
                "Unexpected pagination in the application MCP catalogue",
            ));
        }

        result["tools"]
            .as_array()
            .cloned()
            .ok_or_else(|| failure("MCP server returned an invalid tool catalogue"))
    }

    pub(super) async fn call(
        &mut self,
        name: &str,
        arguments: Value,
    ) -> Result<Value, ProviderError> {
        let (result, _) = self
            .request(
                "tools/call",
                json!({ "name": name, "arguments": arguments }),
            )
            .await?;

        if !result["content"].is_array()
            || result
                .get("isError")
                .is_some_and(|value| !value.is_boolean())
        {
            return Err(failure("MCP server returned an invalid tool result"));
        }

        // Preserve isError and structuredContent so the model can repair recoverable errors.
        Ok(result)
    }

    fn post(&self) -> reqwest::RequestBuilder {
        let request = self
            .client
            .post(self.url)
            .bearer_auth(self.token)
            .header("accept", "application/json, text/event-stream")
            .header("mcp-protocol-version", self.protocol);

        match &self.session {
            Some(session) => request.header("mcp-session-id", session),
            None => request,
        }
    }

    fn validate_session(&self, headers: &reqwest::header::HeaderMap) -> Result<(), ProviderError> {
        if self
            .session
            .as_ref()
            .zip(headers.get("mcp-session-id"))
            .is_some_and(|(expected, received)| expected != received)
        {
            return Err(failure("MCP server changed the initialized session id"));
        }

        Ok(())
    }

    async fn request(
        &mut self,
        method: &str,
        params: Value,
    ) -> Result<(Value, Option<HeaderValue>), ProviderError> {
        let id = self.next_id;
        self.next_id += 1;

        let response = self
            .post()
            .json(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }))
            .send()
            .await
            .map_err(ProviderError::transport)?;
        let status = response.status();

        if !status.is_success() {
            return Err(ProviderError {
                status: Some(status.as_u16()),
                message: format!("MCP {method} request failed (HTTP {})", status.as_u16()),
            });
        }

        self.validate_session(response.headers())?;

        let session = response.headers().get("mcp-session-id").cloned();
        let reply: Value = response
            .json()
            .await
            .map_err(|_| failure("MCP server returned invalid JSON"))?;

        if reply["jsonrpc"] != "2.0" || reply["id"] != id {
            return Err(failure("MCP server returned an invalid JSON-RPC envelope"));
        }

        if reply.get("error").is_some() {
            return Err(failure("MCP server rejected the JSON-RPC request"));
        }

        let result = reply
            .get("result")
            .filter(|result| result.is_object())
            .cloned()
            .ok_or_else(|| failure("MCP server omitted the JSON-RPC result"))?;

        Ok((result, session))
    }
}

fn failure(message: &str) -> ProviderError {
    ProviderError::transport(message)
}
