//! Capture a version of a tool's private rate without reading the price.
use super::super::access::{MetadataContext, metadata_context_for_domains};
use super::persistence::{read, record_key};
use super::registry::{DomainRecord, domain};
use super::*;
use crate::control::{Transaction, key};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

const SOURCES: &str = "tool-rate-sources";
const MAX_TOOLS: usize = 32;

#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ToolRateSelection {
    tools: Vec<Id>,
}

#[derive(Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in crate::zerotrust) struct ToolRateReference {
    tool: Id,
    reference: String,
    sequence: String,
}

#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct HistoricalToolRate {
    tool: Id,
    tracking: Id,
    reference: String,
}

fn valid_reference(reference: &str) -> bool {
    reference.len() == 64
        && reference
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
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

#[derive(Clone, Deserialize, PartialEq, Serialize)]
struct PinnedRate {
    reference: String,
    booking_signature: String,
    tool_binding: String,
}

struct BookingRatePin {
    tracking: Id,
    object: String,
    scope: String,
    domain: String,
    source: ToolRateReference,
    proof: PinnedRate,
}

pub(super) struct BookingRatePins(Vec<BookingRatePin>);

impl BookingRatePins {
    pub fn new(packets: &[SaveInput]) -> RpcResult<Self> {
        if !packets.iter().any(|packet| packet.tool_rate.is_some()) {
            return Ok(Self(Vec::new()));
        }
        let written: BTreeSet<_> = packets
            .iter()
            .filter(|packet| !packet.envelope.is_tombstone())
            .map(|packet| packet.envelope.object.as_str())
            .collect();
        let mut tools = BTreeSet::new();
        let mut pins = Vec::new();
        for packet in packets {
            let Some(source) = &packet.tool_rate else {
                continue;
            };
            let envelope = &packet.envelope;
            let scope = tool_scope(source.tool)?;
            let domain = format!("{scope}:procurement");
            if envelope.revision != "1"
                || envelope.is_tombstone()
                || packet.migration_origin.is_some()
                || super::super::creation::initial_record_creation_scope(
                    &envelope.scope,
                    envelope.facet,
                    &envelope.object,
                ) != Some("create:tool-tracking")
                || !valid_reference(&source.reference)
                || !tools.insert(source.tool.0)
                || !written.contains(format!("{scope}:master-data:booking").as_str())
                || written.contains(format!("{domain}:record").as_str())
            {
                return Err(invalid());
            }
            revision(&source.sequence)?;
            let tracking = envelope
                .scope
                .strip_prefix("tool-tracking:")
                .ok_or_else(invalid)?;
            let tracking = Id::decode(tracking).map_err(|_| invalid())?;
            pins.push(BookingRatePin {
                tracking,
                object: envelope.object.clone(),
                scope,
                domain,
                proof: PinnedRate {
                    reference: source.reference.clone(),
                    booking_signature: envelope.signature.clone(),
                    tool_binding: tool_binding(tracking, source.tool),
                },
                source: source.clone(),
            });
        }
        Ok(Self(pins))
    }

    pub fn domains(&self) -> impl Iterator<Item = String> + '_ {
        self.0
            .iter()
            .flat_map(|pin| [format!("{}:master-data", pin.scope), pin.domain.clone()])
    }

    /// The ciphertext is already in the store. Keep the reference with the
    /// booking outside the restorable content epochs and allow exact replay.
    pub async fn retain(
        &self,
        context: &mut MetadataContext,
        areas: &BTreeMap<String, DomainRecord>,
        content_number: i64,
        written: &[&SaveInput],
    ) -> RpcResult<()> {
        if self.0.is_empty() {
            return Ok(());
        }
        let written: BTreeSet<_> = written
            .iter()
            .map(|packet| packet.envelope.object.as_str())
            .collect();
        let indexes: Vec<_> = self.0.iter().map(|pin| rate_key(pin.tracking)).collect();
        let stored = context
            .transaction
            .many::<PinnedRate>(indexes.clone())
            .await?;
        let mut pending = Vec::new();
        for ((pin, index), previous) in self.0.iter().zip(indexes).zip(stored) {
            if !can_book(&context.security, &pin.scope) {
                return Err(forbidden());
            }
            if let Some(proof) = previous {
                if proof != pin.proof {
                    return Err(conflict());
                }
                continue;
            }
            if !written.contains(pin.object.as_str()) {
                return Err(conflict());
            }
            let area = areas.get(&pin.domain).ok_or_else(invalid)?;
            if area.scope != pin.scope || area.facet != Facet::Procurement {
                return Err(invalid());
            }
            if area.content_sequence(content_number)? != pin.source.sequence {
                return Err(conflict());
            }
            pending.push((pin, index, area));
        }
        let pending_areas: Vec<_> = pending.iter().map(|(_, _, area)| *area).collect();
        let prices = current_prices(&mut context.transaction, &pending_areas).await?;
        for ((pin, index, _), price) in pending.into_iter().zip(prices) {
            if price.reference != pin.source.reference {
                return Err(conflict());
            }
            context.transaction.put(index, &pin.proof).await?;
        }
        Ok(())
    }
}

fn rate_key(tracking: Id) -> sortsys_zerotrust::metadata::RecordKey {
    key(SOURCES, &tracking.encode())
}

fn tool_binding(tracking: Id, tool: Id) -> String {
    super::super::crypto::encode(&Sha256::digest(frame(
        "sortsys/tool-rate-pin/v1",
        &[&tracking.encode(), &tool.encode()],
    )))
}

async fn historical(
    mut context: MetadataContext,
    scope: String,
    input: HistoricalToolRate,
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
        .read::<PinnedRate>(rate_key(input.tracking))
        .await?;
    if !stored.is_some_and(|proof| {
        proof.reference == input.reference
            && proof.tool_binding == tool_binding(input.tracking, input.tool)
    }) {
        return Err(not_found());
    }
    let envelope = read(&context.repository, &input.reference).await?;
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
                    if !valid_reference(&input.reference) || input.tracking.0 < 1 {
                        return Err(invalid());
                    }
                    let scope = tool_scope(input.tool)?;
                    let domains = [format!("{scope}:procurement")];
                    let context =
                        metadata_context_for_domains(&service, &request, Some(&domains)).await?;
                    historical(context, scope, input).await
                }
            },
        )
}

pub(super) fn register_contract(builder: ProcedureRegistryBuilder) -> ProcedureRegistryBuilder {
    builder
        .query_stub::<ToolRateSelection, Vec<ToolRateReference>>("zerotrust.toolRates.references")
        .query_stub::<HistoricalToolRate, EncryptedObject>("zerotrust.toolRates.historical")
}
