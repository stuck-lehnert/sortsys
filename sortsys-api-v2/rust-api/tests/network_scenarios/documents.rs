//! Real HTTP-MCP document permission, full-text search, and text-page coverage.

use super::*;

pub(super) const ACCESS_PROBE: &str = "Check document access.";

const QUERY: &str = "Brandschutzfreigabe";
const TEXT: &str =
    "Ä🔧水\nBrandschutzfreigabe für die Wärmedämmung.\nPrüfung im Bauabschnitt Nord.";

pub(super) async fn verify(
    rpc: &RpcClient,
    fixture: &Fixture,
    admin_token: &str,
    requests: &OpenAiRequestLog,
) {
    let visible = create_project(rpc, admin_token, "MCP document project").await;
    let hidden = create_project(rpc, admin_token, "Confidential MCP project").await;
    let member: i64 = sqlx::query_scalar(
        "INSERT INTO users (username, first_name, password, deactivated_at) \
         VALUES ('document.reader', 'Document Reader', $1, NULL) RETURNING id",
    )
    .bind(hash(&fixture.admin_password, 4).unwrap())
    .fetch_one(&fixture.tenant_pool)
    .await
    .unwrap();

    sqlx::query("INSERT INTO user_role_assignments (user_id, role_name) VALUES ($1, ':llm')")
        .bind(member)
        .execute(&fixture.tenant_pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO project_user_assignments (project_id, user_id, type) \
         VALUES ($1, $2, 'member')",
    )
    .bind(visible.0)
    .bind(member)
    .execute(&fixture.tenant_pool)
    .await
    .unwrap();

    let login = rpc
        .mutation(
            "auth.login",
            json!({
                "tenant": fixture.tenant,
                "username": "document.reader",
                "password": fixture.admin_password,
            }),
            None,
        )
        .await;
    let normal = login["token"].as_str().unwrap();
    let chat = rpc
        .mutation("llm.chats.create", json!({}), Some(normal))
        .await;

    rpc.mutation(
        "llm.messages.send",
        json!({ "chatId": chat["id"], "content": ACCESS_PROBE }),
        Some(normal),
    )
    .await;

    let (token, import_token) = recorded_tokens(requests).await;
    let mut files = Vec::new();

    for index in 0..27 {
        files.push(
            insert_document(
                &fixture.tenant_pool,
                visible,
                &format!("inspection-{index}.pdf"),
                TEXT,
            )
            .await,
        );
    }

    let private = insert_document(
        &fixture.tenant_pool,
        hidden,
        "Confidential-prices.pdf",
        "Brandschutzfreigabe SecretMargin",
    )
    .await;

    verify_scope(rpc, normal, &token, &import_token, files[0]).await;
    verify_search(rpc, normal, &token, visible, hidden).await;
    verify_text(rpc, &token, visible, files[0]).await;
    verify_other_tenant(rpc, &token, visible, files[0]).await;
    verify_file_lifecycle(rpc, &token, &fixture.tenant_pool, &files).await;

    denied(
        call(
            rpc,
            &token,
            "sortsys_read_document",
            json!({ "fileId": private }),
        )
        .await,
        "FORBIDDEN",
    );

    verify_extraction(rpc, &token, &fixture.tenant_pool, files[0]).await;
    verify_revocation(rpc, &token, &fixture.tenant_pool, member, files[0], private).await;
    verify_session_expiry(rpc, &token, &fixture.tenant_pool, member).await;
}

async fn create_project(rpc: &RpcClient, token: &str, title: &str) -> Id {
    let created = rpc
        .mutation("projects.create", json!({ "title": title }), Some(token))
        .await;

    Id::decode(created["id"].as_str().unwrap()).unwrap()
}

async fn insert_document(pool: &PgPool, project: Id, name: &str, text: &str) -> Id {
    // Synthetic extracted text tests MCP; the existing file scenario covers real PDF OCR.
    let id = sqlx::query_scalar(
        r#"
        INSERT INTO project_files (
            project_id, storage_bucket, object_key, file_name, mime_type, kind, status,
            text_extraction_status, extracted_text, text_extraction_version,
            text_extraction_method, text_extraction_page_count, text_extracted_at
        ) VALUES (
            $1, 'fixture-only', $2, $3, 'application/pdf', 'file', 'uploaded',
            'ready', $4, 1, 'embedded_pdf_text', 2, NOW()
        ) RETURNING id
        "#,
    )
    .bind(project.0)
    .bind(format!("mcp-document-fixture/{}", unique_suffix()))
    .bind(name)
    .bind(text)
    .fetch_one(pool)
    .await
    .unwrap();

    Id(id)
}

