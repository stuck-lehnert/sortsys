use super::*;

#[tokio::test]
async fn native_development_examples_are_complete_stored_and_idempotent() {
    let Some(environment) = TestEnvironment::from_env() else {
        return;
    };
    let fixture = Fixture::create(&environment).await;
    seed::seed_randomized_data(&fixture.tenant_pool, 42)
        .await
        .unwrap();
    seed::ensure_development_users(&fixture.tenant_pool)
        .await
        .unwrap();
    let state = AppState::connect(Config::from_env().unwrap())
        .await
        .unwrap();
    seed::extend_development(&state, &fixture.tenant, &fixture.tenant_pool, 42)
        .await
        .unwrap();
    let kinds: Vec<String> =
        sqlx::query_scalar("SELECT DISTINCT kind FROM commercial_cases ORDER BY kind")
            .fetch_all(&fixture.tenant_pool)
            .await
            .unwrap();
    assert_eq!(kinds.len(), 10, "{kinds:?}");
    let phases: Vec<String> =
        sqlx::query_scalar("SELECT DISTINCT phase FROM commercial_documents ORDER BY phase")
            .fetch_all(&fixture.tenant_pool)
            .await
            .unwrap();
    assert_eq!(
        phases,
        [
            "31", "52", "83", "84", "85", "86", "87", "89", "93", "94", "96", "97"
        ]
    );
    let invalid: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM commercial_cases c WHERE (c.kind='invoice' AND EXISTS(SELECT 1 FROM commercial_cases p WHERE p.parent_case_id=c.parent_case_id AND p.kind='progress_invoice' AND p.status<>'cancelled')) OR (c.kind='final_invoice' AND NOT EXISTS(SELECT 1 FROM commercial_cases p WHERE p.parent_case_id=c.parent_case_id AND p.kind='progress_invoice' AND p.status IN ('sent','partially_paid','paid')))").fetch_one(&fixture.tenant_pool).await.unwrap();
    assert_eq!(invalid, 0);
    let counts: (i64,i64,i64) = sqlx::query_as("SELECT (SELECT COUNT(*) FROM commercial_cases),(SELECT COUNT(*) FROM commercial_documents),(SELECT COUNT(*) FROM project_files)").fetch_one(&fixture.tenant_pool).await.unwrap();
    assert!(
        counts.0 >= 100 && counts.1 >= 180 && counts.2 >= 69,
        "{counts:?}"
    );
    let storage = sortsys_api::object_storage::tenant_config(&state.tenants, &fixture.tenant, true)
        .await
        .unwrap()
        .unwrap();
    let files: Vec<(String,String)> = sqlx::query_as("SELECT object_key,file_name FROM project_files WHERE object_key LIKE '%seeds/%' ORDER BY id LIMIT 10").fetch_all(&fixture.tenant_pool).await.unwrap();
    assert!(!files.is_empty());
    for (key, _) in files {
        let url = sortsys_api::object_storage::create_download_url(
            &storage,
            &key,
            None,
            false,
            sortsys_api::object_storage::Audience::Internal,
        )
        .unwrap()
        .download_url;
        let bytes = Client::new()
            .get(url)
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .bytes()
            .await
            .unwrap();
        assert!(!bytes.is_empty());
    }
    // Exercise real stored X31 objects, not just the golden fixture generator.
    #[derive(sqlx::FromRow)]
    struct SeedMeasure {
        id: i64,
        object_key: String,
        file_name: String,
        status: String,
        project: String,
        scope: String,
    }
    let measures: Vec<SeedMeasure> = sqlx::query_as("SELECT d.id,d.object_key,d.file_name,c.status,p.title AS project,c.scope_item_ids::text AS scope FROM commercial_documents d JOIN commercial_cases c ON c.id=d.case_id JOIN projects p ON p.id=c.project_id WHERE d.phase='31' ORDER BY d.id").fetch_all(&fixture.tenant_pool).await.unwrap();
    assert_eq!(measures.len(), 12);
    let mut statuses = std::collections::HashSet::new();
    for SeedMeasure {
        object_key: key,
        file_name: name,
        status,
        project,
        scope,
        ..
    } in &measures
    {
        statuses.insert(status.as_str());
        let url = sortsys_api::object_storage::create_download_url(
            &storage,
            key,
            Some(name),
            false,
            sortsys_api::object_storage::Audience::Internal,
        )
        .unwrap()
        .download_url;
        let xml = Client::new()
            .get(url)
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .text()
            .await
            .unwrap();
        let parsed = roxmltree::Document::parse(&xml).unwrap();
        let items = parsed
            .descendants()
            .filter(|node| node.has_tag_name(("http://www.gaeb.de/GAEB_DA_XML/DA31/3.3", "Item")))
            .collect::<Vec<_>>();
        let ids = serde_json::from_str::<Vec<String>>(scope).unwrap();
        assert_eq!(items.len(), ids.len());
        assert_eq!(items.len(), 6);
        for item in items {
            assert!(
                ids.iter()
                    .any(|id| Some(id.as_str()) == item.attribute("ID"))
            );
            let qty = item
                .descendants()
                .find(|node| node.tag_name().name() == "Qty")
                .unwrap()
                .text()
                .unwrap();
            assert!(qty.parse::<f64>().unwrap() > 0.0);
            let rows = item
                .descendants()
                .filter(|node| node.tag_name().name() == "QTakeoff")
                .collect::<Vec<_>>();
            assert!(!rows.is_empty());
            for row in rows {
                assert_eq!(row.attribute("Row").unwrap().chars().count(), 80);
            }
        }
        assert_eq!(
            parsed
                .descendants()
                .find(|node| node.tag_name().name() == "RefPrjName")
                .unwrap()
                .text()
                .unwrap(),
            project.chars().take(60).collect::<String>()
        );
        assert!(xml.contains("sortsys:measure:v1:"));
        assert!(xml.contains("sortsys:takeoff-title:v1:"));
    }
    assert_eq!(
        statuses,
        std::collections::HashSet::from(["draft", "submitted", "approved", "cancelled"])
    );
    seed::extend_development(&state, &fixture.tenant, &fixture.tenant_pool, 100)
        .await
        .unwrap();
    let repeated: (i64,i64,i64) = sqlx::query_as("SELECT (SELECT COUNT(*) FROM commercial_cases),(SELECT COUNT(*) FROM commercial_documents),(SELECT COUNT(*) FROM project_files)").fetch_one(&fixture.tenant_pool).await.unwrap();
    assert_eq!(counts, repeated);
    // Replay the cosmetic location repair against a real old object. Quantities
    // and the original immutable snapshot must survive; the second run is a no-op.
    let old = &measures[1];
    let url = sortsys_api::object_storage::create_download_url(
        &storage,
        &old.object_key,
        None,
        false,
        sortsys_api::object_storage::Audience::Internal,
    )
    .unwrap()
    .download_url;
    let current = Client::new()
        .get(url)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .text()
        .await
        .unwrap();
    let legacy = current.replace("EG%2C%20Raum", "EG%20%C2%B7%20Raum");
    assert_ne!(legacy, current);
    let upload = sortsys_api::object_storage::create_upload_url(
        &storage,
        &old.object_key,
        "application/xml",
        sortsys_api::object_storage::Audience::Internal,
    )
    .unwrap();
    Client::new()
        .put(upload.upload_url)
        .body(legacy.clone())
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    sqlx::query("DELETE FROM development_seed_manifests WHERE name='native-takeoff-locations-v2'")
        .execute(&fixture.tenant_pool)
        .await
        .unwrap();
    seed::extend_development(&state, &fixture.tenant, &fixture.tenant_pool, 100)
        .await
        .unwrap();
    let repaired: (String, i64) =
        sqlx::query_as("SELECT object_key,version FROM commercial_documents WHERE id=$1")
            .bind(old.id)
            .fetch_one(&fixture.tenant_pool)
            .await
            .unwrap();
    assert_eq!(repaired.1, 2);
    assert_ne!(repaired.0, old.object_key);
    let original: String = sqlx::query_scalar(
        "SELECT object_key FROM commercial_document_snapshots WHERE document_id=$1 AND version=1",
    )
    .bind(old.id)
    .fetch_one(&fixture.tenant_pool)
    .await
    .unwrap();
    assert_eq!(original, old.object_key);
    let url = sortsys_api::object_storage::create_download_url(
        &storage,
        &repaired.0,
        None,
        false,
        sortsys_api::object_storage::Audience::Internal,
    )
    .unwrap()
    .download_url;
    let repaired_xml = Client::new()
        .get(url)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .text()
        .await
        .unwrap();
    // Serialization of the metadata comment may reorder JSON keys. Every other
    // source byte, including the executable quantities, stays identical.
    let without_comments = |xml: &str| -> String {
        roxmltree::Document::parse(xml)
            .unwrap()
            .descendants()
            .filter(|n| n.is_comment())
            .map(|n| n.range())
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .fold(xml.to_owned(), |mut xml, range| {
                xml.replace_range(range, "");
                xml
            })
    };
    assert_eq!(without_comments(&repaired_xml), without_comments(&current));
    assert!(!repaired_xml.contains("EG%20%C2%B7%20Raum"));
    seed::extend_development(&state, &fixture.tenant, &fixture.tenant_pool, 101)
        .await
        .unwrap();
    let repeated: (String, i64) =
        sqlx::query_as("SELECT object_key,version FROM commercial_documents WHERE id=$1")
            .bind(old.id)
            .fetch_one(&fixture.tenant_pool)
            .await
            .unwrap();
    assert_eq!(repaired, repeated);
    // Simulate an existing installation whose original manifest is already done.
    // A renamed/edited original must remain untouched when the new seed is added.
    let original = &measures[0];
    sqlx::query("UPDATE commercial_documents SET file_name='Mein bearbeitetes Aufmaß.x31',version=2 WHERE id=$1").bind(original.id).execute(&fixture.tenant_pool).await.unwrap();
    sqlx::query("DELETE FROM development_seed_manifests WHERE name='native-assisted-takeoffs-v1'")
        .execute(&fixture.tenant_pool)
        .await
        .unwrap();
    seed::extend_development(&state, &fixture.tenant, &fixture.tenant_pool, 123)
        .await
        .unwrap();
    let upgraded:(i64,i64,i64)=sqlx::query_as("SELECT (SELECT COUNT(*) FROM commercial_cases),(SELECT COUNT(*) FROM commercial_documents),(SELECT COUNT(*) FROM project_files)").fetch_one(&fixture.tenant_pool).await.unwrap();
    assert_eq!(upgraded, (counts.0 + 1, counts.1 + 1, counts.2));
    let preserved: (String, i64, String) =
        sqlx::query_as("SELECT object_key,version,file_name FROM commercial_documents WHERE id=$1")
            .bind(original.id)
            .fetch_one(&fixture.tenant_pool)
            .await
            .unwrap();
    assert_eq!(
        preserved,
        (
            original.object_key.clone(),
            2,
            "Mein bearbeitetes Aufmaß.x31".to_owned()
        )
    );
    seed::extend_development(&state, &fixture.tenant, &fixture.tenant_pool, 124)
        .await
        .unwrap();
    let final_counts:(i64,i64,i64)=sqlx::query_as("SELECT (SELECT COUNT(*) FROM commercial_cases),(SELECT COUNT(*) FROM commercial_documents),(SELECT COUNT(*) FROM project_files)").fetch_one(&fixture.tenant_pool).await.unwrap();
    assert_eq!(upgraded, final_counts);
    state.tenants.close().await;
}
