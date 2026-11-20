//! Capture a version of a tool's private rate without reading the price.
use super::super::access::{MetadataContext, metadata_context_for_domains};
use super::persistence::{read, record_key};
use super::registry::{DomainRecord, domain};
use super::*;
use crate::control::{Transaction, key};
use std::collections::BTreeSet;

const SOURCES: &str = "tool-rate-sources";
const MAX_TOOLS: usize = 32;

#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ToolRateSelection {
    tools: Vec<Id>,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct ToolRateReference {
    tool: Id,
    reference: String,
    sequence: String,
}

#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct HistoricalToolRate {
    tool: Id,
    reference: String,
}

fn tool_scope(tool: Id) -> RpcResult<String> {
    if tool.0 < 1 {
        return Err(invalid());
    }
    Ok(format!("tool:{}", tool.encode()))
}

fn can_book(guard: &Security, scope: &str) -> bool {
    guard.policy.allows(
        &guard.subject,
        "create:tool-tracking",
        Facet::MasterData,
        Action::Create,
    ) && guard.allows(&guard.subject, scope, Facet::MasterData, Action::Read)
        && guard.allows(&guard.subject, scope, Facet::MasterData, Action::Update)
}

async fn current_prices(
    transaction: &mut Transaction,
    areas: &[&DomainRecord],
) -> RpcResult<Vec<ObjectRecord>> {
    let ids: Vec<_> = areas
        .iter()
        .map(|area| format!("{}:record", area.id))
        .collect();
    let keys = areas
        .iter()
        .zip(&ids)
        .map(|(area, id)| record_key(&area.id, id))
        .collect();
    let records = transaction.many::<ObjectRecord>(keys).await?;
    areas
        .iter()
        .zip(ids)
        .zip(records)
        .map(|((area, id), record)| {
            let record = record
                .filter(|record| !record.deleted && !record.tombstone)
                .ok_or_else(not_found)?;
            if record.domain != area.id || record.object != id {
                return Err(invalid());
            }
            Ok(record)
        })
        .collect()
}

async fn references(
    mut context: MetadataContext,
    tools: Vec<Id>,
) -> RpcResult<Vec<ToolRateReference>> {
    let number = super::super::content::content_number(&mut context.transaction).await?;
    let mut areas = Vec::with_capacity(tools.len());
    for tool in &tools {
        let scope = tool_scope(*tool)?;
        if !can_book(&context.security, &scope) {
            return Err(forbidden());
        }
        areas.push(domain(&mut context.transaction, &format!("{scope}:procurement")).await?);
    }
    let area_refs: Vec<_> = areas.iter().collect();
    let prices = current_prices(&mut context.transaction, &area_refs).await?;
    let mut references = Vec::with_capacity(tools.len());
    for ((tool, area), price) in tools.into_iter().zip(areas).zip(prices) {
        references.push(ToolRateReference {
            tool,
            reference: price.reference,
            sequence: area.content_sequence(number)?,
        });
    }
    context.transaction.validate().await?;
    Ok(references)
}

/// A price head can be compared without read access only in a checkout that
/// updates the corresponding tool's booking pointer and creates a tracking.
pub(super) struct BookingRateGuards<'a> {
    tools: BTreeSet<&'a str>,
}

impl<'a> BookingRateGuards<'a> {
    pub fn new(packets: &'a [SaveInput]) -> Self {
        let mut tools = BTreeSet::new();
        let mut price_writes = BTreeSet::new();
        let mut new_tracking = false;
        for packet in packets {
            let envelope = &packet.envelope;
            if envelope.facet == Facet::Procurement && envelope.scope.starts_with("tool:") {
                price_writes.insert(envelope.scope.as_str());
            }
            if envelope.is_tombstone() {
                continue;
            }
            if envelope.facet == Facet::MasterData
                && envelope.scope.starts_with("tool:")
                && envelope.object.strip_suffix(":master-data:booking")
                    == Some(envelope.scope.as_str())
            {
                tools.insert(envelope.scope.as_str());
            }
            if envelope.revision == "1"
                && super::super::creation::initial_record_creation_scope(
                    &envelope.scope,
                    envelope.facet,
                    &envelope.object,
                ) == Some("create:tool-tracking")
            {
                new_tracking = true;
            }
        }
        if !new_tracking {
            tools.clear();
        } else {
            tools.retain(|tool| !price_writes.contains(tool));
        }
        Self { tools }
    }

