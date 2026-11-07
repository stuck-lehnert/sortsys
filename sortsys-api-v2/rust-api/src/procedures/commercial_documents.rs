//! Opaque native files for pre-project sales and project commercial workflows.
use super::{
    commercial::{self, CommercialCase},
    common::{bad_request, internal, not_found},
};
use crate::{
    AppState,
    auth::AuthResult,
    error::RpcResult,
    ids::Id,
    object_storage::{self, Audience},
    rpc::{ProcedureRegistryBuilder, RequestContext},
    xml_documents,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgPool};
use std::{collections::HashSet, sync::Arc};
use ts_rs::TS;

const DOCUMENT_SELECT: &str = "SELECT d.id,d.case_id,d.purpose,d.phase,d.file_name,d.version,d.read_only,d.source_document_id,d.source_version,source.version AS source_current_version,d.partner_name,d.net_amount::text AS net_amount,d.created_at,d.modified_at FROM commercial_documents d LEFT JOIN commercial_documents source ON source.id=d.source_document_id";
pub fn register(
    builder: ProcedureRegistryBuilder,
    state: Arc<AppState>,
) -> ProcedureRegistryBuilder {
    let adopt = Arc::clone(&state);
    let get = Arc::clone(&state);
    let create = Arc::clone(&state);
    let save = Arc::clone(&state);
    let finalize = Arc::clone(&state);
    builder
        .mutation(
            "commercial.cases.adoptContract",
            move |context, input: AdoptInput| {
                let state = Arc::clone(&adopt);
                async move { adopt_contract(&state, &context, input).await }
            },
        )
        .query(
            "commercial.documents.get",
            move |context, input: DocumentInput| {
                let state = Arc::clone(&get);
                async move { get_document(&state, &context, input).await }
            },
        )
        .mutation(
            "commercial.documents.create",
            move |context, input: CreateInput| {
                let state = Arc::clone(&create);
                async move { create_document(&state, &context, input).await }
            },
        )
        .mutation(
            "commercial.documents.save",
            move |context, input: SaveInput| {
                let state = Arc::clone(&save);
                async move { save_document(&state, &context, input).await }
            },
        )
        .mutation(
            "commercial.documents.finalize",
            move |context, input: VersionInput| {
                let state = Arc::clone(&finalize);
                async move { finalize_document(&state, &context, input).await }
            },
        )
        .query(
            "commercial.documents.download",
            move |context, input: DocumentInput| {
                let state = Arc::clone(&state);
                async move { download(&state, &context, input).await }
            },
        )
}
pub fn register_contract(builder: ProcedureRegistryBuilder) -> ProcedureRegistryBuilder {
    builder
        .mutation_stub::<AdoptInput, CreatedDocument>("commercial.cases.adoptContract")
        .query_stub::<DocumentInput, DocumentContent>("commercial.documents.get")
        .mutation_stub::<CreateInput, CreatedDocument>("commercial.documents.create")
        .mutation_stub::<SaveInput, SavedDocument>("commercial.documents.save")
        .mutation_stub::<VersionInput, SavedDocument>("commercial.documents.finalize")
        .query_stub::<DocumentInput, Download>("commercial.documents.download")
}
pub async fn list(pool: &PgPool, case: &CommercialCase) -> RpcResult<Vec<Document>> {
    sqlx::query_as::<_, Document>(&format!(
        "{DOCUMENT_SELECT} WHERE d.case_id=$1 ORDER BY d.created_at,d.id"
    ))
    .bind(case.id)
    .fetch_all(pool)
    .await
    .map_err(internal)
}
async fn stored(pool: &PgPool, input: &DocumentInput) -> RpcResult<StoredDocument> {
    sqlx::query_as::<_,StoredDocument>("SELECT id,case_id,purpose,phase,file_name,version,read_only,object_key,source_document_id,source_version FROM commercial_documents WHERE id=$1 AND case_id=$2").bind(input.id).bind(input.case_id).fetch_optional(pool).await.map_err(internal)?.ok_or_else(not_found)
}
async fn get_document(
    state: &AppState,
    context: &RequestContext,
    input: DocumentInput,
) -> RpcResult<DocumentContent> {
    let (auth, pool) = commercial::access(state, context, false).await?;
    let mut tx = pool.begin().await.map_err(internal)?;
    let case = commercial::locked_case(&mut tx, input.case_id).await?;
    let row=sqlx::query_as::<_,StoredDocument>("SELECT id,case_id,purpose,phase,file_name,version,read_only,object_key,source_document_id,source_version FROM commercial_documents WHERE id=$1 AND case_id=$2 FOR SHARE").bind(input.id).bind(input.case_id).fetch_optional(&mut *tx).await.map_err(internal)?.ok_or_else(not_found)?;
    let storage = xml_documents::required_storage(state, &auth.tenant).await?;
    let xml = xml_documents::download_xml_object(&storage, &row.object_key, &row.file_name).await?;
    let mut reference_xml = None;
    let mut source = row.source_document_id;
    let mut visited = HashSet::new();
    while let Some(id) = source {
        if visited.len() >= 8 || !visited.insert(id) {
            break;
        }
        let reference=sqlx::query_as::<_,ReferenceDocument>("SELECT d.case_id,d.phase,d.file_name,d.object_key,d.source_document_id,c.project_id FROM commercial_documents d JOIN commercial_cases c ON c.id=d.case_id WHERE d.id=$1").bind(id).fetch_optional(&mut *tx).await.map_err(internal)?.ok_or_else(not_found)?;
        if reference.case_id != case.id
            && !(case.kind == "alternative" && Some(reference.case_id) == case.parent_case_id)
            && (case.project_id.is_none() || reference.project_id != case.project_id)
        {
            return Err(not_found());
        }
        if matches!(reference.phase.as_str(), "83" | "86") {
            reference_xml = Some(
                xml_documents::download_xml_object(
                    &storage,
                    &reference.object_key,
                    &reference.file_name,
                )
                .await?,
            );
            break;
        }
        source = reference.source_document_id;
    }
    let source_current = if let Some(id) = row.source_document_id {
        Some(
            sqlx::query_scalar::<_, i64>("SELECT version FROM commercial_documents WHERE id=$1")
                .bind(id)
                .fetch_one(&mut *tx)
                .await
                .map_err(internal)?,
        )
    } else {
        None
    };
    tx.commit().await.map_err(internal)?;
    Ok(DocumentContent {
        xml,
        reference_xml,
        file_name: row.file_name,
        version: row.version,
        can_edit: auth.can_do("manage:projects")
            && commercial::document_editable(&case, &row.purpose, row.read_only)
            && (row.purpose != "offer" || row.source_version == source_current),
        live_ticket: crate::xml_live::commercial_ticket(state, &auth, input.case_id, input.id)?,
        live_path: crate::xml_live::WS_PATH.to_owned(),
        recovery_scope: format!("{}:{}:commercial", auth.tenant, auth.user.id),
    })
}
fn purpose_phase(purpose: &str) -> Option<&'static str> {
    match purpose {
        "inquiry" => Some("83"),
        "offer" => Some("84"),
        "alternative" => Some("85"),
        "order" => Some("86"),
        "confirmation" => Some("87"),
        "measurement" => Some("31"),
        "calculation" => Some("52"),
        "invoice" => Some("89"),
        "price_inquiry" => Some("93"),
        "supplier_offer" => Some("94"),
        "purchase_order" => Some("96"),
        "supplier_confirmation" => Some("97"),
        _ => None,
    }
}

