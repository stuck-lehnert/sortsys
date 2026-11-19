//! Seed-authorized, bounded reads of one recovery inventory. A page never
//! freezes a whole database transaction across requests or assumes sticky sessions.
use super::*;
use sortsys_zerotrust::{
    pagination::SnapshotPage, recovery::RecoveryPageAccess,
    recovery_inventory::RECOVERY_INVENTORY_PAGE_ITEMS,
};

const DEFINITIONS_PER_READ: usize = 64;
const KEY_PAGE_BYTES: usize = 4 * 1024 * 1024;

#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecoveryPageInput {
    tenant: String,
    generation: String,
    challenge_id: String,
    snapshot: String,
    after: Option<String>,
    proof: String,
}

#[derive(Serialize, TS)]
#[serde(tag = "kind", content = "value", rename_all = "kebab-case")]
enum RecoveryInventoryItem {
    Domain(DomainInfo),
    Key(Box<DomainDefinition>),
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "section", rename_all = "camelCase", deny_unknown_fields)]
enum Cursor {
    Domains { after: String },
    KeysStart,
    Keys { domain: String, generation: String },
}

impl Cursor {
    fn parse(input: Option<&str>) -> RpcResult<Option<Self>> {
        let Some(input) = input else { return Ok(None) };
        if input.len() > 2048 {
            return Err(invalid());
        }
        let value: Self = serde_json::from_slice(&decode(input, 2048)?).map_err(|_| invalid())?;
        match &value {
            Self::Domains { after } => identifier(after)?,
            Self::Keys { domain, generation } => {
                identifier(domain)?;
                revision(generation)?;
            }
            Self::KeysStart => {}
        }
        Ok(Some(value))
    }

    fn encode(&self) -> sortsys_zerotrust::Result<String> {
        let bytes =
            serde_json::to_vec(self).map_err(|_| sortsys_zerotrust::Error::InvalidProtectedData)?;
        Ok(encode(&bytes))
    }
}

