//! Exact invoice settlement, numbering and payment records for native X89 files.
use super::{
    commercial::{self, CommercialCase},
    common::{bad_request, internal, not_found},
    settings::{InvoiceNumbering, InvoiceNumberingScheme},
};
use crate::{
    AppState,
    api::Success,
    error::RpcResult,
    ids::Id,
    object_storage,
    rpc::{ProcedureRegistryBuilder, RequestContext},
    xml_documents,
};
use chrono::{Datelike, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgConnection, types::Json};
use std::sync::Arc;
use ts_rs::TS;

pub fn is_invoice(kind: &str) -> bool {
    matches!(kind, "invoice" | "progress_invoice" | "final_invoice")
}
pub fn register(
    builder: ProcedureRegistryBuilder,
    state: Arc<AppState>,
) -> ProcedureRegistryBuilder {
    let context = Arc::clone(&state);
    let issue = Arc::clone(&state);
    builder
        .query(
            "commercial.invoices.context",
            move |ctx, input: ContextInput| {
                let state = Arc::clone(&context);
                async move { billing_context(&state, &ctx, input).await }
            },
        )
        .mutation("commercial.invoices.issue", move |ctx, input: CaseInput| {
            let state = Arc::clone(&issue);
            async move { issue_invoice(&state, &ctx, input).await }
        })
        .mutation(
            "commercial.invoices.recordPayment",
            move |ctx, input: PaymentInput| {
                let state = Arc::clone(&state);
                async move { record_payment(&state, &ctx, input).await }
            },
        )
}
pub fn register_contract(builder: ProcedureRegistryBuilder) -> ProcedureRegistryBuilder {
    builder
        .query_stub::<ContextInput, BillingContext>("commercial.invoices.context")
        .mutation_stub::<CaseInput, Success>("commercial.invoices.issue")
        .mutation_stub::<PaymentInput, Success>("commercial.invoices.recordPayment")
}
#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ContextInput {
    contract_case_id: Id,
}
#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct CaseInput {
    id: Id,
}
#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PaymentInput {
    id: Id,
    amount: String,
    paid_on: NaiveDate,
    reference: String,
}
#[derive(Serialize, TS, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct InvoicePayment {
    pub id: Id,
    pub amount: String,
    pub paid_on: NaiveDate,
    pub reference: String,
}
#[derive(Serialize, TS, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct InvoiceDetails {
    pub basis: String,
    pub vat_rate: String,
    pub invoice_number: Option<String>,
    pub invoice_date: NaiveDate,
    pub due_date: NaiveDate,
    pub service_start: NaiveDate,
    pub service_end: NaiveDate,
    pub total_net: String,
    pub deducted_net: String,
    pub gross_amount: String,
    pub paid_amount: String,
    #[sqlx(skip)]
    pub payments: Vec<InvoicePayment>,
}
#[derive(Serialize, TS, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct PriorInvoice {
    pub id: Id,
    pub invoice_number: String,
    pub invoice_date: NaiveDate,
    pub net_amount: String,
    pub gross_amount: String,
    pub paid_amount: String,
    pub vat_rate: String,
}
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct BillingContext {
    progress_invoices: Vec<PriorInvoice>,
    has_invoice: bool,
    has_final_invoice: bool,
    vat_rate: Option<String>,
}

