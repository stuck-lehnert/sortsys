//! Contractor sales, changes, subcontract packages and measured-work workflows.
use super::common::{authorized_pool, bad_request, internal, not_found, trim_required};
use crate::{
    AppState,
    api::Success,
    auth::AuthResult,
    error::{ErrorCode, RpcError, RpcResult},
    ids::Id,
    rpc::{ProcedureRegistryBuilder, RequestContext},
};
use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgConnection, PgPool};
use std::sync::Arc;
use ts_rs::TS;

const CASE_SELECT: &str = "SELECT c.id,c.reference,c.kind,c.status,c.title,c.existing_contract,c.project_id,project.title AS project_title,c.parent_case_id,c.customer_id,customer.name AS customer_name,c.counterparty_name,c.currency,c.net_amount::text AS net_amount,c.valid_until,c.notes,c.scope_item_ids,c.selected_offer_document_id,c.accepted_at,c.created_at,c.modified_at FROM commercial_cases c LEFT JOIN customers customer ON customer.id=c.customer_id LEFT JOIN projects project ON project.id=c.project_id";

pub fn register(
    builder: ProcedureRegistryBuilder,
    state: Arc<AppState>,
) -> ProcedureRegistryBuilder {
    let list = Arc::clone(&state);
    let get = Arc::clone(&state);
    let create = Arc::clone(&state);
    let update = Arc::clone(&state);
    let transition = Arc::clone(&state);
    builder
        .query("commercial.cases.list", move |context, input: ListInput| {
            let state = Arc::clone(&list);
            async move { list_cases(&state, &context, input).await }
        })
        .query("commercial.cases.get", move |context, input: CaseInput| {
            let state = Arc::clone(&get);
            async move { get_case(&state, &context, input.id).await }
        })
        .mutation(
            "commercial.cases.create",
            move |context, input: CreateInput| {
                let state = Arc::clone(&create);
                async move { create_case(&state, &context, input).await }
            },
        )
        .mutation(
            "commercial.cases.update",
            move |context, input: UpdateInput| {
                let state = Arc::clone(&update);
                async move { update_case(&state, &context, input).await }
            },
        )
        .mutation(
            "commercial.cases.transition",
            move |context, input: TransitionInput| {
                let state = Arc::clone(&transition);
                async move { transition_case(&state, &context, input).await }
            },
        )
        .mutation(
            "commercial.cases.createProject",
            move |context, input: CaseInput| {
                let state = Arc::clone(&state);
                async move { create_project(&state, &context, input.id).await }
            },
        )
}