    pub fn allows(&self, guard: &Security, area: &DomainRecord) -> bool {
        area.facet == Facet::Procurement
            && self.tools.contains(area.scope.as_str())
            && can_book(guard, &area.scope)
    }
}

/// Keep only the accepted price reference. The underlying ciphertext is already
/// included in full store backups. This index survives a business-data restore.
pub(super) async fn retain(
    transaction: &mut Transaction,
    areas: Vec<&DomainRecord>,
) -> RpcResult<()> {
    if areas.is_empty() {
        return Ok(());
    }
    let prices = current_prices(transaction, &areas).await?;
    let indexes: Vec<_> = prices
        .iter()
        .map(|price| key(SOURCES, &price.reference))
        .collect();
    let stored = transaction.many::<String>(indexes.clone()).await?;
    for ((area, index), previous) in areas.into_iter().zip(indexes).zip(stored) {
        match previous {
            Some(scope) if scope == area.scope => {}
            Some(_) => return Err(invalid()),
            None => transaction.put(index, &area.scope).await?,
        }
    }
    Ok(())
}

async fn historical(
    mut context: MetadataContext,
    scope: String,
    reference: String,
) -> RpcResult<EncryptedObject> {
    if !context.security.allows(
        &context.security.subject,
        &scope,
        Facet::Procurement,
        Action::Read,
    ) {
        return Err(forbidden());
    }
    let stored = context
        .transaction
        .read::<String>(key(SOURCES, &reference))
        .await?;
    if stored.as_deref() != Some(&scope) {
        return Err(not_found());
    }
    let envelope = read(&context.repository, &reference).await?;
    if envelope.tenant != context.auth.tenant
        || envelope.scope != scope
        || envelope.facet != Facet::Procurement
        || envelope.object != format!("{scope}:procurement:record")
        || envelope.is_tombstone()
    {
        return Err(invalid());
    }
    context.transaction.validate().await?;
    Ok(envelope)
}

pub(super) fn register(
    builder: ProcedureRegistryBuilder,
    service: Arc<crate::auth::AuthService>,
) -> ProcedureRegistryBuilder {
    let current_service = Arc::clone(&service);
    builder
        .query(
            "zerotrust.toolRates.references",
            move |request, input: ToolRateSelection| {
                let service = Arc::clone(&current_service);
                async move {
                    if input.tools.is_empty()
                        || input.tools.len() > MAX_TOOLS
                        || input
                            .tools
                            .iter()
                            .map(|tool| tool.0)
                            .collect::<BTreeSet<_>>()
                            .len()
                            != input.tools.len()
                    {
                        return Err(invalid());
                    }
                    let mut domains = Vec::with_capacity(input.tools.len() * 2);
                    for tool in &input.tools {
                        let scope = tool_scope(*tool)?;
                        domains.push(format!("{scope}:master-data"));
                        domains.push(format!("{scope}:procurement"));
                    }
                    let context =
                        metadata_context_for_domains(&service, &request, Some(&domains)).await?;
                    references(context, input.tools).await
                }
            },
        )
        .query(
            "zerotrust.toolRates.historical",
            move |request, input: HistoricalToolRate| {
                let service = Arc::clone(&service);
                async move {
                    if input.reference.len() != 64
                        || !input
                            .reference
                            .bytes()
                            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
                    {
                        return Err(invalid());
                    }
                    let scope = tool_scope(input.tool)?;
                    let domains = [format!("{scope}:procurement")];
                    let context =
                        metadata_context_for_domains(&service, &request, Some(&domains)).await?;
                    historical(context, scope, input.reference).await
                }
            },
        )
}

pub(super) fn register_contract(builder: ProcedureRegistryBuilder) -> ProcedureRegistryBuilder {
    builder
        .query_stub::<ToolRateSelection, Vec<ToolRateReference>>("zerotrust.toolRates.references")
        .query_stub::<HistoricalToolRate, EncryptedObject>("zerotrust.toolRates.historical")
}