fn check_amount(amount: Option<&str>, negative: bool) -> RpcResult<()> {
    if let Some(value) = amount {
        let valid = regex::Regex::new(r"^-?\d{1,13}(?:\.\d{1,2})?$")
            .unwrap()
            .is_match(value);
        if !valid || (!negative && value.starts_with('-')) {
            return Err(bad_request("Invalid net amount"));
        }
    }
    Ok(())
}
async fn create_document(
    state: &AppState,
    context: &RequestContext,
    input: CreateInput,
) -> RpcResult<CreatedDocument> {
    let (auth, pool) = commercial::access(state, context, true).await?;
    xml_documents::validate_xml(&input.xml)?;
    let phase =
        purpose_phase(&input.purpose).ok_or_else(|| bad_request("Invalid document purpose"))?;
    if input.file_name.is_empty()
        || input.file_name.len() > 255
        || input.file_name.contains(['/', '\\', '\0'])
        || !input
            .file_name
            .to_lowercase()
            .ends_with(&format!(".x{phase}"))
    {
        return Err(bad_request("Use the correct native GAEB file extension"));
    }
    let actor = auth.user.id.parse::<i64>().map_err(internal)?;
    let mut tx = pool.begin().await.map_err(internal)?;
    let case = commercial::locked_case(&mut tx, input.case_id).await?;
    let allowed = match input.purpose.as_str() {
        "inquiry" => {
            case.status == "draft"
                && matches!(case.kind.as_str(), "offer" | "variation" | "subcontract")
        }
        "offer" => {
            if case.kind == "subcontract" {
                case.status == "requested"
            } else {
                case.status == "draft" && matches!(case.kind.as_str(), "offer" | "variation")
            }
        }
        "order" => {
            matches!(
                case.kind.as_str(),
                "offer" | "variation" | "alternative" | "subcontract"
            ) && matches!(case.status.as_str(), "sent" | "accepted" | "requested")
        }
        "confirmation" => {
            matches!(
                case.kind.as_str(),
                "offer" | "variation" | "alternative" | "subcontract"
            ) && (case.status == "accepted" || case.status == "awarded")
        }
        "measurement" => case.kind == "measurement" && case.status == "draft",
        "alternative" => case.kind == "alternative" && case.status == "draft",
        "calculation" => case.kind == "calculation" && case.status == "draft",
        "invoice" => super::commercial_billing::is_invoice(&case.kind) && case.status == "draft",
        "price_inquiry" => case.kind == "procurement" && case.status == "draft",
        "supplier_offer" | "purchase_order" => {
            case.kind == "procurement" && case.status == "requested"
        }
        "supplier_confirmation" => case.kind == "procurement" && case.status == "awarded",
        _ => false,
    };
    if !allowed {
        return Err(commercial::conflict(
            "This document does not belong to the current workflow step",
        ));
    }
    check_amount(input.net_amount.as_deref(), case.kind == "variation")?;
    if input.purpose == "invoice" {
        super::commercial_billing::validate_document(
            &mut tx,
            &case,
            &input.xml,
            input.net_amount.as_deref(),
        )
        .await?;
    }
    if matches!(
        input.purpose.as_str(),
        "supplier_offer" | "supplier_confirmation"
    ) && !input.read_only
    {
        return Err(bad_request("Received supplier documents are immutable"));
    }
    if matches!(case.kind.as_str(), "subcontract" | "procurement")
        && matches!(input.purpose.as_str(), "offer" | "supplier_offer")
        && input
            .partner_name
            .as_ref()
            .is_none_or(|name| name.trim().is_empty() || name.len() > 127)
    {
        return Err(bad_request("Enter the subcontractor's company name"));
    }
    if let Some(source_id) = input.source_document_id {
        if Some(source_id) == input.replace_document_id {
            return Err(bad_request("A document cannot refer to itself"));
        }
        let source=sqlx::query_as::<_,SourceDocument>("SELECT d.case_id,d.phase,d.version,c.project_id,c.status FROM commercial_documents d JOIN commercial_cases c ON c.id=d.case_id WHERE d.id=$1").bind(source_id).fetch_optional(&mut *tx).await.map_err(internal)?.ok_or_else(not_found)?;
        if input.source_version != Some(source.version) {
            return Err(commercial::conflict(
                "The source document changed; please refresh it",
            ));
        }
        if source.case_id != case.id
            && !(case.kind == "alternative" && Some(source.case_id) == case.parent_case_id)
            && (case.project_id.is_none()
                || source.project_id != case.project_id
                || source.status != "accepted"
                || ![
                    "inquiry",
                    "measurement",
                    "calculation",
                    "invoice",
                    "alternative",
                    "price_inquiry",
                ]
                .contains(&input.purpose.as_str()))
        {
            return Err(not_found());
        }
        let source_ok = match input.purpose.as_str() {
            "offer" => source.phase == "83",
            "order" => matches!(source.phase.as_str(), "84" | "85"),
            "confirmation" => source.phase == "86",
            "inquiry" | "measurement" | "price_inquiry" => {
                matches!(source.phase.as_str(), "84" | "85" | "86")
            }
            "alternative" | "calculation" | "invoice" => {
                matches!(source.phase.as_str(), "83" | "84" | "85" | "86" | "31")
            }
            "supplier_offer" => source.phase == "93",
            "purchase_order" => source.phase == "94",
            "supplier_confirmation" => source.phase == "96",
            _ => false,
        };
        if !source_ok {
            return Err(bad_request(
                "The source document has the wrong workflow phase",
            ));
        }
    } else if input.source_version.is_some() {
        return Err(bad_request("Missing source document"));
    }
    let replacing = if let Some(id) = input.replace_document_id {
        let row=sqlx::query_as::<_,StoredDocument>("SELECT id,case_id,purpose,phase,file_name,version,read_only,object_key,source_document_id,source_version FROM commercial_documents WHERE id=$1 AND case_id=$2 FOR UPDATE").bind(id).bind(case.id).fetch_optional(&mut *tx).await.map_err(internal)?.ok_or_else(not_found)?;
        if row.read_only {
            return Err(commercial::conflict(
                "This document is finalized or belongs to an immutable source",
            ));
        }
        if row.purpose != input.purpose || input.expected_version != Some(row.version) {
            return Err(commercial::conflict(
                "The document changed in another editor",
            ));
        }
        Some(row)
    } else {
        None
    };
    if input.purpose == "offer" && case.kind != "subcontract" && replacing.is_none() {
        let count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM commercial_documents WHERE case_id=$1 AND purpose='offer'",
        )
        .bind(case.id)
        .fetch_one(&mut *tx)
        .await
        .map_err(internal)?;
        if count > 0 {
            return Err(bad_request(
                "Revise the existing offer; create variations in the project",
            ));
        }
    }
    let storage = xml_documents::required_storage(state, &auth.tenant).await?;
    let key = object_storage::build_commercial_object_key(&storage, case.id, &input.file_name);
    xml_documents::upload_xml(&storage, &key, &input.xml).await?;
    let result = if let Some(row) = &replacing {
        sqlx::query_scalar::<_,Id>("UPDATE commercial_documents SET file_name=$2,object_key=$3,version=version+1,size_bytes=$4,read_only=$5,source_document_id=$6,source_version=$7,partner_name=$8,net_amount=$9::numeric,modified_at=NOW() WHERE id=$1 RETURNING id").bind(row.id).bind(&input.file_name).bind(&key).bind(input.xml.len() as i64).bind(input.read_only).bind(input.source_document_id).bind(input.source_version).bind(&input.partner_name).bind(&input.net_amount).fetch_one(&mut *tx).await
    } else {
        sqlx::query_scalar::<_,Id>("INSERT INTO commercial_documents(case_id,purpose,phase,file_name,object_key,size_bytes,read_only,source_document_id,source_version,partner_name,net_amount,created_by_user_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::numeric,$12) RETURNING id").bind(case.id).bind(&input.purpose).bind(phase).bind(&input.file_name).bind(&key).bind(input.xml.len() as i64).bind(input.read_only).bind(input.source_document_id).bind(input.source_version).bind(&input.partner_name).bind(&input.net_amount).bind(actor).fetch_one(&mut *tx).await
    };
    let id = match result {
        Ok(id) => id,
        Err(error) => {
            let _ = object_storage::delete_object(&storage, &key).await;
            return Err(internal(error));
        }
    };
    if (input.purpose == "offer" && case.kind != "subcontract")
        || matches!(input.purpose.as_str(), "alternative" | "invoice")
    {
        sqlx::query("UPDATE commercial_cases SET net_amount=$2::numeric WHERE id=$1")
            .bind(case.id)
            .bind(&input.net_amount)
            .execute(&mut *tx)
            .await
            .map_err(internal)?;
    }
    commercial::event(
        &mut tx,
        case.id,
        "document_created",
        Some(&case.status),
        &case.status,
        actor,
    )
    .await?;
    tx.commit().await.map_err(internal)?;
    if let Some(row) = replacing {
        cleanup_old(&storage, &pool, row.id, &row.object_key).await;
    }
    Ok(CreatedDocument { id })
}
async fn save_document(
    state: &AppState,
    context: &RequestContext,
    input: SaveInput,
) -> RpcResult<SavedDocument> {
    let (auth, pool) = commercial::access(state, context, true).await?;
    xml_documents::validate_xml(&input.xml)?;
    let mut tx = pool.begin().await.map_err(internal)?;
    let case = commercial::locked_case(&mut tx, input.case_id).await?;
    let row=sqlx::query_as::<_,StoredDocument>("SELECT id,case_id,purpose,phase,file_name,version,read_only,object_key,source_document_id,source_version FROM commercial_documents WHERE id=$1 AND case_id=$2 FOR UPDATE").bind(input.id).bind(case.id).fetch_optional(&mut *tx).await.map_err(internal)?.ok_or_else(not_found)?;
    if !commercial::document_editable(&case, &row.purpose, row.read_only) {
        return Err(commercial::conflict(
            "This document is finalized or belongs to an immutable source",
        ));
    }
    if row.version != input.version {
        return Err(commercial::conflict(
            "The document was changed in another editor",
        ));
    }
    if row.purpose == "offer"
        && let Some(source) = row.source_document_id
    {
        let version: i64 =
            sqlx::query_scalar("SELECT version FROM commercial_documents WHERE id=$1")
                .bind(source)
                .fetch_one(&mut *tx)
                .await
                .map_err(internal)?;
        if row.source_version != Some(version) {
            return Err(commercial::conflict(
                "Update the calculation from the revised scope first",
            ));
        }
    }
    check_amount(input.net_amount.as_deref(), case.kind == "variation")?;
    if row.purpose == "invoice" {
        super::commercial_billing::validate_document(
            &mut tx,
            &case,
            &input.xml,
            input.net_amount.as_deref(),
        )
        .await?;
    }
    let title = xml_documents::internal_document_title(&input.xml)?;
    let storage = xml_documents::required_storage(state, &auth.tenant).await?;
    let key = object_storage::build_commercial_object_key(&storage, case.id, &row.file_name);
    xml_documents::upload_xml(&storage, &key, &input.xml).await?;
    let version = row.version + 1;
    if let Err(error)=sqlx::query("UPDATE commercial_documents SET object_key=$2,size_bytes=$3,version=$4,net_amount=$5::numeric,modified_at=NOW() WHERE id=$1").bind(row.id).bind(&key).bind(input.xml.len() as i64).bind(version).bind(&input.net_amount).execute(&mut *tx).await {let _=object_storage::delete_object(&storage,&key).await;return Err(internal(error));}
    if (row.purpose == "offer" && case.kind != "subcontract")
        || matches!(row.purpose.as_str(), "alternative" | "invoice")
    {
        sqlx::query("UPDATE commercial_cases SET net_amount=$2::numeric WHERE id=$1")
            .bind(case.id)
            .bind(&input.net_amount)
            .execute(&mut *tx)
            .await
            .map_err(internal)?;
    }

    if let Some(title) = title.as_ref() {
        sqlx::query("UPDATE commercial_cases SET title=$2,modified_at=NOW() WHERE id=$1")
            .bind(case.id)
            .bind(title)
            .execute(&mut *tx)
            .await
            .map_err(internal)?;
    }
    tx.commit().await.map_err(internal)?;
    cleanup_old(&storage, &pool, row.id, &row.object_key).await;
    Ok(SavedDocument {
        version,
        saved_at: Utc::now(),
    })
}
async fn cleanup_old(storage: &object_storage::EnabledStorage, pool: &PgPool, id: Id, key: &str) {
    let protected=sqlx::query_scalar::<_,bool>("SELECT EXISTS(SELECT 1 FROM commercial_document_snapshots WHERE document_id=$1 AND object_key=$2)").bind(id).bind(key).fetch_one(pool).await.unwrap_or(true);
    if !protected {
        let _ = object_storage::delete_object(storage, key).await;
    }
}
async fn finalize_document(
    state: &AppState,
    context: &RequestContext,
    input: VersionInput,
) -> RpcResult<SavedDocument> {
    let (auth, pool) = commercial::access(state, context, true).await?;
    let actor = auth.user.id.parse::<i64>().map_err(internal)?;
    let mut tx = pool.begin().await.map_err(internal)?;
    let case = commercial::locked_case(&mut tx, input.case_id).await?;
    if !matches!(case.status.as_str(), "accepted" | "awarded") {
        return Err(commercial::conflict(
            "This document does not belong to the current workflow step",
        ));
    }
    let updated=sqlx::query("UPDATE commercial_documents SET read_only=TRUE,version=version+1 WHERE id=$1 AND case_id=$2 AND version=$3 AND purpose='confirmation' AND NOT read_only").bind(input.id).bind(case.id).bind(input.version).execute(&mut *tx).await.map_err(internal)?;
    if updated.rows_affected() != 1 {
        return Err(commercial::conflict(
            "The confirmation changed in another editor",
        ));
    }
    sqlx::query("INSERT INTO commercial_document_snapshots(document_id,version,object_key,event) SELECT id,version,object_key,'finalized' FROM commercial_documents WHERE id=$1 ON CONFLICT(document_id,version) DO NOTHING").bind(input.id).execute(&mut *tx).await.map_err(internal)?;
    commercial::event(
        &mut tx,
        case.id,
        "confirmation_finalized",
        Some(&case.status),
        &case.status,
        actor,
    )
    .await?;
    tx.commit().await.map_err(internal)?;
    Ok(SavedDocument {
        version: input.version + 1,
        saved_at: Utc::now(),
    })
}
async fn download(
    state: &AppState,
    context: &RequestContext,
    input: DocumentInput,
) -> RpcResult<Download> {
    let (auth, pool) = commercial::access(state, context, false).await?;
    commercial::case_by_id(&pool, input.case_id).await?;
    let row = stored(&pool, &input).await?;
    let storage = xml_documents::required_storage(state, &auth.tenant).await?;
    let signed = object_storage::create_download_url(
        &storage,
        &row.object_key,
        Some(&row.file_name),
        false,
        Audience::Public,
    )?;
    Ok(Download {
        url: signed.download_url,
        file_name: row.file_name,
    })
}
pub async fn live_version(
    state: &AppState,
    headers: &axum::http::HeaderMap,
    case_id: Id,
    id: Id,
) -> RpcResult<(AuthResult, i64, bool)> {
    let context = RequestContext {
        headers: headers.clone(),
    };
    let (auth, pool) = commercial::access(state, &context, false).await?;
    let case = commercial::case_by_id(&pool, case_id).await?;
    let row = stored(&pool, &DocumentInput { case_id, id }).await?;
    let source_current = if let Some(source) = row.source_document_id {
        Some(
            sqlx::query_scalar::<_, i64>("SELECT version FROM commercial_documents WHERE id=$1")
                .bind(source)
                .fetch_one(&pool)
                .await
                .map_err(internal)?,
        )
    } else {
        None
    };
    let editable = auth.can_do("manage:projects")
        && commercial::document_editable(&case, &row.purpose, row.read_only)
        && (row.purpose != "offer" || row.source_version == source_current);
    Ok((auth, row.version, editable))
}
#[derive(Clone, Serialize, FromRow, TS)]
#[serde(rename_all = "camelCase")]
pub struct Document {
    pub id: Id,
    pub case_id: Id,
    pub purpose: String,
    pub phase: String,
    pub file_name: String,
    pub version: i64,
    pub read_only: bool,
    pub source_document_id: Option<Id>,
    pub source_version: Option<i64>,
    pub source_current_version: Option<i64>,
    pub partner_name: Option<String>,
    pub net_amount: Option<String>,
    pub created_at: DateTime<Utc>,
    pub modified_at: DateTime<Utc>,
}
#[derive(FromRow)]
struct StoredDocument {
    id: Id,
    purpose: String,
    file_name: String,
    version: i64,
    read_only: bool,
    object_key: String,
    source_document_id: Option<Id>,
    source_version: Option<i64>,
}
#[derive(FromRow)]
struct ReferenceDocument {
    case_id: Id,
    phase: String,
    file_name: String,
    object_key: String,
    source_document_id: Option<Id>,
    project_id: Option<Id>,
}
#[derive(FromRow)]
struct SourceDocument {
    case_id: Id,
    phase: String,
    version: i64,
    project_id: Option<Id>,
    status: String,
}
#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DocumentInput {
    case_id: Id,
    id: Id,
}
#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VersionInput {
    case_id: Id,
    id: Id,
    version: i64,
}
#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SaveInput {
    case_id: Id,
    id: Id,
    version: i64,
    xml: String,
    #[serde(default)]
    #[ts(optional=nullable)]
    net_amount: Option<String>,
}
#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateInput {
    case_id: Id,
    purpose: String,
    file_name: String,
    xml: String,
    #[serde(default)]
    read_only: bool,
    #[serde(default)]
    #[ts(optional=nullable)]
    net_amount: Option<String>,
    #[serde(default)]
    #[ts(optional=nullable)]
    partner_name: Option<String>,
    #[serde(default)]
    #[ts(optional=nullable)]
    source_document_id: Option<Id>,
    #[serde(default)]
    #[ts(optional=nullable)]
    source_version: Option<i64>,
    #[serde(default)]
    #[ts(optional=nullable)]
    replace_document_id: Option<Id>,
    #[serde(default)]
    #[ts(optional=nullable)]
    expected_version: Option<i64>,
}
#[derive(Serialize, TS)]
struct CreatedDocument {
    id: Id,
}
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct SavedDocument {
    version: i64,
    saved_at: DateTime<Utc>,
}
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct Download {
    url: String,
    file_name: String,
}
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct DocumentContent {
    xml: String,
    reference_xml: Option<String>,
    file_name: String,
    version: i64,
    can_edit: bool,
    live_ticket: String,
    live_path: String,
    recovery_scope: String,
}