pub fn register_contract(builder: ProcedureRegistryBuilder) -> ProcedureRegistryBuilder {
    builder
        .query_stub::<ListInput, Vec<CommercialCase>>("commercial.cases.list")
        .query_stub::<CaseInput, CaseDetail>("commercial.cases.get")
        .mutation_stub::<CreateInput, CreatedId>("commercial.cases.create")
        .mutation_stub::<UpdateInput, Success>("commercial.cases.update")
        .mutation_stub::<TransitionInput, Success>("commercial.cases.transition")
        .mutation_stub::<CaseInput, CreatedId>("commercial.cases.createProject")
}
pub async fn access(
    state: &AppState,
    context: &RequestContext,
    manage: bool,
) -> RpcResult<(AuthResult, PgPool)> {
    if manage {
        authorized_pool(state, context, "manage:projects").await
    } else {
        authorized_pool(state, context, "view:projects").await
    }
}
pub async fn locked_case(connection: &mut PgConnection, id: Id) -> RpcResult<CommercialCase> {
    sqlx::query_as::<_, CommercialCase>(&format!("{CASE_SELECT} WHERE c.id=$1 FOR UPDATE OF c"))
        .bind(id)
        .fetch_optional(connection)
        .await
        .map_err(internal)?
        .ok_or_else(not_found)
}
pub async fn case_by_id(pool: &PgPool, id: Id) -> RpcResult<CommercialCase> {
    sqlx::query_as::<_, CommercialCase>(&format!("{CASE_SELECT} WHERE c.id=$1"))
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(internal)?
        .ok_or_else(not_found)
}
async fn list_cases(
    state: &AppState,
    context: &RequestContext,
    input: ListInput,
) -> RpcResult<Vec<CommercialCase>> {
    let (_, pool) = access(state, context, false).await?;
    let limit = input.limit.unwrap_or(100).clamp(1, 200);
    sqlx::query_as::<_,CommercialCase>(&format!("{CASE_SELECT} WHERE ($1::bigint IS NULL OR c.project_id=$1) AND ($2::text IS NULL OR c.kind=$2 OR ($2='sales' AND c.kind IN ('offer','alternative'))) AND ($3::text IS NULL OR c.status=$3) AND ($4::text IS NULL OR c.title ILIKE '%'||$4||'%' OR c.reference ILIKE '%'||$4||'%' OR customer.name ILIKE '%'||$4||'%') ORDER BY c.created_at DESC,c.id DESC LIMIT $5 OFFSET $6"))
      .bind(input.project_id).bind(input.kind).bind(input.status).bind(input.search.filter(|value|!value.trim().is_empty())).bind(limit).bind(input.offset.unwrap_or(0).max(0)).fetch_all(&pool).await.map_err(internal)
}
pub(crate) async fn get_case(
    state: &AppState,
    context: &RequestContext,
    id: Id,
) -> RpcResult<CaseDetail> {
    let (auth, pool) = access(state, context, false).await?;
    let case = case_by_id(&pool, id).await?;
    let documents = super::commercial_documents::list(&pool, &case).await?;
    let events=sqlx::query_as::<_,CaseEvent>("SELECT event.id,event.action,event.previous_status,event.status,event.created_at,CONCAT_WS(' ',actor.first_name,actor.last_name) AS actor FROM commercial_case_events event LEFT JOIN users actor ON actor.id=event.created_by_user_id WHERE event.case_id=$1 ORDER BY event.created_at,event.id").bind(id).fetch_all(&pool).await.map_err(internal)?;
    let invoice = super::commercial_billing::details(&pool, id).await?;
    Ok(CaseDetail {
        case,
        documents,
        events,
        invoice,
        can_manage: auth.can_do("manage:projects"),
    })
}
async fn create_case(
    state: &AppState,
    context: &RequestContext,
    mut input: CreateInput,
) -> RpcResult<CreatedId> {
    let (auth, pool) = access(state, context, true).await?;
    trim_required(&mut input.title, "title", 127)?;
    if ![
        "offer",
        "variation",
        "alternative",
        "subcontract",
        "measurement",
        "procurement",
        "calculation",
        "invoice",
        "progress_invoice",
        "final_invoice",
    ]
    .contains(&input.kind.as_str())
    {
        return Err(bad_request("Invalid commercial workflow"));
    }
    if input.kind == "offer" && (input.project_id.is_some() || input.parent_case_id.is_some()) {
        return Err(bad_request(
            "A new main offer must start before a new project",
        ));
    }
    if !matches!(input.kind.as_str(), "offer" | "alternative") && input.project_id.is_none() {
        return Err(bad_request("This workflow belongs to an existing project"));
    }
    if let Some(project) = input.project_id {
        let active: Option<bool> =
            sqlx::query_scalar("SELECT finished_at IS NULL FROM projects WHERE id=$1")
                .bind(project)
                .fetch_optional(&pool)
                .await
                .map_err(internal)?;
        if active != Some(true) {
            return Err(bad_request("The project must be active"));
        }
    }
    if matches!(input.kind.as_str(), "measurement" | "subcontract")
        && (input.parent_case_id.is_none() || input.scope_item_ids.is_empty())
    {
        return Err(bad_request(
            "Choose an accepted contract and its work items",
        ));
    }
    if let Some(parent) = input.parent_case_id {
        let parent = case_by_id(&pool, parent).await?;
        if parent.project_id != input.project_id
            || !["offer", "variation", "alternative"].contains(&parent.kind.as_str())
            || (input.kind != "alternative" && parent.status != "accepted")
            || (input.kind == "alternative"
                && !["draft", "sent", "accepted"].contains(&parent.status.as_str()))
        {
            return Err(bad_request("Choose an accepted contract in this project"));
        }
    }
    if (input.kind == "alternative"
        || super::commercial_billing::is_invoice(&input.kind)
        || input.kind == "calculation")
        && input.parent_case_id.is_none()
    {
        return Err(bad_request("Choose the related contract or main offer"));
    }
    if input.billing_basis.is_some() && !super::commercial_billing::is_invoice(&input.kind) {
        return Err(bad_request("Billing details belong to invoices"));
    }
    if let Some(rate) = input.vat_rate.as_deref() {
        if !super::commercial_billing::is_invoice(&input.kind) {
            return Err(bad_request("Billing details belong to invoices"));
        }
        super::commercial_billing::check_rate(rate)?;
    }
    let basis = input.billing_basis.as_deref().unwrap_or("work");
    if !["work", "lump_sum"].contains(&basis)
        || (input.kind != "progress_invoice" && basis == "lump_sum")
    {
        return Err(bad_request("Choose a valid billing basis"));
    }
    if input.scope_item_ids.len() > 20_000
        || input
            .scope_item_ids
            .iter()
            .any(|id| id.is_empty() || id.len() > 200)
    {
        return Err(bad_request("Invalid work package scope"));
    }
    if input.customer_id.is_none()
        && matches!(
            input.kind.as_str(),
            "variation" | "measurement" | "invoice" | "progress_invoice" | "final_invoice"
        )
        && let Some(project) = input.project_id
    {
        input.customer_id = sqlx::query_scalar("SELECT customer_id FROM projects WHERE id=$1")
            .bind(project)
            .fetch_one(&pool)
            .await
            .map_err(internal)?;
    }
    let actor = auth.user.id.parse::<i64>().map_err(internal)?;
    let prefix = match input.kind.as_str() {
        "offer" => "ANG",
        "variation" => "NTR",
        "subcontract" => "VER",
        "alternative" => "NEB",
        "procurement" => "BES",
        "calculation" => "KAL",
        "invoice" | "progress_invoice" | "final_invoice" => "RE",
        _ => "AUF",
    };
    let mut tx = pool.begin().await.map_err(internal)?;
    if super::commercial_billing::is_invoice(&input.kind) {
        super::commercial_billing::check_creation(
            &mut tx,
            input.parent_case_id.unwrap(),
            &input.kind,
        )
        .await?;
    }
    let invoice = super::commercial_billing::is_invoice(&input.kind);
    let basis = basis.to_owned();
    let id:Id=sqlx::query_scalar("INSERT INTO commercial_cases(reference,kind,title,project_id,parent_case_id,customer_id,counterparty_name,scope_item_ids,created_by_user_id) VALUES($1||'-'||TO_CHAR(NOW(),'YYYY')||'-'||LPAD(nextval('commercial_case_number_seq')::text,6,'0'),$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id")
      .bind(prefix).bind(input.kind).bind(input.title).bind(input.project_id).bind(input.parent_case_id).bind(input.customer_id).bind(input.counterparty_name.map(|v|v.trim().chars().take(127).collect::<String>())).bind(serde_json::json!(input.scope_item_ids)).bind(actor).fetch_one(&mut *tx).await.map_err(internal)?;
    if invoice {
        sqlx::query("INSERT INTO commercial_invoice_details(case_id,basis,vat_rate) VALUES($1,$2,$3::numeric)").bind(id).bind(basis).bind(input.vat_rate.unwrap_or_else(||"19.00".to_owned())).execute(&mut *tx).await.map_err(internal)?;
    }
    event(&mut tx, id, "created", None, "draft", actor).await?;
    tx.commit().await.map_err(internal)?;
    Ok(CreatedId { id })
}
async fn update_case(
    state: &AppState,
    context: &RequestContext,
    mut input: UpdateInput,
) -> RpcResult<Success> {
    let (_, pool) = access(state, context, true).await?;
    trim_required(&mut input.title, "title", 127)?;
    let updated=sqlx::query("UPDATE commercial_cases SET title=$2,customer_id=$3,counterparty_name=$4,valid_until=$5,notes=$6 WHERE id=$1 AND status='draft'")
      .bind(input.id).bind(input.title).bind(input.customer_id).bind(input.counterparty_name.map(|v|v.trim().chars().take(127).collect::<String>())).bind(input.valid_until).bind(input.notes.map(|v|v.chars().take(10000).collect::<String>())).execute(&pool).await.map_err(internal)?;
    if updated.rows_affected() != 1 {
        return Err(conflict("Only drafts can be changed"));
    }
    Ok(Success { success: true })
}
fn valid_transition(kind: &str, from: &str, to: &str) -> bool {
    match kind {
        "offer" | "variation" | "alternative" => matches!(
            (from, to),
            ("draft", "sent")
                | ("sent", "draft")
                | ("sent", "accepted")
                | ("sent", "rejected")
                | ("draft", "cancelled")
                | ("sent", "cancelled")
        ),
        "subcontract" | "procurement" => matches!(
            (from, to),
            ("draft", "requested")
                | ("requested", "awarded")
                | ("awarded", "confirmed")
                | ("draft", "cancelled")
                | ("requested", "cancelled")
        ),
        "measurement" => matches!(
            (from, to),
            ("draft", "submitted")
                | ("submitted", "draft")
                | ("submitted", "approved")
                | ("draft", "cancelled")
        ),
        "calculation" => matches!((from, to), ("draft", "approved") | ("draft", "cancelled")),
        "invoice" | "progress_invoice" | "final_invoice" => from == "draft" && to == "cancelled",
        _ => false,
    }
}
async fn transition_case(
    state: &AppState,
    context: &RequestContext,
    input: TransitionInput,
) -> RpcResult<Success> {
    let (auth, pool) = access(state, context, true).await?;
    let actor = auth.user.id.parse::<i64>().map_err(internal)?;
    let mut tx = pool.begin().await.map_err(internal)?;
    let locked=sqlx::query_as::<_,CaseLock>("SELECT kind,status,project_id,customer_id,net_amount::text AS net_amount FROM commercial_cases WHERE id=$1 FOR UPDATE").bind(input.id).fetch_optional(&mut *tx).await.map_err(internal)?.ok_or_else(not_found)?;
    if locked.status != input.expected_status {
        return Err(conflict("The workflow changed in another session"));
    }
    if !valid_transition(&locked.kind, &locked.status, &input.status) {
        return Err(bad_request("This workflow transition is not allowed"));
    }
    if let Some(project) = locked.project_id {
        let active: bool =
            sqlx::query_scalar("SELECT finished_at IS NULL FROM projects WHERE id=$1 FOR UPDATE")
                .bind(project)
                .fetch_one(&mut *tx)
                .await
                .map_err(internal)?;
        if !active {
            return Err(bad_request("The project is completed"));
        }
    }
    let documents=sqlx::query_as::<_,DocumentCheck>("SELECT id,purpose,phase,version,net_amount::text AS net_amount,partner_name,source_document_id,source_version FROM commercial_documents WHERE case_id=$1 ORDER BY created_at FOR UPDATE").bind(input.id).fetch_all(&mut *tx).await.map_err(internal)?;
    let purpose = match input.status.as_str() {
        "sent" | "accepted" => Some(if locked.kind == "alternative" {
            "alternative"
        } else {
            "offer"
        }),
        "requested" => Some(if locked.kind == "procurement" {
            "price_inquiry"
        } else {
            "inquiry"
        }),
        "awarded" => Some(if locked.kind == "procurement" {
            "purchase_order"
        } else {
            "order"
        }),
        "confirmed" => Some(if locked.kind == "procurement" {
            "supplier_confirmation"
        } else {
            "confirmation"
        }),
        "submitted" | "approved" => Some(if locked.kind == "calculation" {
            "calculation"
        } else {
            "measurement"
        }),
        _ => None,
    };
    if let Some(purpose) = purpose {
        if !documents.iter().any(|doc| doc.purpose == purpose) {
            return Err(bad_request(format!("A {purpose} document is required")));
        }
        if matches!(purpose, "offer" | "alternative") {
            let offer = documents.iter().find(|doc| doc.purpose == purpose).unwrap();
            if offer.net_amount.is_none() {
                return Err(bad_request("The offer needs a checked net amount"));
            }
            if locked.kind == "offer" && locked.customer_id.is_none() {
                return Err(bad_request("Choose a customer before submitting the offer"));
            }
            if let Some(source) = offer.source_document_id {
                let version: i64 =
                    sqlx::query_scalar("SELECT version FROM commercial_documents WHERE id=$1")
                        .bind(source)
                        .fetch_one(&mut *tx)
                        .await
                        .map_err(internal)?;
                if offer.source_version != Some(version) {
                    return Err(conflict(
                        "Update the calculation from the revised scope first",
                    ));
                }
            }
        }
    }
    let mut selected = None;
    if input.status == "awarded" {
        let id = input
            .selected_offer_document_id
            .ok_or_else(|| bad_request("Select a supplier offer"))?;
        let offer = documents
            .iter()
            .find(|doc| {
                doc.id == id
                    && doc.purpose
                        == if locked.kind == "procurement" {
                            "supplier_offer"
                        } else {
                            "offer"
                        }
                    && doc
                        .partner_name
                        .as_ref()
                        .is_some_and(|name| !name.trim().is_empty())
                    && doc.net_amount.is_some()
            })
            .ok_or_else(|| bad_request("Choose a priced supplier offer in this work package"))?;
        if !documents.iter().any(|doc| {
            doc.purpose
                == if locked.kind == "procurement" {
                    "purchase_order"
                } else {
                    "order"
                }
                && doc.source_document_id == Some(id)
                && doc.source_version == Some(offer.version)
        }) {
            return Err(bad_request(
                "Create the order from the selected current supplier offer",
            ));
        }
        let scope: serde_json::Value =
            sqlx::query_scalar("SELECT scope_item_ids FROM commercial_cases WHERE id=$1")
                .bind(input.id)
                .fetch_one(&mut *tx)
                .await
                .map_err(internal)?;
        let requested: Vec<String> = scope
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|value| value.as_str().map(str::to_owned))
            .collect();
        let awarded = input
            .awarded_item_ids
            .clone()
            .unwrap_or_else(|| requested.clone());
        if locked.kind == "subcontract"
            && (awarded.is_empty() || awarded.iter().any(|id| !requested.contains(id)))
        {
            return Err(bad_request("Choose items in this work package"));
        }
        let occupied:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM commercial_cases WHERE project_id=$1 AND id<>$2 AND kind='subcontract' AND status IN ('awarded','confirmed') AND parent_case_id IS NOT DISTINCT FROM (SELECT parent_case_id FROM commercial_cases WHERE id=$2) AND scope_item_ids ?| $3)").bind(locked.project_id).bind(input.id).bind(&awarded).fetch_one(&mut *tx).await.map_err(internal)?;
        if occupied && locked.kind == "subcontract" {
            return Err(conflict("A position is already subcontracted"));
        }
        sqlx::query("UPDATE commercial_cases SET scope_item_ids=$2 WHERE id=$1")
            .bind(input.id)
            .bind(serde_json::json!(awarded))
            .execute(&mut *tx)
            .await
            .map_err(internal)?;
        selected = Some((
            id,
            offer.net_amount.clone().unwrap(),
            offer.partner_name.clone(),
        ));
    }
    if input.status == "accepted" && locked.kind == "variation" {
        let amount = documents
            .iter()
            .find(|doc| doc.purpose == "offer")
            .and_then(|doc| doc.net_amount.clone())
            .ok_or_else(|| bad_request("Missing offer amount"))?;
        sqlx::query("INSERT INTO project_financial_entries(project_id,type,amount,comment,created_by_user_id,commercial_case_id) SELECT project_id,'offer',$2::numeric::double precision,reference||': '||title,$3,id FROM commercial_cases WHERE id=$1 ON CONFLICT(commercial_case_id) DO NOTHING").bind(input.id).bind(amount).bind(actor).execute(&mut *tx).await.map_err(internal)?;
    }
    if matches!(
        input.status.as_str(),
        "sent" | "accepted" | "requested" | "awarded" | "confirmed" | "submitted" | "approved"
    ) {
        sqlx::query("INSERT INTO commercial_document_snapshots(document_id,version,object_key,event) SELECT id,version,object_key,$2 FROM commercial_documents WHERE case_id=$1 ON CONFLICT(document_id,version) DO NOTHING").bind(input.id).bind(&input.status).execute(&mut *tx).await.map_err(internal)?;
    }
    sqlx::query("UPDATE commercial_cases SET status=$2,accepted_at=CASE WHEN $2='accepted' THEN NOW() ELSE accepted_at END,selected_offer_document_id=COALESCE($3,selected_offer_document_id),net_amount=COALESCE($4::numeric,net_amount),counterparty_name=COALESCE($5,counterparty_name) WHERE id=$1")
      .bind(input.id).bind(&input.status).bind(selected.as_ref().map(|value|value.0)).bind(selected.as_ref().map(|value|value.1.clone())).bind(selected.and_then(|value|value.2)).execute(&mut *tx).await.map_err(internal)?;
    event(
        &mut tx,
        input.id,
        "status",
        Some(&locked.status),
        &input.status,
        actor,
    )
    .await?;
    tx.commit().await.map_err(internal)?;
    Ok(Success { success: true })
}
async fn create_project(
    state: &AppState,
    context: &RequestContext,
    id: Id,
) -> RpcResult<CreatedId> {
    let (auth, pool) = access(state, context, true).await?;
    let actor = auth.user.id.parse::<i64>().map_err(internal)?;
    let mut tx = pool.begin().await.map_err(internal)?;
    let case=sqlx::query_as::<_,CaseLock>("SELECT kind,status,project_id,customer_id,net_amount::text AS net_amount FROM commercial_cases WHERE id=$1 FOR UPDATE").bind(id).fetch_optional(&mut *tx).await.map_err(internal)?.ok_or_else(not_found)?;
    if !matches!(case.kind.as_str(), "offer" | "alternative") || case.status != "accepted" {
        return Err(bad_request(
            "Only an accepted main offer can become a new project",
        ));
    }
    if let Some(id) = case.project_id {
        return Ok(CreatedId { id });
    }
    let project_id:Id=sqlx::query_scalar("INSERT INTO projects(title,customer_id,address,order_received_at,created_by_user_id) SELECT offer.title,offer.customer_id,customer.address,offer.accepted_at,$2 FROM commercial_cases offer LEFT JOIN customers customer ON customer.id=offer.customer_id WHERE offer.id=$1 RETURNING id").bind(id).bind(actor).fetch_one(&mut *tx).await.map_err(internal)?;
    sqlx::query("UPDATE commercial_cases SET project_id=$2 WHERE id=$1")
        .bind(id)
        .bind(project_id)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    if case.kind == "alternative" {
        sqlx::query("UPDATE commercial_cases SET project_id=$2 WHERE id=(SELECT parent_case_id FROM commercial_cases WHERE id=$1) AND project_id IS NULL")
            .bind(id).bind(project_id).execute(&mut *tx).await.map_err(internal)?;
    }
    sqlx::query("INSERT INTO project_financial_entries(project_id,type,amount,comment,created_by_user_id,commercial_case_id) SELECT $2,'offer',net_amount::double precision,reference||': '||title,$3,id FROM commercial_cases WHERE id=$1 ON CONFLICT(commercial_case_id) DO NOTHING").bind(id).bind(project_id).bind(actor).execute(&mut *tx).await.map_err(internal)?;
    event(
        &mut tx,
        id,
        "project_created",
        Some("accepted"),
        "accepted",
        actor,
    )
    .await?;
    tx.commit().await.map_err(internal)?;
    Ok(CreatedId { id: project_id })
}
pub async fn event(
    connection: &mut PgConnection,
    id: Id,
    action: &str,
    previous: Option<&str>,
    status: &str,
    actor: i64,
) -> RpcResult<()> {
    sqlx::query("INSERT INTO commercial_case_events(case_id,action,previous_status,status,created_by_user_id) VALUES($1,$2,$3,$4,$5)").bind(id).bind(action).bind(previous).bind(status).bind(actor).execute(connection).await.map_err(internal)?;
    Ok(())
}
pub fn conflict(message: &str) -> RpcError {
    RpcError::new(ErrorCode::Conflict, message).with_http_code(409)
}
pub fn document_editable(case: &CommercialCase, purpose: &str, read_only: bool) -> bool {
    if read_only {
        return false;
    }
    match purpose {
        "confirmation" => matches!(case.status.as_str(), "accepted" | "awarded"),
        "order" | "purchase_order" => matches!(case.status.as_str(), "requested" | "accepted"),
        _ => case.status == "draft",
    }
}

