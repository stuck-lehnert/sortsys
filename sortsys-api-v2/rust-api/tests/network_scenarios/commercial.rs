use super::*;

async fn create_case(rpc: &RpcClient, token: &str, input: Value) -> Value {
    rpc.mutation("commercial.cases.create", input, Some(token))
        .await["id"]
        .clone()
}
async fn document(
    rpc: &RpcClient,
    token: &str,
    case: &Value,
    purpose: &str,
    amount: Option<&str>,
    source: Option<(&Value, i64)>,
) -> Value {
    let phase = match purpose {
        "inquiry" => "83",
        "offer" => "84",
        "order" => "86",
        "confirmation" => "87",
        _ => "31",
    };
    // Format validation and derivation are exercised in the real browser suite.
    // This server deliberately transports opaque XML and exact revisions.
    let mut input = json!({"caseId":case,"purpose":purpose,"fileName":format!("Native.x{phase}"),"xml":"<GAEB extra=\"Grüße\"><!--preserve--><vendor:data xmlns:vendor=\"urn:fixture\"/></GAEB>","readOnly":false,"netAmount":amount,"partnerName":if purpose=="offer" {Some("Subcontractor")} else {None}});
    if let Some((id, version)) = source {
        input["sourceDocumentId"] = id.clone();
        input["sourceVersion"] = json!(version);
    }
    rpc.mutation("commercial.documents.create", input, Some(token))
        .await["id"]
        .clone()
}
async fn transition(rpc: &RpcClient, token: &str, id: &Value, from: &str, to: &str) {
    rpc.mutation(
        "commercial.cases.transition",
        json!({"id":id,"expectedStatus":from,"status":to}),
        Some(token),
    )
    .await;
}

