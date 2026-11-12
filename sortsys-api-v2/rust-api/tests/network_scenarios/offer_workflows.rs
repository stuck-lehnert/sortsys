use super::*;

#[tokio::test]
async fn direct_projects_and_safe_offer_deletion() {
    let Some(environment) = TestEnvironment::from_env() else {
        return;
    };
    let fixture = Fixture::create(&environment).await;
    let rpc = RpcClient::new(environment.api_base_url.clone());
    let login = rpc.mutation("auth.login", json!({"tenant":fixture.tenant,"username":fixture.admin_username,"password":fixture.admin_password}), None).await;
    let token = login["token"].as_str().unwrap();
    let customer = rpc
        .mutation(
            "customers.create",
            json!({"name":"Direct project customer"}),
            Some(token),
        )
        .await;

    // A normal project requires no offer and keeps the supplied customer.
    let project = rpc
        .mutation(
            "projects.create",
            json!({"title":"Direct project without offer","customerId":customer["id"]}),
            Some(token),
        )
        .await;
    let loaded = rpc
        .query("projects.get", json!({"id":project["id"]}), Some(token))
        .await;
    assert_eq!(loaded["title"], "Direct project without offer");
    assert_eq!(loaded["customerId"], customer["id"]);
    let cases = rpc
        .query(
            "commercial.cases.list",
            json!({"projectId":project["id"]}),
            Some(token),
        )
        .await;
    assert!(cases.as_array().unwrap().is_empty());

    let offer = rpc
        .mutation(
            "commercial.cases.create",
            json!({"kind":"offer","title":"Deletable offer","customerId":customer["id"]}),
            Some(token),
        )
        .await;
    let id = &offer["id"];
    let detail = rpc
        .query("commercial.cases.get", json!({"id":id}), Some(token))
        .await;
    let original_number = detail["case"]["reference"].clone();
    let inquiry = rpc.mutation("commercial.documents.create", json!({"caseId":id,"purpose":"inquiry","fileName":"Inquiry.x83","xml":"<GAEB>Inquiry</GAEB>","readOnly":true}), Some(token)).await;
    let priced = rpc.mutation("commercial.documents.create", json!({"caseId":id,"purpose":"offer","fileName":"Offer.x84","xml":"<GAEB>Priced offer</GAEB>","readOnly":false,"netAmount":"125.00","sourceDocumentId":inquiry["id"],"sourceVersion":1}), Some(token)).await;
    let numeric_id = Id::decode(id.as_str().unwrap()).unwrap().0;
    sqlx::query("INSERT INTO commercial_document_snapshots(document_id,version,object_key,event) SELECT id,version,object_key,'test' FROM commercial_documents WHERE case_id=$1 ON CONFLICT(document_id,version) DO NOTHING")
        .bind(numeric_id).execute(&fixture.tenant_pool).await.unwrap();
    sqlx::query("UPDATE commercial_cases SET selected_offer_document_id=$2 WHERE id=$1")
        .bind(numeric_id)
        .bind(Id::decode(priced["id"].as_str().unwrap()).unwrap().0)
        .execute(&fixture.tenant_pool)
        .await
        .unwrap();

    rpc.expect_error(
        "commercial.cases.delete",
        Method::POST,
        json!({"id":id}),
        None,
        "UNAUTHORIZED",
    )
    .await;
    let reader_id: i64 = sqlx::query_scalar("INSERT INTO users(username,first_name,password,deactivated_at) VALUES('offer.reader','Reader',$1,NULL) RETURNING id")
        .bind(hash("Reader-Password-123!",4).unwrap()).fetch_one(&fixture.tenant_pool).await.unwrap();
    sqlx::query("INSERT INTO user_role_assignments(user_id,role_name) VALUES($1,'view:projects')")
        .bind(reader_id)
        .execute(&fixture.tenant_pool)
        .await
        .unwrap();
    let reader_login = rpc.mutation("auth.login", json!({"tenant":fixture.tenant,"username":"offer.reader","password":"Reader-Password-123!"}), None).await;
    rpc.expect_error(
        "commercial.cases.delete",
        Method::POST,
        json!({"id":id}),
        reader_login["token"].as_str(),
        "FORBIDDEN",
    )
    .await;

    rpc.mutation("commercial.cases.delete", json!({"id":id}), Some(token))
        .await;
    rpc.expect_error(
        "commercial.cases.get",
        Method::GET,
        json!({"id":id}),
        Some(token),
        "NOT_FOUND",
    )
    .await;
    let remaining: i64 = sqlx::query_scalar("SELECT (SELECT COUNT(*) FROM commercial_documents WHERE case_id=$1)+(SELECT COUNT(*) FROM commercial_case_events WHERE case_id=$1)")
        .bind(numeric_id).fetch_one(&fixture.tenant_pool).await.unwrap();
    assert_eq!(remaining, 0);
    let snapshots: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM commercial_document_snapshots")
        .fetch_one(&fixture.tenant_pool)
        .await
        .unwrap();
    assert_eq!(snapshots, 0);
    rpc.mutation(
        "settings.offerNumbering.set",
        json!({"scheme":"sequential","startNumber":"1"}),
        Some(token),
    )
    .await;
    let next = rpc
        .mutation(
            "commercial.cases.create",
            json!({"kind":"offer","title":"Next offer"}),
            Some(token),
        )
        .await;
    let next_detail = rpc
        .query(
            "commercial.cases.get",
            json!({"id":next["id"]}),
            Some(token),
        )
        .await;
    assert_ne!(next_detail["case"]["reference"], original_number);

    // A dependent alternative protects its parent; deleting the leaf is safe.
    let alternative = rpc
        .mutation(
            "commercial.cases.create",
            json!({"kind":"alternative","title":"Dependent alternative","parentCaseId":next["id"]}),
            Some(token),
        )
        .await;
    rpc.expect_error(
        "commercial.cases.delete",
        Method::POST,
        json!({"id":next["id"]}),
        Some(token),
        "CONFLICT",
    )
    .await;
    rpc.mutation(
        "commercial.cases.delete",
        json!({"id":alternative["id"]}),
        Some(token),
    )
    .await;

    // Linked projects and non-offer workflows must never be deleted.
    let protected = rpc
        .mutation(
            "commercial.cases.create",
            json!({"kind":"offer","title":"Project-linked offer"}),
            Some(token),
        )
        .await;
    sqlx::query("UPDATE commercial_cases SET project_id=$2 WHERE id=$1")
        .bind(Id::decode(protected["id"].as_str().unwrap()).unwrap().0)
        .bind(Id::decode(project["id"].as_str().unwrap()).unwrap().0)
        .execute(&fixture.tenant_pool)
        .await
        .unwrap();
    rpc.expect_error(
        "commercial.cases.delete",
        Method::POST,
        json!({"id":protected["id"]}),
        Some(token),
        "CONFLICT",
    )
    .await;
    let variation = rpc
        .mutation(
            "commercial.cases.create",
            json!({"kind":"variation","title":"Protected project variation","projectId":project["id"]}),
            Some(token),
        )
        .await;
    rpc.expect_error(
        "commercial.cases.delete",
        Method::POST,
        json!({"id":variation["id"]}),
        Some(token),
        "CONFLICT",
    )
    .await;
    assert_eq!(
        rpc.query("projects.get", json!({"id":project["id"]}), Some(token))
            .await["title"],
        "Direct project without offer"
    );
}