#[derive(Debug, Clone, Serialize, FromRow, TS)]
#[serde(rename_all = "camelCase")]
pub struct CommercialCase {
    pub id: Id,
    pub reference: String,
    #[ts(
        type = "'offer'|'variation'|'alternative'|'subcontract'|'measurement'|'procurement'|'calculation'|'invoice'|'progress_invoice'|'final_invoice'"
    )]
    pub kind: String,
    #[ts(
        type = "'draft'|'sent'|'accepted'|'rejected'|'cancelled'|'requested'|'awarded'|'confirmed'|'submitted'|'approved'|'partially_paid'|'paid'"
    )]
    pub status: String,
    pub title: String,
    pub existing_contract: bool,
    pub project_id: Option<Id>,
    pub project_title: Option<String>,
    pub parent_case_id: Option<Id>,
    pub customer_id: Option<Id>,
    pub customer_name: Option<String>,
    pub counterparty_name: Option<String>,
    pub currency: String,
    pub net_amount: Option<String>,
    pub valid_until: Option<NaiveDate>,
    pub notes: Option<String>,
    pub scope_item_ids: serde_json::Value,
    pub selected_offer_document_id: Option<Id>,
    pub accepted_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub modified_at: DateTime<Utc>,
}
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CaseDetail {
    case: CommercialCase,
    documents: Vec<super::commercial_documents::Document>,
    events: Vec<CaseEvent>,
    can_manage: bool,
    invoice: Option<super::commercial_billing::InvoiceDetails>,
}
#[derive(Serialize, FromRow, TS)]
#[serde(rename_all = "camelCase")]
struct CaseEvent {
    id: Id,
    action: String,
    previous_status: Option<String>,
    status: String,
    created_at: DateTime<Utc>,
    actor: String,
}
#[derive(FromRow)]
struct CaseLock {
    kind: String,
    status: String,
    project_id: Option<Id>,
    customer_id: Option<Id>,
}
#[derive(FromRow)]
struct DocumentCheck {
    id: Id,
    purpose: String,
    version: i64,
    net_amount: Option<String>,
    partner_name: Option<String>,
    source_document_id: Option<Id>,
    source_version: Option<i64>,
}
#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CaseInput {
    id: Id,
}
#[derive(Serialize, TS)]
struct CreatedId {
    id: Id,
}
#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ListInput {
    #[serde(default)]
    #[ts(optional=nullable)]
    project_id: Option<Id>,
    #[serde(default)]
    #[ts(optional=nullable)]
    kind: Option<String>,
    #[serde(default)]
    #[ts(optional=nullable)]
    status: Option<String>,
    #[serde(default)]
    #[ts(optional=nullable)]
    search: Option<String>,
    #[serde(default)]
    #[ts(optional=nullable)]
    limit: Option<i64>,
    #[serde(default)]
    #[ts(optional=nullable)]
    offset: Option<i64>,
}
#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateInput {
    kind: String,
    title: String,
    #[serde(default)]
    #[ts(optional=nullable)]
    project_id: Option<Id>,
    #[serde(default)]
    #[ts(optional=nullable)]
    parent_case_id: Option<Id>,
    #[serde(default)]
    #[ts(optional=nullable)]
    customer_id: Option<Id>,
    #[serde(default)]
    #[ts(optional=nullable)]
    counterparty_name: Option<String>,
    #[serde(default)]
    scope_item_ids: Vec<String>,
    #[serde(default)]
    #[ts(optional=nullable)]
    billing_basis: Option<String>,
    #[serde(default)]
    #[ts(optional=nullable)]
    vat_rate: Option<String>,
}
#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpdateInput {
    id: Id,
    title: String,
    customer_id: Option<Id>,
    counterparty_name: Option<String>,
    valid_until: Option<NaiveDate>,
    notes: Option<String>,
}
#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TransitionInput {
    id: Id,
    expected_status: String,
    status: String,
    #[serde(default)]
    #[ts(optional=nullable)]
    selected_offer_document_id: Option<Id>,
    #[serde(default)]
    #[ts(optional = nullable)]
    awarded_item_ids: Option<Vec<String>>,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn enforces_contractor_lifecycle() {
        assert!(valid_transition("offer", "sent", "accepted"));
        assert!(!valid_transition("offer", "draft", "accepted"));
        assert!(!valid_transition("variation", "accepted", "draft"));
        assert!(valid_transition("subcontract", "requested", "awarded"));
        assert!(!valid_transition("subcontract", "draft", "accepted"));
        assert!(valid_transition("measurement", "submitted", "approved"));
    }
}