pub async fn details(pool: &sqlx::PgPool, id: Id) -> RpcResult<Option<InvoiceDetails>> {
    let mut detail=sqlx::query_as::<_,InvoiceDetails>("SELECT d.basis,d.vat_rate::text,d.invoice_number,d.invoice_date,d.due_date,d.service_start,d.service_end,d.total_net::text,d.deducted_net::text,d.gross_amount::text,COALESCE((SELECT SUM(p.amount) FROM commercial_invoice_payments p WHERE p.case_id=d.case_id),0)::text AS paid_amount FROM commercial_invoice_details d WHERE d.case_id=$1").bind(id).fetch_optional(pool).await.map_err(internal)?;
    if let Some(value) = detail.as_mut() {
        value.payments=sqlx::query_as("SELECT id,amount::text,paid_on,reference FROM commercial_invoice_payments WHERE case_id=$1 ORDER BY paid_on,id").bind(id).fetch_all(pool).await.map_err(internal)?;
    }
    Ok(detail)
}
async fn prior(connection: &mut PgConnection, parent: Id) -> RpcResult<Vec<PriorInvoice>> {
    sqlx::query_as("SELECT c.id,d.invoice_number,d.invoice_date,c.net_amount::text,d.gross_amount::text,COALESCE((SELECT SUM(p.amount) FROM commercial_invoice_payments p WHERE p.case_id=c.id),0)::text AS paid_amount,d.vat_rate::text FROM commercial_cases c JOIN commercial_invoice_details d ON d.case_id=c.id WHERE c.parent_case_id=$1 AND c.kind='progress_invoice' AND c.status IN ('sent','partially_paid','paid') ORDER BY d.invoice_date,c.id")
 .bind(parent).fetch_all(connection).await.map_err(internal)
}
async fn billing_context(
    state: &AppState,
    context: &RequestContext,
    input: ContextInput,
) -> RpcResult<BillingContext> {
    let (_, pool) = commercial::access(state, context, false).await?;
    let parent = commercial::case_by_id(&pool, input.contract_case_id).await?;
    if !matches!(parent.kind.as_str(), "offer" | "variation" | "alternative")
        || parent.status != "accepted"
        || parent.project_id.is_none()
    {
        return Err(bad_request("Choose an accepted project contract"));
    }
    let mut tx = pool.begin().await.map_err(internal)?;
    let invoices = prior(&mut tx, parent.id).await?;
    let (has_invoice,has_final_invoice):(bool,bool)=sqlx::query_as("SELECT EXISTS(SELECT 1 FROM commercial_cases WHERE parent_case_id=$1 AND kind='invoice' AND status<>'cancelled'), EXISTS(SELECT 1 FROM commercial_cases WHERE parent_case_id=$1 AND kind='final_invoice' AND status<>'cancelled')").bind(parent.id).fetch_one(&mut *tx).await.map_err(internal)?;
    Ok(BillingContext {
        vat_rate: invoices.first().map(|p| p.vat_rate.clone()),
        progress_invoices: invoices,
        has_invoice,
        has_final_invoice,
    })
}
/// Called while the accepted contract is locked, before inserting any invoice.
pub async fn check_creation(
    connection: &mut PgConnection,
    parent: Id,
    kind: &str,
) -> RpcResult<()> {
    sqlx::query("SELECT id FROM commercial_cases WHERE id=$1 FOR UPDATE")
        .bind(parent)
        .fetch_one(&mut *connection)
        .await
        .map_err(internal)?;
    let kinds:Vec<String>=sqlx::query_scalar("SELECT kind FROM commercial_cases WHERE parent_case_id=$1 AND kind IN ('invoice','progress_invoice','final_invoice') AND status<>'cancelled'").bind(parent).fetch_all(&mut *connection).await.map_err(internal)?;
    if kinds.iter().any(|k| k == "invoice" || k == "final_invoice") {
        return Err(commercial::conflict(
            "This contract already has an invoice or final invoice",
        ));
    }
    if kind == "invoice" && kinds.iter().any(|k| k == "progress_invoice") {
        return Err(bad_request("Use a final invoice after progress invoices"));
    }
    if kind == "final_invoice" && prior(connection, parent).await?.is_empty() {
        return Err(bad_request(
            "A final invoice requires an issued progress invoice",
        ));
    }
    Ok(())
}
fn cents(value: &str) -> RpcResult<i128> {
    let mut parts = value.split('.');
    let whole = parts.next().unwrap_or("");
    let fraction = parts.next().unwrap_or("");
    if whole.is_empty()
        || !whole.bytes().all(|b| b.is_ascii_digit())
        || fraction.len() > 2
        || !fraction.bytes().all(|b| b.is_ascii_digit())
        || parts.next().is_some()
    {
        return Err(bad_request(
            "Use a non-negative decimal amount with at most two decimals",
        ));
    }
    let number = whole
        .parse::<i128>()
        .ok()
        .and_then(|w| w.checked_mul(100))
        .and_then(|w| {
            fraction
                .parse::<i128>()
                .unwrap_or(0)
                .checked_mul(if fraction.len() == 1 { 10 } else { 1 })
                .and_then(|f| w.checked_add(f))
        })
        .filter(|n| *n <= 99_999_999_999_999_i128)
        .ok_or_else(|| bad_request("Amount is out of range"))?;
    Ok(number)
}
fn fixed_decimal(value: &str, scale: usize) -> RpcResult<i128> {
    let (whole, fraction) = value.split_once('.').unwrap_or((value, ""));
    if whole.is_empty()
        || whole.len() > 13
        || !whole.bytes().all(|b| b.is_ascii_digit())
        || fraction.len() > scale
        || !fraction.bytes().all(|b| b.is_ascii_digit())
    {
        return Err(bad_request("Invalid invoice decimal"));
    }
    let whole = whole
        .parse::<i128>()
        .map_err(|_| bad_request("Invalid invoice decimal"))?;
    let fraction = if fraction.is_empty() {
        0
    } else {
        fraction
            .parse::<i128>()
            .map_err(|_| bad_request("Invalid invoice decimal"))?
            * 10_i128.pow((scale - fraction.len()) as u32)
    };
    Ok(whole * 10_i128.pow(scale as u32) + fraction)
}
pub fn check_rate(value: &str) -> RpcResult<()> {
    if cents(value)? > 10_000 {
        return Err(bad_request("VAT rate must be between 0 and 100"));
    }
    Ok(())
}
fn amount(value: i128) -> String {
    format!("{}.{:02}", value / 100, value % 100)
}
fn scalar<'a>(parent: roxmltree::Node<'a, 'a>, name: &str) -> RpcResult<&'a str> {
    parent
        .children()
        .find(|n| {
            n.is_element()
                && n.tag_name().name() == name
                && n.tag_name().namespace() == parent.tag_name().namespace()
        })
        .and_then(|n| n.text())
        .ok_or_else(|| bad_request(format!("Missing invoice field {name}")))
}
/// The editor validates XSD; issuance also verifies monetary and chain invariants
/// on the server so callers cannot alter a locked invoice's settlement amounts.
pub async fn validate_document(
    connection: &mut PgConnection,
    case: &CommercialCase,
    xml: &str,
    declared: Option<&str>,
) -> RpcResult<()> {
    if !is_invoice(&case.kind) {
        return Err(bad_request("This workflow is not an invoice"));
    }
    let parent = case
        .parent_case_id
        .ok_or_else(|| bad_request("Choose a contract"))?;
    sqlx::query("SELECT id FROM commercial_cases WHERE id=$1 FOR UPDATE")
        .bind(parent)
        .fetch_one(&mut *connection)
        .await
        .map_err(internal)?;
    let doc = roxmltree::Document::parse(xml).map_err(|_| bad_request("Invalid invoice XML"))?;
    let root = doc.root_element();
    if root.tag_name().namespace() != Some("http://www.gaeb.de/GAEB_DA_XML/DA89/3.3") {
        return Err(bad_request("Use a native X89 invoice"));
    }
    let invoice = root
        .children()
        .find(|n| {
            n.is_element()
                && n.tag_name().name() == "Invoice"
                && n.tag_name().namespace() == root.tag_name().namespace()
        })
        .ok_or_else(|| bad_request("Missing invoice"))?;
    let header = invoice
        .children()
        .find(|n| n.is_element() && n.tag_name().name() == "InvoiceHeader")
        .ok_or_else(|| bad_request("Missing invoice header"))?;
    let wanted = match case.kind.as_str() {
        "progress_invoice" => "deduction",
        "final_invoice" => "final account",
        _ => "single invoice",
    };
    if scalar(header, "InvoiceType")? != wanted || scalar(header, "SettlementType")? != "periodic" {
        return Err(bad_request(
            "Invoice type does not match this billing workflow",
        ));
    }
    let blockers: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM commercial_cases WHERE parent_case_id=$1 AND id<>$2 AND kind IN ('invoice','final_invoice') AND status IN ('sent','partially_paid','paid'))")
        .bind(parent).bind(case.id).fetch_one(&mut *connection).await.map_err(internal)?;
    if blockers {
        return Err(commercial::conflict(
            "This contract has already been settled",
        ));
    }
    let invoices = prior(connection, parent).await?;
    if case.kind == "invoice" && !invoices.is_empty() {
        return Err(bad_request("Use a final invoice after progress invoices"));
    }
    if case.kind == "final_invoice" && invoices.is_empty() {
        return Err(bad_request(
            "A final invoice requires an issued progress invoice",
        ));
    }
    let mut basic = None;
    let mut tax = None;
    let mut tax_percent = None;
    let mut deduction = 0_i128;
    for share in invoice
        .children()
        .filter(|n| n.is_element() && n.tag_name().name() == "InvoiceShare")
    {
        match scalar(share, "InvoiceShareType")? {
            "basic amount" if basic.is_none() => basic = Some(cents(scalar(share, "Total")?)?),
            "VAT" if tax.is_none() && tax_percent.is_none() => {
                if let Ok(percent) = scalar(share, "Percent") {
                    tax_percent = Some(cents(percent)?);
                } else {
                    tax = Some(cents(scalar(share, "Total")?)?);
                }
            }
            "amount invoices" => deduction += cents(scalar(share, "Total")?)?,
            _ => {
                return Err(bad_request(
                    "This invoice contains unsupported settlement rules",
                ));
            }
        }
    }
    let basic = basic.ok_or_else(|| bad_request("Missing invoice net amount"))?;
    let mut item_total = 0_i128;
    for item in invoice.descendants().filter(|n| {
        n.is_element()
            && n.tag_name().namespace() == root.tag_name().namespace()
            && n.tag_name().name() == "Item"
    }) {
        // These native workflows use ordinary work positions. Opaque extensions
        // survive storage, but unsupported price rules cannot affect issuance.
        for name in [
            "LumpSumItem",
            "Provis",
            "NotAppl",
            "UPBkdn",
            "MarkupIt",
            "QtySplit",
            "SubDescr",
        ] {
            if item
                .children()
                .any(|n| n.is_element() && n.tag_name().name() == name)
            {
                return Err(bad_request("Unsupported invoice pricing rules"));
            }
        }
        let qty = fixed_decimal(scalar(item, "BillQty")?, 3)?;
        let price = fixed_decimal(scalar(item, "UP")?, 3)?;
        let discount = scalar(item, "DiscountPcnt")
            .ok()
            .map(|s| fixed_decimal(s, 6))
            .transpose()?
            .unwrap_or(0);
        if discount > 100_000_000 {
            return Err(bad_request("Invalid invoice discount"));
        }
        let product = qty
            .checked_mul(price)
            .and_then(|n| n.checked_mul(100_000_000 - discount))
            .ok_or_else(|| bad_request("Invoice amount out of range"))?;
        let total = (product + 500_000_000_000) / 1_000_000_000_000;
        if scalar(item, "IT")
            .ok()
            .map(cents)
            .transpose()?
            .is_some_and(|v| v != total)
        {
            return Err(bad_request(
                "Invoice item totals do not match their quantities and prices",
            ));
        }
        item_total += total;
    }
    if item_total != basic {
        return Err(bad_request(
            "Invoice net amount does not match its work items",
        ));
    }
    let rate: String = sqlx::query_scalar(
        "SELECT vat_rate::text FROM commercial_invoice_details WHERE case_id=$1",
    )
    .bind(case.id)
    .fetch_one(&mut *connection)
    .await
    .map_err(internal)?;
    let rate = cents(&rate)?;
    let vat = (basic * rate + 5000) / 10000;
    if tax_percent.is_some_and(|r| r != rate)
        || tax.is_some_and(|t| t != vat)
        || (tax.is_none() && tax_percent.is_none())
    {
        return Err(bad_request("Invoice VAT does not match its tax rate"));
    }
    if invoices
        .iter()
        .any(|p| cents(&p.vat_rate).ok() != Some(rate))
    {
        return Err(bad_request(
            "Use the same VAT rate throughout this billing chain",
        ));
    }
    let deducted_net = if case.kind == "final_invoice" {
        invoices.iter().try_fold(0_i128, |sum, p| {
            Ok::<_, crate::error::RpcError>(sum + cents(&p.net_amount)?)
        })?
    } else {
        0
    };
    let deducted_gross = if case.kind == "final_invoice" {
        invoices.iter().try_fold(0_i128, |sum, p| {
            Ok::<_, crate::error::RpcError>(sum + cents(&p.gross_amount)?)
        })?
    } else {
        0
    };
    if deduction != deducted_gross || basic < deducted_net || basic + vat < deduction {
        return Err(bad_request(
            "Previous progress invoices changed; recreate the settlement from the current contract",
        ));
    }
    let net = basic - deducted_net;
    let gross = basic + vat - deduction;
    if cents(scalar(invoice, "TotalGross")?)? != gross
        || declared.map(cents).transpose()? != Some(net)
    {
        return Err(bad_request(
            "Invoice totals do not match their settlement components",
        ));
    }
    let date = |name| {
        NaiveDate::parse_from_str(scalar(header, name)?, "%Y-%m-%d")
            .map_err(|_| bad_request("Invalid invoice date"))
    };
    let invoice_date = date("InvoiceDate")?;
    let start = date("ServiceProvisionStartDate")?;
    let end = date("ServiceProvisionEndDate")?;
    if end < start {
        return Err(bad_request("The service end precedes its start"));
    }
    sqlx::query("UPDATE commercial_invoice_details SET invoice_date=$2,due_date=$2+14,service_start=$3,service_end=$4,total_net=$5::numeric,deducted_net=$6::numeric,gross_amount=$7::numeric WHERE case_id=$1").bind(case.id).bind(invoice_date).bind(start).bind(end).bind(amount(basic)).bind(amount(deducted_net)).bind(amount(gross)).execute(connection).await.map_err(internal)?;
    Ok(())
}
fn format_number(
    scheme: InvoiceNumberingScheme,
    number: i64,
    project: Id,
    date: NaiveDate,
) -> String {
    let prefix = format!("{:08}", project.0.rem_euclid(100_000_000));
    match scheme {
        InvoiceNumberingScheme::Sequential => number.to_string(),
        InvoiceNumberingScheme::DateSeparated => format!(
            "{:02}-{:02}-{:02}-{number}",
            date.year().rem_euclid(100),
            date.month(),
            date.day()
        ),
        InvoiceNumberingScheme::DateCompact => format!(
            "{:02}{:02}{:02}{number}",
            date.year().rem_euclid(100),
            date.month(),
            date.day()
        ),
        _ => format!("{prefix}-{number}"),
    }
}
pub(crate) async fn allocate_number(
    connection: &mut PgConnection,
    project: Id,
    date: NaiveDate,
) -> RpcResult<String> {
    let config: Option<Json<InvoiceNumbering>> = sqlx::query_scalar(
        "SELECT name FROM global_settings WHERE key='organization.invoiceNumbering'",
    )
    .fetch_optional(&mut *connection)
    .await
    .map_err(internal)?
    .flatten();
    let config = config.map(|v| v.0).unwrap_or_default();
    let start = config.start_number.parse::<i64>().map_err(internal)?;
    let scope = if matches!(config.scheme, InvoiceNumberingScheme::ProjectLocal) {
        format!("project:{}", project.0)
    } else {
        "global".to_owned()
    };
    for _ in 0..1000 {
        let next:String=sqlx::query_scalar("INSERT INTO commercial_invoice_counters(scope,next_number) VALUES($1,$2::numeric+1) ON CONFLICT(scope) DO UPDATE SET next_number=GREATEST(commercial_invoice_counters.next_number,$2::numeric)+1 RETURNING (next_number-1)::text").bind(&scope).bind(start.to_string()).fetch_one(&mut *connection).await.map_err(internal)?;
        let next = next
            .parse::<i64>()
            .map_err(|_| bad_request("Invoice counter is exhausted"))?;
        let number = format_number(config.scheme, next, project, date);
        let used: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM commercial_invoice_details WHERE invoice_number=$1)",
        )
        .bind(&number)
        .fetch_one(&mut *connection)
        .await
        .map_err(internal)?;
        if !used {
            return Ok(number);
        }
    }
    Err(commercial::conflict(
        "The invoice number range is exhausted",
    ))
}
async fn issue_invoice(
    state: &AppState,
    context: &RequestContext,
    input: CaseInput,
) -> RpcResult<Success> {
    let (auth, pool) = commercial::access(state, context, true).await?;
    let actor = auth.user.id.parse::<i64>().map_err(internal)?;
    let mut tx = pool.begin().await.map_err(internal)?;
    let case = commercial::locked_case(&mut tx, input.id).await?;
    if !is_invoice(&case.kind) || case.status != "draft" {
        return Err(commercial::conflict("Only an invoice draft can be issued"));
    }
    let row:(Id,String,String,i64)=sqlx::query_as("SELECT id,object_key,file_name,version FROM commercial_documents WHERE case_id=$1 AND purpose='invoice' FOR UPDATE").bind(case.id).fetch_optional(&mut *tx).await.map_err(internal)?.ok_or_else(not_found)?;
    let storage = xml_documents::required_storage(state, &auth.tenant).await?;
    let xml = xml_documents::download_xml_object(&storage, &row.1, &row.2).await?;
    validate_document(&mut tx, &case, &xml, case.net_amount.as_deref()).await?;
    {
        let parsed = roxmltree::Document::parse(&xml).map_err(internal)?;
        let invoice = parsed
            .descendants()
            .find(|n| n.is_element() && n.tag_name().name() == "Invoice")
            .ok_or_else(|| bad_request("Missing invoice"))?;
        for name in ["InvoiceCreator", "InvoiceRecipient"] {
            let party = invoice
                .children()
                .find(|n| n.is_element() && n.tag_name().name() == name)
                .ok_or_else(|| bad_request("Complete the invoice addresses"))?;
            let address = party
                .children()
                .find(|n| n.is_element() && n.tag_name().name() == "Address")
                .ok_or_else(|| bad_request("Complete the invoice addresses"))?;
            for field in ["Name1", "Street", "PCode", "City"] {
                if scalar(address, field)?.trim().is_empty() {
                    return Err(bad_request("Complete the invoice addresses"));
                }
            }
            if name == "InvoiceCreator" && scalar(party, "TaxNo")?.trim().is_empty() {
                return Err(bad_request("Enter your tax number"));
            }
        }
    }

    let date: NaiveDate =
        sqlx::query_scalar("SELECT invoice_date FROM commercial_invoice_details WHERE case_id=$1")
            .bind(case.id)
            .fetch_one(&mut *tx)
            .await
            .map_err(internal)?;
    let number = allocate_number(
        &mut tx,
        case.project_id
            .ok_or_else(|| bad_request("Choose a project"))?,
        date,
    )
    .await?;
    let range = {
        let doc = roxmltree::Document::parse(&xml).map_err(internal)?;
        let node = doc
            .descendants()
            .find(|n| {
                n.is_element()
                    && n.tag_name().name() == "InvoiceNo"
                    && n.tag_name().namespace() == doc.root_element().tag_name().namespace()
                    && n.parent()
                        .is_some_and(|p| p.tag_name().name() == "InvoiceHeader")
            })
            .ok_or_else(|| bad_request("Missing invoice number"))?;
        node.range()
    };
    let element = &xml[range.clone()];
    let start = range.start
        + element
            .find('>')
            .ok_or_else(|| bad_request("Invalid invoice number"))?
        + 1;
    let end = range.start
        + element
            .rfind('<')
            .ok_or_else(|| bad_request("Invalid invoice number"))?;
    let mut updated = xml.clone();
    updated.replace_range(start..end, &number);
    let name = format!("{number}.x89");
    let key = object_storage::build_commercial_object_key(&storage, case.id, &name);
    xml_documents::upload_xml(&storage, &key, &updated).await?;
    sqlx::query("UPDATE commercial_documents SET object_key=$2,file_name=$3,version=version+1,size_bytes=$4,read_only=TRUE,modified_at=NOW() WHERE id=$1").bind(row.0).bind(&key).bind(&name).bind(updated.len() as i64).execute(&mut *tx).await.map_err(internal)?;
    sqlx::query("UPDATE commercial_invoice_details SET invoice_number=$2 WHERE case_id=$1")
        .bind(case.id)
        .bind(&number)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    sqlx::query("UPDATE commercial_cases SET status='sent' WHERE id=$1")
        .bind(case.id)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    sqlx::query("INSERT INTO commercial_document_snapshots(document_id,version,object_key,event) VALUES($1,$2,$3,'issued')").bind(row.0).bind(row.3+1).bind(&key).execute(&mut *tx).await.map_err(internal)?;
    sqlx::query("INSERT INTO project_financial_entries(project_id,type,amount,comment,created_by_user_id,commercial_case_id) VALUES($1,'invoice',$2::numeric::double precision,$3,$4,$5)").bind(case.project_id).bind(case.net_amount).bind(format!("{number}: {}",case.title)).bind(actor).bind(case.id).execute(&mut *tx).await.map_err(internal)?;
    commercial::event(
        &mut tx,
        case.id,
        "invoice_issued",
        Some("draft"),
        "sent",
        actor,
    )
    .await?;
    tx.commit().await.map_err(internal)?;
    // Earlier drafts can be referenced by a recovery or source revision. Retain
    // them rather than deleting an immutable invoice's predecessor optimistically.
    Ok(Success { success: true })
}
async fn record_payment(
    state: &AppState,
    context: &RequestContext,
    input: PaymentInput,
) -> RpcResult<Success> {
    let (auth, pool) = commercial::access(state, context, true).await?;
    let actor = auth.user.id.parse::<i64>().map_err(internal)?;
    let value = cents(&input.amount)?;
    if value == 0
        || input.reference.chars().count() > 255
        || input.paid_on > Utc::now().date_naive()
    {
        return Err(bad_request("Invalid payment"));
    }
    let mut tx = pool.begin().await.map_err(internal)?;
    let case = commercial::locked_case(&mut tx, input.id).await?;
    if !is_invoice(&case.kind) || !matches!(case.status.as_str(), "sent" | "partially_paid") {
        return Err(commercial::conflict(
            "Record payments only against an issued, unpaid invoice",
        ));
    }
    let(gross,paid):(String,String)=sqlx::query_as("SELECT d.gross_amount::text,COALESCE((SELECT SUM(amount) FROM commercial_invoice_payments WHERE case_id=d.case_id),0)::text FROM commercial_invoice_details d WHERE case_id=$1").bind(case.id).fetch_one(&mut *tx).await.map_err(internal)?;
    let sum = cents(&paid)? + value;
    if sum > cents(&gross)? {
        return Err(bad_request("The payment exceeds the outstanding amount"));
    }
    sqlx::query("INSERT INTO commercial_invoice_payments(case_id,amount,paid_on,reference,created_by_user_id) VALUES($1,$2::numeric,$3,$4,$5)").bind(case.id).bind(input.amount).bind(input.paid_on).bind(input.reference).bind(actor).execute(&mut *tx).await.map_err(internal)?;
    let status = if sum == cents(&gross)? {
        "paid"
    } else {
        "partially_paid"
    };
    sqlx::query("UPDATE commercial_cases SET status=$2 WHERE id=$1")
        .bind(case.id)
        .bind(status)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    commercial::event(
        &mut tx,
        case.id,
        "payment_recorded",
        Some(&case.status),
        status,
        actor,
    )
    .await?;
    tx.commit().await.map_err(internal)?;
    Ok(Success { success: true })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn amounts_are_exact_and_bounded() {
        assert_eq!(cents("12.05").unwrap(), 1205);
        assert_eq!(cents("0.1").unwrap(), 10);
        for invalid in ["-1", "1.001", "1e3", "NaN", "9999999999999999"] {
            assert!(cents(invalid).is_err(), "{invalid}");
        }
    }
    #[test]
    fn numbering_uses_eight_project_digits() {
        let d = NaiveDate::from_ymd_opt(2026, 11, 6).unwrap();
        assert_eq!(
            format_number(InvoiceNumberingScheme::ProjectLocal, 3, Id(238427), d),
            "00238427-3"
        );
        assert_eq!(
            format_number(InvoiceNumberingScheme::DateSeparated, 5368, Id(1), d),
            "26-11-06-5368"
        );
    }
}