async fn recorded_tokens(requests: &OpenAiRequestLog) -> (String, String) {
    let requests = requests.lock().await;
    let chat = requests
        .iter()
        .rev()
        .find(|request| {
            request["input"].as_array().is_some_and(|input| {
                input
                    .iter()
                    .any(|turn| turn["role"] == "user" && turn["content"] == ACCESS_PROBE)
            })
        })
        .expect("the normal message API must reach the native MCP provider");
    let import = requests
        .iter()
        .find(|request| request.pointer("/text/format/name") == Some(&json!("document_scan")))
        .expect("the preceding real scan must issue an import MCP delegation");

    // Keep the real application-issued tokens opaque and unmodified.
    let token = chat["tools"][0]["authorization"]
        .as_str()
        .unwrap()
        .to_owned();
    let import_token = import["tools"][0]["authorization"]
        .as_str()
        .unwrap()
        .to_owned();

    (token, import_token)
}

async fn request(
    rpc: &RpcClient,
    token: &str,
    method: &str,
    params: Value,
) -> (reqwest::StatusCode, Value) {
    let response = rpc
        .http
        .post(format!("{}/internal/llm/mcp", rpc.base_url))
        .bearer_auth(token)
        .header("mcp-protocol-version", "2025-06-18")
        .json(&json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params }))
        .send()
        .await
        .unwrap();
    let status = response.status();

    let body = response.json().await.unwrap();

    (status, body)
}

async fn call(rpc: &RpcClient, token: &str, name: &str, arguments: Value) -> Value {
    let (status, body) = request(
        rpc,
        token,
        "tools/call",
        json!({ "name": name, "arguments": arguments }),
    )
    .await;

    assert_eq!(status, reqwest::StatusCode::OK);
    assert!(body.get("error").is_none(), "MCP request failed: {body}");

    body["result"].clone()
}

fn data(result: Value) -> Value {
    assert_ne!(result["isError"], true, "MCP tool failed: {result}");
    assert!(result["structuredContent"].is_object());

    result["structuredContent"].clone()
}

fn denied(result: Value, code: &str) {
    assert_eq!(result["isError"], true);
    assert!(
        result["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains(code)
    );
    assert!(result.get("structuredContent").is_none());
    assert!(!result.to_string().contains("Confidential"));
}

async fn verify_scope(rpc: &RpcClient, normal: &str, token: &str, import: &str, file: Id) {
    let (_, listed) = request(rpc, token, "tools/list", json!({})).await;

    let tools = listed["result"]["tools"].as_array().unwrap();

    for name in ["sortsys_search_documents", "sortsys_read_document"] {
        assert!(tools.iter().any(|tool| tool["name"] == name));
    }

    let (status, _) = request(rpc, normal, "tools/list", json!({})).await;

    assert_eq!(status, reqwest::StatusCode::UNAUTHORIZED);

    let (_, listed) = request(rpc, import, "tools/list", json!({})).await;

    let tools = listed["result"]["tools"].as_array().unwrap();

    assert_eq!(tools.len(), 1);
    assert_eq!(tools[0]["name"], "sortsys_search_products");

    for name in ["sortsys_search_documents", "sortsys_read_document"] {
        denied(
            call(rpc, import, name, json!({ "fileId": file })).await,
            "FORBIDDEN",
        );
    }
}

async fn verify_search(rpc: &RpcClient, normal: &str, token: &str, visible: Id, hidden: Id) {
    let first = data(
        call(
            rpc,
            token,
            "sortsys_search_documents",
            json!({ "query": QUERY, "limit": 25 }),
        )
        .await,
    );
    let second = data(
        call(
            rpc,
            token,
            "sortsys_search_documents",
            json!({ "query": QUERY, "limit": 25, "offset": first["nextOffset"] }),
        )
        .await,
    );

    assert_eq!(first["documents"].as_array().unwrap().len(), 25);
    assert_eq!(first["hasMore"], true);
    assert_eq!(first["nextOffset"], 25);
    assert_eq!(second["documents"].as_array().unwrap().len(), 2);
    assert_eq!(second["hasMore"], false);
    assert_eq!(second["nextOffset"], Value::Null);

    let ordinary = rpc
        .query(
            "projects.files.search",
            json!({ "query": QUERY, "limit": 100 }),
            Some(normal),
        )
        .await;
    let mut ids = Vec::new();

    for page in [&first, &second] {
        for row in page["documents"].as_array().unwrap() {
            ids.push(row["id"].clone());
            assert_eq!(row["projectId"], json!(visible));
            assert!(row["excerpt"].as_str().unwrap().contains("<<"));
            assert!(row["sourceUrl"].as_str().unwrap().starts_with("/projects/"));
            assert!(row.get("objectKey").is_none());
            assert!(row.get("downloadUrl").is_none());
            assert!(!row.to_string().contains("Confidential"));
        }
    }

    let ordinary_ids = ordinary
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["id"].clone())
        .collect::<Vec<_>>();

    assert_eq!(ids, ordinary_ids);

    let filtered = data(
        call(
            rpc,
            token,
            "sortsys_search_documents",
            json!({ "query": QUERY, "projectId": hidden }),
        )
        .await,
    );

    assert_eq!(filtered["documents"], json!([]));
}

