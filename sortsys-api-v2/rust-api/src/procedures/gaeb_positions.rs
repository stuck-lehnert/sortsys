//! Automatically maintained search metadata. Editing and GAEB validation stay in the browser.
use super::common::{authorized_pool, bad_request, internal};
use crate::{
    AppState,
    error::RpcResult,
    ids::Id,
    rpc::{ProcedureRegistryBuilder, RequestContext},
    xml_documents,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::FromRow;
use std::{sync::Arc, time::Duration};
use ts_rs::TS;

const SOURCES: &str = "SELECT 'commercial'::text AS kind,id AS source_id,object_key,file_name,modified_at AS modified FROM commercial_documents UNION ALL SELECT 'file'::text,id AS source_id,object_key,file_name,COALESCE(office_modified_at,created_at) AS modified FROM project_files WHERE status='uploaded' AND lower(file_name) ~ '\\.(x80|x81|x82|x83|x84|x85|x86|x87|x31|x52|x89|x93|x94|x96|x97)$'";

pub fn register(
    builder: ProcedureRegistryBuilder,
    state: Arc<AppState>,
) -> ProcedureRegistryBuilder {
    builder.query(
        "gaeb.positions.search",
        move |context, input: SearchInput| {
            let state = Arc::clone(&state);
            async move { search(&state, &context, input).await }
        },
    )
}
pub fn register_contract(builder: ProcedureRegistryBuilder) -> ProcedureRegistryBuilder {
    builder.query_stub::<SearchInput, SearchOutput>("gaeb.positions.search")
}
#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase")]
struct SearchInput {
    query: String,
}
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct SearchOutput {
    items: Vec<Position>,
    indexing: bool,
}
#[derive(Serialize, TS, FromRow)]
#[serde(rename_all = "camelCase")]
struct Position {
    id: String,
    short_text: String,
    description: String,
    unit: String,
    source_file: String,
}
#[derive(FromRow)]
struct Source {
    kind: String,
    source_id: Id,
    object_key: String,
    file_name: String,
}
#[derive(Debug, PartialEq)]
struct Extracted {
    id: String,
    short_text: String,
    description: String,
    unit: String,
}

async fn search(
    state: &AppState,
    context: &RequestContext,
    input: SearchInput,
) -> RpcResult<SearchOutput> {
    if input.query.chars().count() > 200 {
        return Err(bad_request("Search is too long"));
    }
    let (auth, pool) = authorized_pool(state, context, "view:projects").await?;
    let sources = sqlx::query_as::<_, Source>(&format!("WITH sources AS ({SOURCES}) SELECT s.kind,s.source_id,s.object_key,s.file_name FROM sources s LEFT JOIN gaeb_position_sources i ON i.kind=s.kind AND i.source_id=s.source_id WHERE i.object_key IS DISTINCT FROM s.object_key ORDER BY s.modified DESC,s.source_id DESC LIMIT 5"))
        .fetch_all(&pool).await.map_err(internal)?;
    let indexing = sources.len() > 4;
    if !sources.is_empty() {
        let storage = xml_documents::required_storage(state, &auth.tenant).await?;
        for source in sources.into_iter().take(4) {
            let downloaded = tokio::time::timeout(
                Duration::from_secs(3),
                xml_documents::download_xml_object(&storage, &source.object_key, &source.file_name),
            )
            .await;
            let Ok(Ok(xml)) = downloaded else {
                continue;
            };
            let entries = tokio::task::spawn_blocking(move || extract(&xml))
                .await
                .map_err(internal)?
                .unwrap_or_default();
            let mut tx = pool.begin().await.map_err(internal)?;
            let locked: bool =
                sqlx::query_scalar("SELECT pg_try_advisory_xact_lock(hashtextextended($1,0))")
                    .bind(format!(
                        "gaeb-positions:{}:{}",
                        source.kind, source.source_id.0
                    ))
                    .fetch_one(&mut *tx)
                    .await
                    .map_err(internal)?;
            if !locked {
                continue;
            }
            let table = if source.kind == "commercial" {
                "commercial_documents"
            } else {
                "project_files"
            };
            let current: Option<String> = sqlx::query_scalar(&format!(
                "SELECT object_key FROM {table} WHERE id=$1 FOR SHARE"
            ))
            .bind(source.source_id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(internal)?;
            if current.as_deref() != Some(&source.object_key) {
                continue;
            }
            sqlx::query("INSERT INTO gaeb_position_sources(kind,source_id,object_key) VALUES($1,$2,$3) ON CONFLICT(kind,source_id) DO UPDATE SET object_key=EXCLUDED.object_key")
                .bind(&source.kind).bind(source.source_id).bind(&source.object_key).execute(&mut *tx).await.map_err(internal)?;
            sqlx::query("DELETE FROM gaeb_position_library WHERE kind=$1 AND source_id=$2")
                .bind(&source.kind)
                .bind(source.source_id)
                .execute(&mut *tx)
                .await
                .map_err(internal)?;
            for entry in entries {
                let fingerprint = Sha256::digest(
                    format!(
                        "{}\0{}\0{}",
                        entry.short_text, entry.description, entry.unit
                    )
                    .as_bytes(),
                )
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>();
                sqlx::query("INSERT INTO gaeb_position_library(kind,source_id,item_id,fingerprint,short_text,description,unit) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING")
                    .bind(&source.kind).bind(source.source_id).bind(entry.id).bind(fingerprint).bind(entry.short_text).bind(entry.description).bind(entry.unit).execute(&mut *tx).await.map_err(internal)?;
            }
            tx.commit().await.map_err(internal)?;
        }
    }
    let query = input
        .query
        .split(|c: char| !c.is_alphanumeric())
        .filter(|part| !part.is_empty())
        .take(12)
        .map(|part| format!("'{part}':*"))
        .collect::<Vec<_>>()
        .join(" & ");
    let items = sqlx::query_as::<_, Position>(&format!("WITH sources AS ({SOURCES}), matches AS (SELECT DISTINCT ON (p.fingerprint) p.fingerprint AS id,p.short_text,p.description,p.unit,s.file_name AS source_file,s.modified FROM gaeb_position_library p JOIN gaeb_position_sources i USING(kind,source_id) JOIN sources s ON s.kind=i.kind AND s.source_id=i.source_id AND s.object_key=i.object_key WHERE $1='' OR to_tsvector('simple',p.short_text || ' ' || p.description) @@ to_tsquery('simple',$1) ORDER BY p.fingerprint,s.modified DESC) SELECT id,short_text,description,unit,source_file FROM matches ORDER BY modified DESC,short_text LIMIT 20"))
        .bind(query).fetch_all(&pool).await.map_err(internal)?;
    Ok(SearchOutput { items, indexing })
}
fn plain(node: roxmltree::Node<'_, '_>, namespace: &str) -> String {
    fn visit(node: roxmltree::Node<'_, '_>, namespace: &str, out: &mut String) {
        if node.is_text() {
            out.push_str(node.text().unwrap_or_default());
            return;
        }
        if !node.is_element()
            || node.tag_name().namespace() != Some(namespace)
            || matches!(
                node.tag_name().name(),
                "Style" | "InlinePic" | "Pic" | "script"
            )
        {
            return;
        }
        let line = matches!(node.tag_name().name(), "p" | "br" | "tr" | "li");
        if line && !out.is_empty() && !out.ends_with('\n') {
            out.push('\n');
        }
        for child in node.children() {
            visit(child, namespace, out);
        }
        if line && !out.ends_with('\n') {
            out.push('\n');
        }
    }
    let mut value = String::new();
    visit(node, namespace, &mut value);
    value.trim().to_owned()
}
fn extract(xml: &str) -> Result<Vec<Extracted>, roxmltree::Error> {
    let doc = roxmltree::Document::parse_with_options(
        xml,
        roxmltree::ParsingOptions {
            allow_dtd: false,
            nodes_limit: 500_000,
            ..Default::default()
        },
    )?;
    let root = doc.root_element();
    let namespace = root.tag_name().namespace().unwrap_or_default();
    if root.tag_name().name() != "GAEB" || !namespace.starts_with("http://www.gaeb.de/GAEB_DA_XML/")
    {
        return Ok(vec![]);
    }
    let mut items = vec![];
    for item in root.descendants().filter(|n| {
        n.is_element()
            && n.tag_name().namespace() == Some(namespace)
            && matches!(n.tag_name().name(), "Item" | "OrderItem")
    }) {
        let find = |name| {
            item.descendants().find(|n| {
                n.is_element()
                    && n.tag_name().namespace() == Some(namespace)
                    && n.tag_name().name() == name
            })
        };
        let detail = find("DetailTxt")
            .map(|node| plain(node, namespace))
            .unwrap_or_default();
        let short = find("OutlTxt")
            .map(|node| plain(node, namespace))
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| detail.lines().next().unwrap_or_default().to_owned());
        let short_text = short.trim().to_owned();
        if short_text.is_empty() || short_text == "…" {
            continue;
        }
        let description = if detail
            .lines()
            .next()
            .is_some_and(|line| line.trim() == short_text)
        {
            detail
                .split_once('\n')
                .map(|(_, rest)| rest.trim().to_owned())
                .unwrap_or_default()
        } else {
            detail
        };
        items.push(Extracted {
            id: item
                .attribute("ID")
                .map(str::to_owned)
                .unwrap_or_else(|| items.len().to_string()),
            short_text,
            description,
            unit: find("QU")
                .map(|node| plain(node, namespace))
                .unwrap_or_default(),
        });
    }
    Ok(items)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn indexes_prefixed_native_short_long_text_and_unicode_without_prices() {
        let xml = r#"<g:GAEB xmlns:g="http://www.gaeb.de/GAEB_DA_XML/DA83/3.3"><g:Item ID="one"><g:QU>m²</g:QU><g:UP>999</g:UP><g:Description><g:DetailTxt><g:Text><g:p><g:span>Dämmung &amp; Putz</g:span></g:p><g:p><g:span>Wände vorbereiten.</g:span></g:p></g:Text></g:DetailTxt><g:OutlTxt><g:TextOutlTxt><g:p><g:span>Dämmung &amp; Putz</g:span></g:p></g:TextOutlTxt></g:OutlTxt></g:Description></g:Item></g:GAEB>"#;
        assert_eq!(
            extract(xml).unwrap(),
            vec![Extracted {
                id: "one".into(),
                short_text: "Dämmung & Putz".into(),
                description: "Wände vorbereiten.".into(),
                unit: "m²".into()
            }]
        );
    }
    #[test]
    fn retains_complete_long_descriptions_for_reuse() {
        let description = "Ausführliche Leistungsbeschreibung. ".repeat(1200);
        let xml = format!(
            "<GAEB xmlns=\"http://www.gaeb.de/GAEB_DA_XML/DA83/3.3\"><Item ID=\"large\"><DetailTxt><p><span>Kurztext</span></p><p><span>{description}</span></p></DetailTxt></Item></GAEB>"
        );
        let positions = extract(&xml).unwrap();
        assert_eq!(positions[0].description, description.trim());
    }
    #[test]
    fn rejects_entities_and_does_not_index_foreign_elements() {
        assert!(
            extract(r#"<!DOCTYPE GAEB [<!ENTITY x SYSTEM "file:///etc/passwd">]><GAEB>&x;</GAEB>"#)
                .is_err()
        );
        assert!(extract(r#"<GAEB xmlns="http://www.gaeb.de/GAEB_DA_XML/DA83/3.3"><Item xmlns="urn:other"><DetailTxt>Secret</DetailTxt></Item></GAEB>"#).unwrap().is_empty());
    }
}
