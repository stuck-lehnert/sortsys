use super::*;

fn row(text: Option<&str>, total: Option<i32>) -> DocumentTextRow {
    DocumentTextRow {
        file_name: "Prüfbericht.pdf".to_owned(),
        mime_type: "application/pdf".to_owned(),
        project_title: "Construction site".to_owned(),
        modified_at: "2026-10-22T12:00:00Z".parse().unwrap(),
        office_version: 2,
        text_extraction_status: "ready".to_owned(),
        text_extraction_method: Some("embedded_pdf_text".to_owned()),
        text_extraction_confidence: Some(1.0),
        text_extraction_page_count: Some(3),
        text_extracted_at: Some("2026-10-22T12:01:00Z".parse().unwrap()),
        text: text.map(str::to_owned),
        total_characters: total,
    }
}

fn input(extra: Value) -> ReadInput {
    let mut arguments = json!({ "fileId": Id(9) });
    arguments
        .as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());

    ReadInput::parse(arguments).unwrap()
}

#[test]
fn search_validates_query_paging_and_unexpected_fields() {
    let parsed = SearchInput::parse(json!({ "query": "  Wärmedämmung  " })).unwrap();

    assert_eq!(parsed.query, "Wärmedämmung");
    assert_eq!(parsed.limit, DEFAULT_SEARCH_LIMIT);
    assert_eq!(parsed.offset, 0);
    assert!(SearchInput::parse(json!({ "query": "水暖", "limit": 25 })).is_ok());

    for arguments in [
        json!({ "query": " " }),
        json!({ "query": "水" }),
        json!({ "query": "a".repeat(201) }),
        json!({ "query": "report", "limit": 26 }),
        json!({ "query": "report", "limit": 0 }),
        json!({ "query": "report", "offset": -1 }),
        json!({ "query": "report", "offset": MAX_OFFSET + 1 }),
        json!({ "query": "report", "offset": 1.5 }),
        json!({ "query": "report", "tenant": "another-tenant" }),
        json!({ "query": "report", "projectId": "invalid!" }),
    ] {
        assert!(SearchInput::parse(arguments).is_err());
    }
}

#[test]
fn reading_validates_ids_bounds_revisions_and_unknown_fields() {
    let parsed = input(json!({}));

    assert_eq!(parsed.limit, DEFAULT_TEXT_LIMIT);
    assert_eq!(parsed.offset, 0);
    assert!(ReadInput::parse(json!({ "fileId": Id(9), "limit": MAX_TEXT_LIMIT })).is_ok());

    for extra in [
        json!({ "limit": 0 }),
        json!({ "limit": MAX_TEXT_LIMIT + 1 }),
        json!({ "offset": -1 }),
        json!({ "offset": MAX_OFFSET + 1 }),
        json!({ "revision": "" }),
        json!({ "revision": "r".repeat(121) }),
        json!({ "userId": Id(88) }),
    ] {
        let mut arguments = json!({ "fileId": Id(9) });
        arguments
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());

        assert!(ReadInput::parse(arguments).is_err());
    }

    assert!(ReadInput::parse(json!({ "fileId": "invalid!" })).is_err());
    assert!(ReadInput::parse(json!({})).is_err());
}

#[test]
fn text_pages_keep_unicode_and_expose_the_next_character_offset() {
    let output = row(Some("Ä🔧"), Some(5))
        .output(input(json!({ "limit": 2 })), Id(32))
        .unwrap();

    assert_eq!(output["text"], "Ä🔧");
    assert_eq!(output["offset"], 0);
    assert_eq!(output["nextOffset"], 2);
    assert_eq!(output["totalCharacters"], 5);
    assert_eq!(output["contentAvailable"], true);
    assert_eq!(output["unavailableReason"], Value::Null);
    assert_eq!(output["sourceUrl"], source_url(Id(32), Id(9)));
    assert_eq!(output["pageCount"], 3);

    let end = row(Some("水"), Some(5))
        .output(input(json!({ "offset": 4, "limit": 2 })), Id(32))
        .unwrap();

    assert_eq!(end["nextOffset"], Value::Null);
    assert!(
        row(Some(""), Some(5))
            .output(input(json!({ "offset": 6 })), Id(32))
            .is_err()
    );
}

#[test]
fn empty_text_is_distinct_from_unavailable_or_stale_extraction() {
    let empty = row(Some(""), Some(0))
        .output(input(json!({})), Id(32))
        .unwrap();

    assert_eq!(empty["contentAvailable"], true);
    assert_eq!(empty["text"], "");
    assert_eq!(empty["totalCharacters"], 0);
    assert_eq!(empty["nextOffset"], Value::Null);

    for status in [
        "pending",
        "queued",
        "processing",
        "failed",
        "not_applicable",
        "ready",
    ] {
        let mut document = row(None, None);
        document.text_extraction_status = status.to_owned();
        let output = document.output(input(json!({})), Id(32)).unwrap();

        assert_eq!(output["contentAvailable"], false);
        assert_eq!(output["text"], Value::Null);
        assert_eq!(output["nextOffset"], Value::Null);
        assert_eq!(output["totalCharacters"], Value::Null);
        assert_eq!(
            output["unavailableReason"],
            if status == "ready" {
                "stale_or_missing_extraction"
            } else {
                status
            }
        );
    }
}

#[test]
fn revisions_prevent_mixing_changed_documents_and_preview_ids_are_lossless() {
    let original = row(Some("Text"), Some(4))
        .output(input(json!({})), Id(32))
        .unwrap();
    let revision = original["revision"].clone();

    assert!(
        row(Some("xt"), Some(4))
            .output(input(json!({ "offset": 2, "revision": revision })), Id(32))
            .is_ok()
    );
    assert!(
        row(Some("Text"), Some(4))
            .output(input(json!({ "revision": "other-revision" })), Id(32))
            .is_err()
    );

    let file_id = Id(9_007_199_254_740_993);
    let project_id = Id(i64::MAX);

    assert_eq!(
        source_url(project_id, file_id),
        format!(
            "/projects/{}/files?file={}",
            project_id.encode(),
            file_id.encode()
        )
    );
}