async fn verify_text(rpc: &RpcClient, token: &str, project: Id, file: Id) {
    let mut offset = json!(0);
    let mut revision = Value::Null;
    let mut text = String::new();

    loop {
        let output = data(
            call(
                rpc,
                token,
                "sortsys_read_document",
                json!({
                    "fileId": file, "offset": offset, "limit": 7, "revision": revision,
                }),
            )
            .await,
        );
        let page = output["text"].as_str().unwrap();

        assert!(page.chars().count() <= 7);
        assert_eq!(output["totalCharacters"], TEXT.chars().count());
        assert_eq!(output["pageCount"], 2);
        assert_eq!(output["contentAvailable"], true);
        assert_eq!(
            output["sourceUrl"],
            format!(
                "/projects/{}/files?file={}",
                project.encode(),
                file.encode()
            )
        );
        assert!(output.get("objectKey").is_none());

        text.push_str(page);
        revision = output["revision"].clone();
        offset = output["nextOffset"].clone();

        if offset.is_null() {
            break;
        }
    }

    assert_eq!(text, TEXT);
}

async fn verify_extraction(rpc: &RpcClient, token: &str, pool: &PgPool, file: Id) {
    let original = data(
        call(
            rpc,
            token,
            "sortsys_read_document",
            json!({ "fileId": file }),
        )
        .await,
    );

    for status in [
        "pending",
        "queued",
        "processing",
        "failed",
        "not_applicable",
        "ready",
    ] {
        sqlx::query(
            "UPDATE project_files SET text_extraction_status = $2, extracted_text = 'StaleSecret', \
             text_extraction_version = 0, text_extraction_error = 'PrivateStorageDetails', \
             text_extracted_at = NOW() WHERE id = $1",
        )
        .bind(file.0)
        .bind(status)
        .execute(pool)
        .await
        .unwrap();

        let output = data(
            call(
                rpc,
                token,
                "sortsys_read_document",
                json!({ "fileId": file }),
            )
            .await,
        );

        assert_eq!(output["contentAvailable"], false);
        assert_eq!(output["text"], Value::Null);
        assert_eq!(output["totalCharacters"], Value::Null);
        assert!(!output.to_string().contains("StaleSecret"));
        assert!(!output.to_string().contains("PrivateStorageDetails"));
    }

    sqlx::query(
        "UPDATE project_files SET text_extraction_status = 'ready', extracted_text = '', \
        text_extraction_version = office_version, text_extracted_at = NOW() WHERE id = $1",
    )
    .bind(file.0)
    .execute(pool)
    .await
    .unwrap();

    let empty = data(
        call(
            rpc,
            token,
            "sortsys_read_document",
            json!({ "fileId": file }),
        )
        .await,
    );

    assert_eq!(empty["contentAvailable"], true);
    assert_eq!(empty["text"], "");
    assert_eq!(empty["totalCharacters"], 0);

    denied(
        call(
            rpc,
            token,
            "sortsys_read_document",
            json!({
                "fileId": file, "offset": 1, "revision": original["revision"],
            }),
        )
        .await,
        "CONFLICT",
    );
}

async fn verify_revocation(
    rpc: &RpcClient,
    token: &str,
    pool: &PgPool,
    member: i64,
    file: Id,
    private: Id,
) {
    sqlx::query("DELETE FROM project_user_assignments WHERE user_id = $1")
        .bind(member)
        .execute(pool)
        .await
        .unwrap();

    denied(
        call(
            rpc,
            token,
            "sortsys_read_document",
            json!({ "fileId": file }),
        )
        .await,
        "FORBIDDEN",
    );

    let search = data(
        call(
            rpc,
            token,
            "sortsys_search_documents",
            json!({ "query": QUERY }),
        )
        .await,
    );

    assert_eq!(search["documents"], json!([]));

    for role in ["view:projects", "manage:projects"] {
        sqlx::query("INSERT INTO user_role_assignments (user_id, role_name) VALUES ($1, $2)")
            .bind(member)
            .bind(role)
            .execute(pool)
            .await
            .unwrap();

        let allowed = data(
            call(
                rpc,
                token,
                "sortsys_read_document",
                json!({ "fileId": private }),
            )
            .await,
        );

        assert_eq!(allowed["contentAvailable"], true);
        assert!(allowed["text"].as_str().unwrap().contains("SecretMargin"));

        sqlx::query("DELETE FROM user_role_assignments WHERE user_id = $1 AND role_name = $2")
            .bind(member)
            .bind(role)
            .execute(pool)
            .await
            .unwrap();
    }

    sqlx::query("DELETE FROM user_role_assignments WHERE user_id = $1 AND role_name = ':llm'")
        .bind(member)
        .execute(pool)
        .await
        .unwrap();

    let (status, _) = request(rpc, token, "tools/list", json!({})).await;

    assert_eq!(status, reqwest::StatusCode::FORBIDDEN);

    sqlx::query("INSERT INTO user_role_assignments (user_id, role_name) VALUES ($1, ':llm')")
        .bind(member)
        .execute(pool)
        .await
        .unwrap();
}