pub(super) fn register(
    builder: ProcedureRegistryBuilder,
    service: Arc<crate::auth::AuthService>,
) -> ProcedureRegistryBuilder {
    builder.mutation(
        "zerotrust.recovery.page",
        move |_, input: RecoveryPageInput| {
            let service = Arc::clone(&service);
            async move { read_page(&service, input).await }
        },
    )
}
pub(super) fn register_contract(builder: ProcedureRegistryBuilder) -> ProcedureRegistryBuilder {
    builder.mutation_stub::<RecoveryPageInput, SnapshotPage<RecoveryInventoryItem>>(
        "zerotrust.recovery.page",
    )
}
async fn read_page(
    service: &crate::auth::AuthService,
    input: RecoveryPageInput,
) -> RpcResult<SnapshotPage<RecoveryInventoryItem>> {
    let _admission = crate::auth_limits::admit_login()?;
    identifier(&input.snapshot)?;
    let cursor = Cursor::parse(input.after.as_deref())?;
    let repository = persistence::repository(service, &input.tenant).await?;
    let mut transaction = repository.transaction()?;
    let root = super::super::setup::metadata_root(&mut transaction, &input.tenant).await?;
    if root.profile.authority.generation != input.generation
        || persistence::snapshot(&root)? != input.snapshot
    {
        return Err(conflict());
    }
    let grant = persistence::challenge(&mut transaction, &root, &input.challenge_id).await?;
    let access = RecoveryPageAccess {
        tenant: input.tenant.clone(),
        generation: input.generation.clone(),
        challenge_id: input.challenge_id,
        challenge: grant.nonce,
        snapshot: input.snapshot.clone(),
        after: input.after,
    };
    verify(
        &sized::<32>(&root.profile.authority.recovery_signing_key)?,
        &input.proof,
        &access.frame()?,
    )?;
    let page = match cursor {
        None => domain_page(&mut transaction, input.snapshot, None).await?,
        Some(Cursor::Domains { after }) => {
            domain_page(&mut transaction, input.snapshot, Some(after)).await?
        }
        Some(Cursor::KeysStart) => key_page(&mut transaction, &root, input.snapshot, None).await?,
        Some(Cursor::Keys { domain, generation }) => {
            key_page(
                &mut transaction,
                &root,
                input.snapshot,
                Some(format!("{domain}:{:020}", revision(&generation)?)),
            )
            .await?
        }
    };
    transaction.validate().await?;
    Ok(page)
}
async fn domain_page(
    transaction: &mut crate::control::Transaction,
    snapshot: String,
    after: Option<String>,
) -> RpcResult<SnapshotPage<RecoveryInventoryItem>> {
    let page = transaction
        .scan_with_limit::<super::super::objects::DomainDescriptor>(
            "domain-catalog",
            after,
            RECOVERY_INVENTORY_PAGE_ITEMS,
        )
        .await?;
    let mut items = Vec::new();
    let mut heads = Vec::with_capacity(page.records.len() * 2);
    for row in &page.records {
        let descriptor = row.value.as_ref().ok_or_else(invalid)?;
        identifier(&descriptor.id)?;
        heads.extend(super::super::objects::registry::domain_keys(&descriptor.id));
    }
    transaction.prefetch(heads).await?;
    for row in page.records {
        let descriptor = row.value.ok_or_else(invalid)?;
        let domain =
            super::super::objects::registry::retained_domain(transaction, &descriptor.id).await?;
        if domain.id != descriptor.id
            || domain.scope != descriptor.scope
            || domain.facet != descriptor.facet
        {
            return Err(invalid());
        }
        items.push(RecoveryInventoryItem::Domain(DomainInfo {
            id: domain.id,
            scope: domain.scope,
            facet: domain.facet,
            generation: domain.generation,
        }));
    }
    let after = match page.after {
        Some(after) => Cursor::Domains { after }.encode()?,
        None => Cursor::KeysStart.encode()?,
    };
    Ok(SnapshotPage {
        snapshot,
        items,
        after: Some(after),
    })
}
async fn key_page(
    transaction: &mut crate::control::Transaction,
    root: &super::super::setup::RootState,
    snapshot: String,
    after: Option<String>,
) -> RpcResult<SnapshotPage<RecoveryInventoryItem>> {
    use super::super::objects::registry::{RecoveryKeyReference, definition_key};
    let generation = &root.profile.authority.generation;
    let collection = format!("recovery-inventory-{generation}");
    let page = transaction
        .scan_with_limit::<RecoveryKeyReference>(&collection, after, RECOVERY_INVENTORY_PAGE_ITEMS)
        .await?;
    let mut items = Vec::new();
    let mut bytes = 0usize;
    let mut last = None;
    // Definitions can carry many recipient envelopes. Fetch a small group at
    // a time and stop once the browser page reaches its byte budget.
    for rows in page.records.chunks(DEFINITIONS_PER_READ) {
        let mut keys = Vec::with_capacity(rows.len() * 3);
        for row in rows {
            let reference = row.value.as_ref().ok_or_else(invalid)?;
            if reference.authority_generation != *generation
                || super::super::objects::registry::recovery_key(reference)? != row.record
            {
                return Err(invalid());
            }
            keys.push(definition_key(
                &reference.domain,
                &reference.generation,
                generation,
            )?);
            keys.extend(super::super::objects::registry::domain_keys(
                &reference.domain,
            ));
        }
        transaction.prefetch(keys).await?;

        for row in rows {
            let reference = row.value.as_ref().ok_or_else(invalid)?;
            let definition: DomainDefinition = transaction
                .read(definition_key(
                    &reference.domain,
                    &reference.generation,
                    generation,
                )?)
                .await?
                .ok_or_else(invalid)?;
            let domain =
                super::super::objects::registry::retained_domain(transaction, &reference.domain)
                    .await?;
            if definition.tenant != root.profile.authority.tenant
                || definition.id != reference.domain
                || definition.generation != reference.generation
                || definition.scope != domain.scope
                || definition.facet != domain.facet
                || revision(&reference.generation)? > revision(&domain.generation)?
                || definition.recovery_envelope.recipient != format!("recovery:{generation}")
            {
                return Err(invalid());
            }
            let size = serde_json::to_vec(&definition).map_err(internal)?.len();
            if !items.is_empty() && bytes.saturating_add(size) > KEY_PAGE_BYTES {
                return Ok(SnapshotPage {
                    snapshot,
                    items,
                    after: last,
                });
            }
            bytes = bytes.saturating_add(size);
            last = Some(
                Cursor::Keys {
                    domain: reference.domain.clone(),
                    generation: reference.generation.clone(),
                }
                .encode()?,
            );
            items.push(RecoveryInventoryItem::Key(Box::new(definition)));
        }
    }
    Ok(SnapshotPage {
        snapshot,
        items,
        after: if page.after.is_some() { last } else { None },
    })
}