#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AdoptInput {
    project_id: Id,
    title: String,
    order_xml: String,
    offer_xml: String,
    net_amount: String,
}
async fn adopt_contract(
    state: &AppState,
    context: &RequestContext,
    mut input: AdoptInput,
) -> RpcResult<CreatedDocument> {
    let (auth, pool) = commercial::access(state, context, true).await?;
    super::common::trim_required(&mut input.title, "title", 127)?;
    xml_documents::validate_xml(&input.order_xml)?;
    xml_documents::validate_xml(&input.offer_xml)?;
    check_amount(Some(&input.net_amount), false)?;
    let storage = xml_documents::required_storage(state, &auth.tenant).await?;
    let actor = auth.user.id.parse::<i64>().map_err(internal)?;
    let mut tx = pool.begin().await.map_err(internal)?;
    sqlx::query("SELECT id FROM projects WHERE id=$1 AND finished_at IS NULL FOR UPDATE")
        .bind(input.project_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(internal)?
        .ok_or_else(not_found)?;
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM commercial_cases WHERE project_id=$1 AND kind='offer')",
    )
    .bind(input.project_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(internal)?;
    if exists {
        return Err(commercial::conflict(
            "The project already has a main contract",
        ));
    }
    let id:Id=sqlx::query_scalar("INSERT INTO commercial_cases(reference,kind,status,title,existing_contract,project_id,customer_id,net_amount,accepted_at,created_by_user_id) SELECT 'BES-'||TO_CHAR(NOW(),'YYYY')||'-'||nextval('commercial_case_number_seq')::text,'offer','accepted',$2,TRUE,id,customer_id,$3::numeric,COALESCE(order_received_at,NOW()),$4 FROM projects WHERE id=$1 RETURNING id").bind(input.project_id).bind(&input.title).bind(&input.net_amount).bind(actor).fetch_one(&mut *tx).await.map_err(internal)?;
    let order_key = object_storage::build_commercial_object_key(&storage, id, "Auftrag.x86");
    let offer_key = object_storage::build_commercial_object_key(&storage, id, "Vertragspreise.x84");
    xml_documents::upload_xml(&storage, &order_key, &input.order_xml).await?;
    if let Err(error) = xml_documents::upload_xml(&storage, &offer_key, &input.offer_xml).await {
        let _ = object_storage::delete_object(&storage, &order_key).await;
        return Err(error);
    }
    let order_id:Id=sqlx::query_scalar("INSERT INTO commercial_documents(case_id,purpose,phase,file_name,object_key,size_bytes,read_only,created_by_user_id,net_amount) VALUES($1,'order','86','Auftrag.x86',$2,$3,TRUE,$4,$5::numeric) RETURNING id").bind(id).bind(&order_key).bind(input.order_xml.len() as i64).bind(actor).bind(&input.net_amount).fetch_one(&mut *tx).await.map_err(internal)?;
    sqlx::query("INSERT INTO commercial_documents(case_id,purpose,phase,file_name,object_key,size_bytes,read_only,created_by_user_id,net_amount,source_document_id,source_version) VALUES($1,'offer','84','Vertragspreise.x84',$2,$3,TRUE,$4,$5::numeric,$6,1)").bind(id).bind(&offer_key).bind(input.offer_xml.len() as i64).bind(actor).bind(&input.net_amount).bind(order_id).execute(&mut *tx).await.map_err(internal)?;
    // Preserve legacy bookkeeping. Adoption never adds the contract amount twice.
    sqlx::query("INSERT INTO project_financial_entries(project_id,type,amount,comment,created_by_user_id,commercial_case_id) SELECT $1,'offer',$2::numeric::double precision,$3,$4,$5 WHERE NOT EXISTS(SELECT 1 FROM project_financial_entries WHERE project_id=$1 AND type='offer')").bind(input.project_id).bind(&input.net_amount).bind(&input.title).bind(actor).bind(id).execute(&mut *tx).await.map_err(internal)?;
    sqlx::query("INSERT INTO commercial_document_snapshots(document_id,version,object_key,event) SELECT id,version,object_key,'existing_contract' FROM commercial_documents WHERE case_id=$1").bind(id).execute(&mut *tx).await.map_err(internal)?;
    commercial::event(&mut tx, id, "existing_contract", None, "accepted", actor).await?;
    tx.commit().await.map_err(internal)?;
    Ok(CreatedDocument { id })
}