async fn verify_session_expiry(rpc: &RpcClient, token: &str, pool: &PgPool, member: i64) {
    let mut sessions: Vec<(i64, chrono::DateTime<chrono::Utc>)> =
        sqlx::query_as("SELECT id, expires_at FROM user_sessions WHERE user_id = $1")
            .bind(member)
            .fetch_all(pool)
            .await
            .unwrap();

    assert_eq!(
        sessions.len(),
        1,
        "the new reader must have exactly one test session"
    );

    let (session, original_expiry) = sessions.pop().unwrap();

    sqlx::query(
        "UPDATE user_sessions SET expires_at = NOW() - INTERVAL '1 second' \
         WHERE id = $1 AND user_id = $2",
    )
    .bind(session)
    .bind(member)
    .execute(pool)
    .await
    .unwrap();

    let (status, _) = request(rpc, token, "tools/list", json!({})).await;

    // Restore only this newly created session before asserting the response.
    sqlx::query("UPDATE user_sessions SET expires_at = $3 WHERE id = $1 AND user_id = $2")
        .bind(session)
        .bind(member)
        .bind(original_expiry)
        .execute(pool)
        .await
        .unwrap();

    assert_eq!(status, reqwest::StatusCode::UNAUTHORIZED);
}

async fn verify_other_tenant(rpc: &RpcClient, token: &str, visible: Id, file: Id) {
    let other = Fixture::create(&TestEnvironment::from_env().unwrap()).await;
    let login = rpc
        .mutation(
            "auth.login",
            json!({
                "tenant": other.tenant,
                "username": other.admin_username,
                "password": other.admin_password,
            }),
            None,
        )
        .await;
    let project = create_project(
        rpc,
        login["token"].as_str().unwrap(),
        "Other tenant project",
    )
    .await;

    // Deliberately collide IDs across tenants: IDs are not globally unique authorization.
    sqlx::query(
        r#"
        INSERT INTO project_files (
            id, project_id, storage_bucket, object_key, file_name, mime_type, kind, status,
            text_extraction_status, extracted_text, text_extraction_version, text_extracted_at
        ) VALUES (
            $1, $2, 'fixture-only', $3, 'Foreign-secret.pdf', 'application/pdf', 'file',
            'uploaded', 'ready', 'ForeignNeedle', 1, NOW()
        )
        "#,
    )
    .bind(file.0)
    .bind(project.0)
    .bind(format!("mcp-foreign-fixture/{}", unique_suffix()))
    .execute(&other.tenant_pool)
    .await
    .unwrap();

    let read = data(
        call(
            rpc,
            token,
            "sortsys_read_document",
            json!({ "fileId": file }),
        )
        .await,
    );

    assert_eq!(read["text"], TEXT);
    assert_eq!(read["projectId"], json!(visible));
    assert_eq!(read["fileName"], "inspection-0.pdf");
    assert!(!read.to_string().contains("ForeignNeedle"));

    let search = data(
        call(
            rpc,
            token,
            "sortsys_search_documents",
            json!({ "query": "ForeignNeedle" }),
        )
        .await,
    );

    assert_eq!(search["documents"], json!([]));

    other.tenant_pool.close().await;
}

async fn verify_file_lifecycle(rpc: &RpcClient, token: &str, pool: &PgPool, files: &[Id]) {
    sqlx::query("UPDATE project_files SET status = 'pending' WHERE id = $1")
        .bind(files[1].0)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM project_files WHERE id = $1")
        .bind(files[2].0)
        .execute(pool)
        .await
        .unwrap();

    for file in &files[1..3] {
        denied(
            call(
                rpc,
                token,
                "sortsys_read_document",
                json!({ "fileId": file }),
            )
            .await,
            "NOT_FOUND",
        );
    }
}