#[tokio::test]
async fn offer_numbering_settings_and_sales_creation_are_durable_and_independent() {
    let Some(environment) = TestEnvironment::from_env() else {
        return;
    };
    let fixture = Fixture::create(&environment).await;
    let rpc = RpcClient::new(environment.api_base_url.clone());
    let login = rpc.mutation("auth.login", json!({"tenant":fixture.tenant,"username":fixture.admin_username,"password":fixture.admin_password}), None).await;
    let token = login["token"].as_str().unwrap();
    let default = json!({"scheme":"sequential","startNumber":"1"});
    assert_eq!(
        rpc.query("settings.offerNumbering.get", Value::Null, Some(token))
            .await,
        default
    );
    for (procedure, method, input) in [
        ("settings.offerNumbering.get", Method::GET, Value::Null),
        ("settings.offerNumbering.set", Method::POST, default.clone()),
    ] {
        rpc.expect_error(procedure, method, input, None, "UNAUTHORIZED")
            .await;
    }
    for invalid in ["0", "-1", "+1", "1.5", "1e3", "9223372036854775808", ""] {
        rpc.expect_error(
            "settings.offerNumbering.set",
            Method::POST,
            json!({"scheme":"sequential","startNumber":invalid}),
            Some(token),
            "BAD_REQUEST",
        )
        .await;
    }
    for scheme in ["projectLocal", "projectGlobal", "unknown"] {
        rpc.expect_error(
            "settings.offerNumbering.set",
            Method::POST,
            json!({"scheme":scheme,"startNumber":"1"}),
            Some(token),
            "BAD_REQUEST",
        )
        .await;
    }
    sqlx::query("INSERT INTO users(username,first_name,password,deactivated_at) VALUES('numbering.reader','Reader',$1,NULL)")
        .bind(hash("Reader-Password-123!", 4).unwrap()).execute(&fixture.tenant_pool).await.unwrap();
    let reader = rpc.mutation("auth.login", json!({"tenant":fixture.tenant,"username":"numbering.reader","password":"Reader-Password-123!"}), None).await;
    for (procedure, method, input) in [
        ("settings.offerNumbering.get", Method::GET, Value::Null),
        ("settings.offerNumbering.set", Method::POST, default.clone()),
    ] {
        rpc.expect_error(
            procedure,
            method,
            input,
            reader["token"].as_str(),
            "FORBIDDEN",
        )
        .await;
    }

    let legacy: i64 = sqlx::query_scalar("INSERT INTO commercial_cases(reference,kind,title) VALUES('ANG-2026-000123','offer','Historical') RETURNING id")
        .fetch_one(&fixture.tenant_pool).await.unwrap();
    let main = create_case(&rpc, token, json!({"kind":"offer","title":"Main offer"})).await;
    let alternative = create_case(
        &rpc,
        token,
        json!({"kind":"alternative","title":"Alternative","parentCaseId":main}),
    )
    .await;
    for (id, reference) in [(&main, "1"), (&alternative, "2")] {
        let detail = rpc
            .query("commercial.cases.get", json!({"id":id}), Some(token))
            .await;
        assert_eq!(detail["case"]["reference"], reference);
    }
    // Deletion must not release a number; the numbering registry has no case FK.
    let alternative_id = Id::decode(alternative.as_str().unwrap()).unwrap().0;
    sqlx::query("DELETE FROM commercial_case_events WHERE case_id=$1")
        .bind(alternative_id)
        .execute(&fixture.tenant_pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM commercial_cases WHERE id=$1")
        .bind(alternative_id)
        .execute(&fixture.tenant_pool)
        .await
        .unwrap();
    // This passes request validation but fails its customer FK after allocation.
    // The next successful creation must reuse the rolled-back allocation.
    rpc.expect_error(
        "commercial.cases.create",
        Method::POST,
        json!({"kind":"offer","title":"Invalid customer","customerId":Id(i64::MAX).encode()}),
        Some(token),
        "INTERNAL_SERVER_ERROR",
    )
    .await;
    let next = create_case(&rpc, token, json!({"kind":"offer","title":"Next offer"})).await;
    assert_eq!(
        rpc.query("commercial.cases.get", json!({"id":next}), Some(token))
            .await["case"]["reference"],
        "3"
    );

    rpc.mutation(
        "settings.offerNumbering.set",
        json!({"scheme":"dateSeparated","startNumber":" 00040 "}),
        Some(token),
    )
    .await;
    assert_eq!(
        rpc.query("settings.offerNumbering.get", Value::Null, Some(token))
            .await,
        json!({"scheme":"dateSeparated","startNumber":"40"})
    );
    let dated = create_case(&rpc, token, json!({"kind":"offer","title":"Dated offer"})).await;
    let date_prefix = chrono::Utc::now().format("%y-%m-%d").to_string();
    assert_eq!(
        rpc.query("commercial.cases.get", json!({"id":dated}), Some(token))
            .await["case"]["reference"],
        format!("{date_prefix}-40")
    );
    rpc.mutation(
        "settings.offerNumbering.set",
        json!({"scheme":"dateCompact","startNumber":"1"}),
        Some(token),
    )
    .await;
    let compact = create_case(
        &rpc,
        token,
        json!({"kind":"alternative","title":"Dated alternative","parentCaseId":main}),
    )
    .await;
    let compact_number = format!("{}41", chrono::Utc::now().format("%y%m%d"));
    assert_eq!(
        rpc.query("commercial.cases.get", json!({"id":compact}), Some(token))
            .await["case"]["reference"],
        compact_number
    );
    let compact_id = Id::decode(compact.as_str().unwrap()).unwrap().0;
    sqlx::query("DELETE FROM commercial_case_events WHERE case_id=$1")
        .bind(compact_id)
        .execute(&fixture.tenant_pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM commercial_cases WHERE id=$1")
        .bind(compact_id)
        .execute(&fixture.tenant_pool)
        .await
        .unwrap();
    rpc.mutation(
        "settings.offerNumbering.set",
        json!({"scheme":"sequential","startNumber":compact_number}),
        Some(token),
    )
    .await;
    let expected_start = compact_number.parse::<i64>().unwrap() + 1;
    let parallel = futures_util::future::join_all((0..16).map(|n| {
        let rpc = &rpc;
        async move {
            create_case(
                rpc,
                token,
                json!({"kind":"offer","title":format!("Concurrent {n}")}),
            )
            .await
        }
    }))
    .await;
    let mut references = Vec::new();
    for id in parallel {
        references.push(
            rpc.query("commercial.cases.get", json!({"id":id}), Some(token))
                .await["case"]["reference"]
                .as_str()
                .unwrap()
                .parse::<i64>()
                .unwrap(),
        );
    }
    references.sort_unstable();
    assert_eq!(
        references,
        (expected_start..expected_start + 16).collect::<Vec<_>>()
    );

    // Sales allocations neither use the legacy commercial sequence nor touch
    // invoice numbering. Non-sales workflows retain their existing references.
    let project: i64 =
        sqlx::query_scalar("INSERT INTO projects(title) VALUES('Existing project') RETURNING id")
            .fetch_one(&fixture.tenant_pool)
            .await
            .unwrap();
    let variation = create_case(
        &rpc,
        token,
        json!({"kind":"variation","title":"Variation","projectId":Id(project).encode()}),
    )
    .await;
    assert_eq!(
        rpc.query("commercial.cases.get", json!({"id":variation}), Some(token))
            .await["case"]["reference"],
        format!("NTR-{}-000001", chrono::Utc::now().format("%Y"))
    );
    assert_eq!(
        rpc.query("settings.invoiceNumbering.get", Value::Null, Some(token))
            .await,
        default
    );
    assert_eq!(
        rpc.query(
            "commercial.cases.get",
            json!({"id":Id(legacy).encode()}),
            Some(token)
        )
        .await["case"]["reference"],
        "ANG-2026-000123"
    );
    assert_eq!(
        rpc.query("commercial.cases.get", json!({"id":main}), Some(token))
            .await["case"]["reference"],
        "1"
    );
    rpc.mutation(
        "settings.offerNumbering.set",
        json!({"scheme":"sequential","startNumber":"9223372036854775807"}),
        Some(token),
    )
    .await;
    assert_eq!(
        rpc.query("settings.offerNumbering.get", Value::Null, Some(token))
            .await["startNumber"],
        "9223372036854775807"
    );
    let other = Fixture::create(&environment).await;
    let other_login = rpc.mutation("auth.login", json!({"tenant":other.tenant,"username":other.admin_username,"password":other.admin_password}), None).await;
    assert_eq!(
        rpc.query(
            "settings.offerNumbering.get",
            Value::Null,
            other_login["token"].as_str()
        )
        .await,
        default
    );
}

#[tokio::test]
async fn contractor_workflows_preserve_native_contracts_and_project_invariants() {
    let Some(environment) = TestEnvironment::from_env() else {
        return;
    };
    let fixture = Fixture::create(&environment).await;
    let rpc = RpcClient::new(environment.api_base_url.clone());
    let login=rpc.mutation("auth.login",json!({"tenant":fixture.tenant,"username":fixture.admin_username,"password":fixture.admin_password}),None).await;
    let token = login["token"].as_str().unwrap();
    let customer = rpc
        .mutation(
            "customers.create",
            json!({"name":"Contract customer"}),
            Some(token),
        )
        .await;
    let offer = create_case(
        &rpc,
        token,
        json!({"kind":"offer","title":"New scope","customerId":customer["id"]}),
    )
    .await;
    rpc.mutation("commercial.cases.update",json!({"id":offer,"title":"School renovation","customerId":customer["id"],"notes":"Tender 42"}),Some(token)).await;
    let inquiry = document(&rpc, token, &offer, "inquiry", None, None).await;
    let bid = document(
        &rpc,
        token,
        &offer,
        "offer",
        Some("1000.00"),
        Some((&inquiry, 1)),
    )
    .await;
    let loaded = rpc
        .query(
            "commercial.documents.get",
            json!({"caseId":offer,"id":bid}),
            Some(token),
        )
        .await;
    assert!(loaded["xml"].as_str().unwrap().contains("Grüße"));
    assert!(
        loaded["referenceXml"]
            .as_str()
            .unwrap()
            .contains("preserve")
    );
    let changed =
        "<GAEB><!--sortsys:document-title:v1:Sanierung%20S%C3%BCdfl%C3%BCgel-->New scope</GAEB>";
    rpc.mutation(
        "commercial.documents.save",
        json!({"caseId":offer,"id":inquiry,"version":1,"xml":changed}),
        Some(token),
    )
    .await;
    let renamed = rpc
        .query("commercial.cases.get", json!({"id":offer}), Some(token))
        .await;
    assert_eq!(renamed["case"]["title"], "Sanierung Südflügel");
    let listed = rpc
        .query(
            "commercial.cases.list",
            json!({"kind":"offer"}),
            Some(token),
        )
        .await;
    assert!(
        listed
            .as_array()
            .unwrap()
            .iter()
            .any(|case| case["id"] == offer && case["title"] == "Sanierung Südflügel")
    );
    rpc.expect_error(
        "commercial.documents.save",
        Method::POST,
        json!({"caseId":offer,"id":inquiry,"version":1,"xml":changed}),
        Some(token),
        "CONFLICT",
    )
    .await;
    assert_eq!(
        rpc.query(
            "commercial.documents.get",
            json!({"caseId":offer,"id":bid}),
            Some(token)
        )
        .await["canEdit"],
        false
    );
    rpc.expect_error(
        "commercial.cases.transition",
        Method::POST,
        json!({"id":offer,"expectedStatus":"draft","status":"sent"}),
        Some(token),
        "CONFLICT",
    )
    .await;
    rpc.mutation("commercial.documents.create",json!({"caseId":offer,"purpose":"offer","fileName":"Native.x84","xml":"<GAEB>Updated calculation</GAEB>","readOnly":false,"netAmount":"1200.00","replaceDocumentId":bid,"expectedVersion":1,"sourceDocumentId":inquiry,"sourceVersion":2}),Some(token)).await;
    rpc.expect_error(
        "commercial.cases.createProject",
        Method::POST,
        json!({"id":offer}),
        Some(token),
        "BAD_REQUEST",
    )
    .await;
    rpc.expect_error(
        "commercial.cases.transition",
        Method::POST,
        json!({"id":offer,"expectedStatus":"draft","status":"accepted"}),
        Some(token),
        "BAD_REQUEST",
    )
    .await;
    transition(&rpc, token, &offer, "draft", "sent").await;
    // A submitted document is sealed; revisions must explicitly reopen the case.
    rpc.expect_error(
        "commercial.documents.save",
        Method::POST,
        json!({"caseId":offer,"id":bid,"version":2,"xml":"<GAEB/>","netAmount":"1.00"}),
        Some(token),
        "CONFLICT",
    )
    .await;
    transition(&rpc, token, &offer, "sent", "accepted").await;
    let project = rpc
        .mutation(
            "commercial.cases.createProject",
            json!({"id":offer}),
            Some(token),
        )
        .await;
    let repeated = rpc
        .mutation(
            "commercial.cases.createProject",
            json!({"id":offer}),
            Some(token),
        )
        .await;
    assert_eq!(project, repeated);
    let project_id = &project["id"];
    let detail = rpc
        .query("commercial.cases.get", json!({"id":offer}), Some(token))
        .await;
    assert_eq!(detail["case"]["projectId"], *project_id);
    assert_eq!(detail["documents"].as_array().unwrap().len(), 2);
    assert_eq!(detail["case"]["netAmount"], "1200.00");
    rpc.expect_error(
        "commercial.cases.create",
        Method::POST,
        json!({"kind":"offer","title":"Second main offer","projectId":project_id}),
        Some(token),
        "BAD_REQUEST",
    )
    .await;
    let order = document(&rpc, token, &offer, "order", Some("1200.00"), None).await;
    let confirmation = document(
        &rpc,
        token,
        &offer,
        "confirmation",
        Some("1200.00"),
        Some((&order, 1)),
    )
    .await;
    rpc.mutation(
        "commercial.documents.finalize",
        json!({"caseId":offer,"id":confirmation,"version":1}),
        Some(token),
    )
    .await;
    assert_eq!(
        rpc.query(
            "commercial.documents.get",
            json!({"caseId":offer,"id":confirmation}),
            Some(token)
        )
        .await["canEdit"],
        false
    );
    rpc.expect_error("commercial.documents.create",Method::POST,json!({"caseId":offer,"purpose":"confirmation","fileName":"Replacement.x87","xml":"<GAEB/>","replaceDocumentId":confirmation,"expectedVersion":2}),Some(token),"CONFLICT").await;
    let download = rpc
        .query(
            "commercial.documents.download",
            json!({"caseId":offer,"id":bid}),
            Some(token),
        )
        .await;
    assert!(
        rpc.http
            .get(download["url"].as_str().unwrap())
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap()
            .contains("Updated calculation")
    );

    let variation = create_case(
        &rpc,
        token,
        json!({"kind":"variation","title":"Reduced quantity","projectId":project_id}),
    )
    .await;
    document(&rpc, token, &variation, "offer", Some("-50.25"), None).await;
    transition(&rpc, token, &variation, "draft", "sent").await;
    transition(&rpc, token, &variation, "sent", "accepted").await;
    let costs = rpc
        .query(
            "projects.costs.get",
            json!({"projectId":project_id}),
            Some(token),
        )
        .await;
    assert_eq!(costs["totalCosts"]["offers"], 1149.75, "{costs}");
    let linked = costs["offers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["commercialCaseId"] == offer)
        .unwrap();
    rpc.expect_error(
        "projects.costs.entries.delete",
        Method::POST,
        json!({"projectId":project_id,"id":linked["id"]}),
        Some(token),
        "NOT_FOUND",
    )
    .await;
    rpc.expect_error(
        "projects.costs.entries.create",
        Method::POST,
        json!({"projectId":project_id,"type":"offer","amount":10,"comment":"bypass"}),
        Some(token),
        "BAD_REQUEST",
    )
    .await;
    let measurement=create_case(&rpc,token,json!({"kind":"measurement","title":"First measured work","projectId":project_id,"parentCaseId":offer,"scopeItemIds":["item1"]})).await;
    document(
        &rpc,
        token,
        &measurement,
        "measurement",
        None,
        Some((&order, 1)),
    )
    .await;
    transition(&rpc, token, &measurement, "draft", "submitted").await;
    transition(&rpc, token, &measurement, "submitted", "approved").await;
    rpc.expect_error(
        "commercial.cases.createProject",
        Method::POST,
        json!({"id":variation}),
        Some(token),
        "BAD_REQUEST",
    )
    .await;

    // Two prepared packages may overlap; awarding the second must fail.
    for index in 0..2 {
        let package=create_case(&rpc,token,json!({"kind":"subcontract","title":format!("Electrical {index}"),"projectId":project_id,"parentCaseId":offer,"scopeItemIds":["item1"]})).await;
        let inquiry = document(&rpc, token, &package, "inquiry", None, Some((&order, 1))).await;
        transition(&rpc, token, &package, "draft", "requested").await;
        let supplier = document(
            &rpc,
            token,
            &package,
            "offer",
            Some("400.00"),
            Some((&inquiry, 1)),
        )
        .await;
        document(
            &rpc,
            token,
            &package,
            "order",
            Some("400.00"),
            Some((&supplier, 1)),
        )
        .await;
        let award = json!({"id":package,"expectedStatus":"requested","status":"awarded","selectedOfferDocumentId":supplier,"awardedItemIds":["item1"]});
        if index == 1 {
            rpc.expect_error(
                "commercial.cases.transition",
                Method::POST,
                award,
                Some(token),
                "CONFLICT",
            )
            .await;
        } else {
            rpc.mutation("commercial.cases.transition", award, Some(token))
                .await;
            document(&rpc, token, &package, "confirmation", Some("400.00"), None).await;
            transition(&rpc, token, &package, "awarded", "confirmed").await;
        }
    }
    let listed = rpc
        .query(
            "commercial.cases.list",
            json!({"projectId":project_id,"search":"Südflügel"}),
            Some(token),
        )
        .await;
    assert_eq!(listed.as_array().unwrap().len(), 1);

    let legacy = rpc
        .mutation(
            "projects.create",
            json!({"title":"Legacy project"}),
            Some(token),
        )
        .await;
    rpc.mutation(
        "projects.costs.entries.create",
        json!({"projectId":legacy["id"],"type":"offer","amount":950,"comment":"Historic quote"}),
        Some(token),
    )
    .await;
    let adopt = json!({"projectId":legacy["id"],"title":"Legacy contract","sourcePhase":"86","sourceFileName":"Original.x86","sourceXml":"<GAEB>Original</GAEB>","offerXml":"<GAEB>Prices</GAEB>","netAmount":"1000.00"});
    let adopted = rpc
        .mutation("commercial.cases.adoptContract", adopt.clone(), Some(token))
        .await;
    assert_eq!(
        rpc.query(
            "commercial.cases.get",
            json!({"id":adopted["id"]}),
            Some(token)
        )
        .await["case"]["existingContract"],
        true
    );
    rpc.expect_error(
        "commercial.cases.adoptContract",
        Method::POST,
        adopt,
        Some(token),
        "CONFLICT",
    )
    .await;
    let costs = rpc
        .query(
            "projects.costs.get",
            json!({"projectId":legacy["id"]}),
            Some(token),
        )
        .await;
    assert_eq!(costs["totalCosts"]["offers"], 950.0);
    for (phase, purpose) in [
        ("84", "offer"),
        ("85", "alternative"),
        ("87", "confirmation"),
    ] {
        let project = rpc
            .mutation(
                "projects.create",
                json!({"title":format!("Existing X{phase}")}),
                Some(token),
            )
            .await;
        let original = format!("<GAEB><!--Original {phase}--><vendor>unmodified</vendor></GAEB>");
        let reference = "<GAEB>Original scope</GAEB>";
        let input = json!({
            "projectId":project["id"], "title":format!("Contract X{phase}"),
            "sourcePhase":phase, "sourceFileName":format!("Accepted.x{phase}"), "sourceXml":original,
            "offerXml":if phase == "84" { None } else { Some("<GAEB>Price snapshot</GAEB>") },
            "referenceXml":if phase == "84" { Some(reference) } else { None }, "netAmount":"1500.00"
        });
        let created = rpc
            .mutation("commercial.cases.adoptContract", input, Some(token))
            .await;
        let detail = rpc
            .query(
                "commercial.cases.get",
                json!({"id":created["id"]}),
                Some(token),
            )
            .await;
        assert_eq!(detail["case"]["existingContract"], true);
        assert_eq!(detail["case"]["status"], "accepted");
        let documents = detail["documents"].as_array().unwrap();
        assert_eq!(documents.len(), 2);
        assert!(!documents.iter().any(|doc| doc["phase"] == "86"));
        let source = documents.iter().find(|doc| doc["phase"] == phase).unwrap();
        assert_eq!(source["purpose"], purpose);
        assert_eq!(source["readOnly"], true);
        assert_eq!(source["fileName"], format!("Accepted.x{phase}"));
        let source_content = rpc
            .query(
                "commercial.documents.get",
                json!({"caseId":created["id"],"id":source["id"]}),
                Some(token),
            )
            .await;
        assert_eq!(source_content["xml"], original);
        let offer = documents.iter().find(|doc| doc["phase"] == "84").unwrap();
        let loaded = rpc
            .query(
                "commercial.documents.get",
                json!({"caseId":created["id"],"id":offer["id"]}),
                Some(token),
            )
            .await;
        assert_eq!(
            loaded["referenceXml"],
            if phase == "84" { reference } else { &original }
        );
    }
    let snapshots: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM commercial_document_snapshots")
        .fetch_one(&fixture.tenant_pool)
        .await
        .unwrap();
    assert!(snapshots >= 10);
    // A worker without global project access must not see pre-contract prices.
    sqlx::query("DELETE FROM user_role_assignments WHERE user_id=$1")
        .bind(fixture.user_id)
        .execute(&fixture.tenant_pool)
        .await
        .unwrap();
    rpc.expect_error(
        "commercial.cases.list",
        Method::GET,
        json!({}),
        Some(token),
        "FORBIDDEN",
    )
    .await;
    rpc.expect_error(
        "commercial.documents.get",
        Method::GET,
        json!({"caseId":offer,"id":bid}),
        Some(token),
        "FORBIDDEN",
    )
    .await;
    rpc.expect_error(
        "commercial.cases.create",
        Method::POST,
        json!({"kind":"offer","title":"Denied"}),
        Some(token),
        "FORBIDDEN",
    )
    .await;
    rpc.expect_error(
        "commercial.documents.get",
        Method::GET,
        json!({"caseId":offer,"id":bid}),
        None,
        "UNAUTHORIZED",
    )
    .await;
}

#[tokio::test]
async fn native_position_library_indexes_past_documents_updates_and_isolates_tenants() {
    let Some(environment) = TestEnvironment::from_env() else {
        return;
    };
    let fixture = Fixture::create(&environment).await;
    let rpc = RpcClient::new(environment.api_base_url.clone());
    let login=rpc.mutation("auth.login",json!({"tenant":fixture.tenant,"username":fixture.admin_username,"password":fixture.admin_password}),None).await;
    let token = login["token"].as_str().unwrap();
    let customer = rpc
        .mutation(
            "customers.create",
            json!({"name":"Library customer"}),
            Some(token),
        )
        .await;
    let case = create_case(
        &rpc,
        token,
        json!({"kind":"offer","title":"Position library source","customerId":customer["id"]}),
    )
    .await;
    let xml = r#"<GAEB xmlns="http://www.gaeb.de/GAEB_DA_XML/DA83/3.3"><Item ID="library-item"><QU>m²</QU><Description><DetailTxt><Text><p><span>Revisionsklappe</span></p><p><span>Brandschutzplatte montieren</span></p></Text></DetailTxt><OutlTxt><TextOutlTxt><p><span>Revisionsklappe</span></p></TextOutlTxt></OutlTxt></Description></Item></GAEB>"#;
    let id=rpc.mutation("commercial.documents.create",json!({"caseId":case,"purpose":"inquiry","fileName":"Library.x83","xml":xml,"readOnly":false}),Some(token)).await["id"].clone();
    let found = rpc
        .query(
            "gaeb.positions.search",
            json!({"query":"Brandsch"}),
            Some(token),
        )
        .await;
    assert_eq!(found["items"].as_array().unwrap().len(), 1);
    assert_eq!(found["items"][0]["shortText"], "Revisionsklappe");
    assert_eq!(
        found["items"][0]["description"],
        "Brandschutzplatte montieren"
    );
    assert_eq!(found["items"][0]["unit"], "m²");
    rpc.mutation("commercial.documents.save",json!({"caseId":case,"id":id,"version":1,"xml":xml.replace("Brandschutzplatte","Akustikplatte")}),Some(token)).await;
    let stale = rpc
        .query(
            "gaeb.positions.search",
            json!({"query":"Brandsch"}),
            Some(token),
        )
        .await;
    assert!(stale["items"].as_array().unwrap().is_empty());
    let updated = rpc
        .query(
            "gaeb.positions.search",
            json!({"query":"Akustik"}),
            Some(token),
        )
        .await;
    assert_eq!(updated["items"].as_array().unwrap().len(), 1);
    let other = Fixture::create(&environment).await;
    let other_login=rpc.mutation("auth.login",json!({"tenant":other.tenant,"username":other.admin_username,"password":other.admin_password}),None).await;
    let isolated = rpc
        .query(
            "gaeb.positions.search",
            json!({"query":"Akustik"}),
            other_login["token"].as_str(),
        )
        .await;
    assert!(isolated["items"].as_array().unwrap().is_empty());
}
