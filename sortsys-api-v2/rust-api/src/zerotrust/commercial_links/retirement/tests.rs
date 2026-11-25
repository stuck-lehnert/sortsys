use super::*;
use crate::{
    control::Repository,
    error::ErrorCode,
    ids::Id,
    quack_store::{CipherStore, QuackConfig},
    zerotrust::{
        commercial_links::{CaseLinks, DocumentLink, FinancialLink},
        documents::{DocumentHead, visible_head},
    },
};

#[test]
fn large_reference_lists_fit_the_read_budget_without_conflating_namespaces() {
    let ids = (1..=20_000).map(|id| Id(id).encode()).collect::<Vec<_>>();
    let shards = shard_records(
        ids.iter()
            .flat_map(|id| [(Kind::Case, id.as_str()), (Kind::Document, id.as_str())]),
    );

    assert!(shards.len() <= 512);
    assert_eq!(shards.values().map(BTreeSet::len).sum::<usize>(), 40_000);
}

#[tokio::test]
#[ignore = "scripts/test-native-auth provides a disposable DuckDB"]
async fn retirement_fences_old_clients_and_attested_dependencies_across_peers() {
    assert_eq!(
        std::env::var("SORTSYS_DISPOSABLE_AUTH_TEST").as_deref(),
        Ok("1")
    );
    let config = QuackConfig::from_env().unwrap().unwrap();
    assert!(config.control_url.starts_with("http://127.0.0.1:"));
    assert!(config.token.starts_with("sortsys-disposable-"));
    let peer = || {
        Repository::system(CipherStore::new(config.clone()).unwrap())
            .tenant("offer-retirement-test")
            .unwrap()
    };
    let writer = peer();
    let remover = peer();
    let financial = |id: &str| {
        CommercialLinks::Financial(FinancialLink {
            financial_case: Some(id.to_owned()),
            signature: String::new(),
        })
    };

    let head_fixture = include_str!("../../../../tests/fixtures/zerotrust-document.json");
    let fixture: serde_json::Value = serde_json::from_str(head_fixture).unwrap();
    let mut head: DocumentHead = serde_json::from_value(fixture["head"].clone()).unwrap();
    head.id = "7".into();
    head.scope = "commercial:1".into();
    let mut setup = writer.transaction().unwrap();
    setup.put(key("documents", "7"), &head).await.unwrap();
    setup.commit().await.unwrap();

    let mut reader = writer.transaction().unwrap();
    assert!(visible_head(&mut reader, "7").await.unwrap().as_ref() == Some(&head));

    // A pre-cutover client plans a write without a proof. The first
    // retirement and its absence observation cannot both commit.
    let probe = key("retirement-probe", "write");
    let mut legacy = writer.transaction().unwrap();
    check_publication(&mut legacy, None).await.unwrap();
    legacy.put(probe.clone(), &1).await.unwrap();
    let mut document = writer.transaction().unwrap();
    check_document_publication(&mut document, "commercial:9", "7")
        .await
        .unwrap();
    document.put(probe.clone(), &7).await.unwrap();
    let mut snapshot = writer.transaction().unwrap();
    check_scope_publication(&mut snapshot, "commercial:1")
        .await
        .unwrap();
    snapshot.put(probe.clone(), &9).await.unwrap();

    let mut deletion = remover.transaction().unwrap();
    retire(&mut deletion, "1", &BTreeSet::from(["7".into()]))
        .await
        .unwrap();
    deletion.commit().await.unwrap();
    assert_eq!(
        reader.validate().await.unwrap_err().code,
        ErrorCode::Conflict
    );
    assert_eq!(legacy.commit().await.unwrap_err().code, ErrorCode::Conflict);
    assert_eq!(
        document.commit().await.unwrap_err().code,
        ErrorCode::Conflict
    );
    assert_eq!(
        snapshot.commit().await.unwrap_err().code,
        ErrorCode::Conflict
    );

    let source = CommercialLinks::Case(CaseLinks {
        standalone_offer: false,
        parent_case: None,
        documents: vec![DocumentLink {
            id: "8".into(),
            source: Some("7".into()),
        }],
        signature: String::new(),
    });
    let mut fresh = writer.transaction().unwrap();
    assert!(visible_head(&mut fresh, "7").await.unwrap().is_none());
    let row = |domain: &str, object: &str| ObjectRecord {
        domain: domain.into(),
        object: object.into(),
        revision: "1".into(),
        reference: "fixture".into(),
        deleted: false,
        tombstone: false,
    };
    let blob = |document: &str| {
        let object = format!(
            "commercial:9:scope:document:{document}:0123456789abcdef0123456789abcdef:manifest"
        );
        row("commercial:9:scope", &object)
    };
    let records = [
        row("commercial:1:master-data", "commercial:1:master-data:case"),
        blob("7"),
        blob("8"),
        row("project:1:master-data", "project:1:master-data:project"),
    ];
    assert_eq!(
        hidden_objects(&mut fresh, &records).await.unwrap(),
        vec![0, 1]
    );

    for blocked in [None, Some(&financial("1")), Some(&source)] {
        let error = check_publication(&mut fresh, blocked).await.unwrap_err();
        assert_eq!(error.code, ErrorCode::Conflict);
    }
    for (scope, id) in [("commercial:9", "7"), ("commercial:1", "8")] {
        let error = check_document_publication(&mut fresh, scope, id)
            .await
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::Conflict);
    }
    check_document_publication(&mut fresh, "commercial:9", "8")
        .await
        .unwrap();

    assert_eq!(
        check_scope_publication(&mut fresh, "commercial:1")
            .await
            .unwrap_err()
            .code,
        ErrorCode::Conflict
    );
    check_scope_publication(&mut fresh, "commercial:9")
        .await
        .unwrap();

    // Unrelated IDs work. A later retirement must invalidate even a
    // correctly attested publication that has not committed yet.
    let mut staged = writer.transaction().unwrap();
    check_publication(&mut staged, Some(&financial("2")))
        .await
        .unwrap();
    staged.put(probe.clone(), &2).await.unwrap();
    let mut deletion = remover.transaction().unwrap();
    retire(&mut deletion, "2", &BTreeSet::new()).await.unwrap();
    deletion.commit().await.unwrap();
    assert_eq!(staged.commit().await.unwrap_err().code, ErrorCode::Conflict);
    assert!(remover.read::<i32>(probe).await.unwrap().value.is_none());

    // Even a prepared view predating the retirement must resolve its fences
    // against the durable pins. This fixture tests the metadata resolver, not
    // the signed activation procedure.
    let content = sortsys_zerotrust::content_epoch::ContentEpoch {
        format: "zt-content-epoch-v1".into(),
        tenant: "offer-retirement-test".into(),
        authority_generation: "1".into(),
        number: "1".into(),
        previous: None,
        source_number: "0".into(),
        source_head: None,
        snapshot: crate::zerotrust::crypto::encode(&[15; 32]),
        actor: "test-authority".into(),
        signature: String::new(),
    };
    let mut restored = writer.transaction().unwrap();
    restored.select_prepared_content(&content).await.unwrap();
    assert_eq!(
        hidden_objects(&mut restored, &records).await.unwrap(),
        vec![0, 1]
    );

    check_restored_documents(&mut restored, &[("commercial:9", "8")])
        .await
        .unwrap();
    for blocked in [("commercial:9", "7"), ("commercial:1", "8")] {
        assert_eq!(
            check_restored_documents(&mut restored, &[blocked])
                .await
                .unwrap_err()
                .code,
            ErrorCode::Conflict,
        );
    }
    assert_eq!(
        check_publication(&mut restored, Some(&financial("2")))
            .await
            .unwrap_err()
            .code,
        ErrorCode::Conflict,
    );
    restored.validate().await.unwrap();
}
