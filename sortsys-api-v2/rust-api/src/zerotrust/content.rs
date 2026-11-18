//! Content selection is authorized by the tenant authority, independently of
//! operator snapshot storage and independently of account/seed recovery.
use super::{
    crypto::{invalid, revision, sized},
    objects::AuthorityHistory,
    wire::AuthorityCertificate,
};
use crate::{
    auth::AuthService,
    control::{Transaction, key},
    error::{RpcError, RpcResult, bad_request, forbidden},
    rpc::{ProcedureRegistryBuilder, RequestContext},
};
use serde::{Deserialize, Serialize};
use sortsys_zerotrust::content_epoch::{ContentEpoch, logical_record};
use std::{collections::BTreeSet, sync::Arc};
use ts_rs::TS;

#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PrepareInput {
    snapshot_operation: String,
    operation: String,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct PreparedContent {
    operation: String,
    snapshot_operation: String,
    snapshot: String,
    bytes: String,
    current: Option<ContentEpoch>,
    source: Option<ContentEpoch>,
    source_authority: AuthorityCertificate,
    number: String,
    records: String,
    ciphertexts: String,
}

pub(super) fn register(
    builder: ProcedureRegistryBuilder,
    service: Arc<AuthService>,
) -> ProcedureRegistryBuilder {
    builder.mutation(
        "zerotrust.content.prepare",
        move |request: RequestContext, input: PrepareInput| {
            let service = service.clone();
            async move { prepare(&service, &request, input).await }
        },
    )
}

pub(super) fn register_contract(builder: ProcedureRegistryBuilder) -> ProcedureRegistryBuilder {
    builder.mutation_stub::<PrepareInput, PreparedContent>("zerotrust.content.prepare")
}

fn history_key(number: &str) -> RpcResult<sortsys_zerotrust::metadata::RecordKey> {
    Ok(key(
        "zt-content-epochs",
        &format!("epoch-{:020}", revision(number)?),
    ))
}

async fn source_authority(
    context: &mut super::access::MetadataContext,
    description: &sortsys_store::content::Description,
) -> RpcResult<AuthorityCertificate> {
    let [record] = description.records.as_slice() else {
        return Err(invalid());
    };
    if record.record != super::setup::root_key() {
        return Err(invalid());
    }
    let root: super::setup::RootState = serde_json::from_str(
        record
            .value
            .as_deref()
            .ok_or_else(|| bad_request("Snapshot has no tenant authority"))?,
    )
    .map_err(|_| invalid())?;
    let certificate = root.profile.authority;
    certificate.verify()?;
    if certificate.tenant != context.auth.tenant
        || revision(&certificate.generation)? > context.security.root.generation
    {
        return Err(invalid());
    }
    let published: AuthorityHistory = context
        .transaction
        .read(key(
            "authority-history",
            &format!("{:020}", revision(&certificate.generation)?),
        ))
        .await?
        .ok_or_else(invalid)?;
    if published.certificate.frame()? != certificate.frame()?
        || published.certificate.signature != certificate.signature
    {
        return Err(invalid());
    }
    if let Some(head) = &description.head {
        if revision(&head.authority_generation)? > revision(&certificate.generation)? {
            return Err(invalid());
        }
        let known: ContentEpoch = context
            .transaction
            .read(history_key(&head.number)?)
            .await?
            .ok_or_else(|| {
                bad_request("Snapshot content epoch was not published by this tenant")
            })?;
        if known != *head {
            return Err(invalid());
        }
        if head.authority_generation == certificate.generation {
            head.verify(
                &context.auth.tenant,
                Some(&certificate.generation),
                None,
                &sized::<32>(&certificate.authority_signing_key)?,
            )?;
        } else {
            let authority: AuthorityHistory = context
                .transaction
                .read(key(
                    "authority-history",
                    &format!("{:020}", revision(&head.authority_generation)?),
                ))
                .await?
                .ok_or_else(invalid)?;
            authority.certificate.verify()?;
            if authority.certificate.tenant != context.auth.tenant {
                return Err(invalid());
            }
            head.verify(
                &context.auth.tenant,
                Some(&authority.certificate.generation),
                None,
                &sized::<32>(&authority.certificate.authority_signing_key)?,
            )?;
        }
    }
    Ok(certificate)
}

async fn admin_context(
    service: &AuthService,
    request: &RequestContext,
) -> RpcResult<super::access::MetadataContext> {
    let context = super::access::MetadataRequest::open(service, request)
        .await?
        .authorize_origins(&[])
        .await?;
    if !context.auth.is_admin() {
        return Err(forbidden());
    }
    Ok(context)
}

fn storage_error(error: sortsys_store::StoreError) -> RpcError {
    match error {
        sortsys_store::StoreError::Conflict => super::objects::conflict(),
        sortsys_store::StoreError::NotFound => bad_request("Snapshot not found"),
        sortsys_store::StoreError::Integrity => {
            bad_request("Snapshot does not match the requested content preparation")
        }
        _ => crate::control::unavailable(),
    }
}

async fn prepare(
    service: &AuthService,
    request: &RequestContext,
    input: PrepareInput,
) -> RpcResult<PreparedContent> {
    let context = admin_context(service, request).await?;
    let tenant = context.auth.tenant.clone();
    let storage = context.repository.storage().clone();
    context.transaction.validate().await?;
    let (file_id, bytes) =
        crate::storage::published_file(service.records()?, &tenant, &input.snapshot_operation)
            .await?;
    let selection = sortsys_store::content::SnapshotSelection {
        tenant,
        operation: input.snapshot_operation.clone(),
    };
    let description = storage
        .describe_content(&sortsys_store::content::DescribeInput {
            source: selection.clone(),
            records: vec![super::setup::root_key()],
        })
        .await
        .map_err(storage_error)?;
    if description.id != file_id || description.bytes != bytes {
        return Err(invalid());
    }
    let mut context = admin_context(service, request).await?;
    let authority = source_authority(&mut context, &description).await?;
    let current = context.transaction.content_epoch().await?;
    let current_number = current
        .as_ref()
        .map(|head| revision(&head.number))
        .transpose()?
        .unwrap_or(0);
    let number = current_number
        .checked_add(1)
        .ok_or_else(invalid)?
        .to_string();
    let previous = current
        .as_ref()
        .map(ContentEpoch::fingerprint)
        .transpose()?;
    let source_number = description
        .head
        .as_ref()
        .map_or("0", |head| head.number.as_str());
    let source_head = description
        .head
        .as_ref()
        .map(ContentEpoch::fingerprint)
        .transpose()?;
    let mut collections = BTreeSet::new();
    for physical in &description.collections {
        let record = sortsys_zerotrust::metadata::RecordKey {
            collection: physical.clone(),
            key: "sample".into(),
        };
        if let Ok(logical) = logical_record(&record, source_number)
            && crate::control::content::collection(&logical.collection)
        {
            collections.insert(logical.collection);
        }
    }
    let preparation = sortsys_store::content::PrepareInput {
        source: selection,
        operation: input.operation.clone(),
        number: number.clone(),
        previous: previous.clone(),
        snapshot: description.digest.clone(),
        source_number: source_number.into(),
        source_head,
        collections: collections.into_iter().collect(),
    };
    context.transaction.validate().await?;
    let prepared = storage
        .prepare_content(&preparation)
        .await
        .map_err(storage_error)?;
    if prepared.operation != input.operation
        || prepared.number != number
        || prepared.previous != previous
        || prepared.snapshot != description.digest
        || prepared.source_number != preparation.source_number
        || prepared.source_head != preparation.source_head
        || prepared.request != preparation.fingerprint().map_err(storage_error)?
        || prepared.phase != sortsys_store::content::Phase::Ready
    {
        return Err(invalid());
    }
    // Copying ciphertext needs no frozen authorization lease. Recheck the live
    // session and rights after the bounded, resumable storage operation.
    let mut context = admin_context(service, request).await?;
    source_authority(&mut context, &description).await?;
    if context.transaction.content_epoch().await? != current {
        return Err(super::objects::conflict());
    }
    let ready: Option<sortsys_store::content::Preparation> = context
        .transaction
        .read(sortsys_store::content::preparation_key(&number).map_err(storage_error)?)
        .await?;
    if ready.as_ref() != Some(&prepared) {
        return Err(super::objects::conflict());
    }
    context.transaction.validate().await?;
    Ok(PreparedContent {
        operation: input.operation,
        snapshot_operation: input.snapshot_operation,
        snapshot: description.digest,
        bytes: description.bytes.to_string(),
        current,
        source: description.head,
        source_authority: authority,
        number,
        records: prepared.records,
        ciphertexts: prepared.ciphertexts,
    })
}

pub(super) async fn verify_view(
    transaction: &mut Transaction,
    tenant: &str,
    current: &AuthorityCertificate,
) -> RpcResult<()> {
    let Some(head) = transaction.content_epoch().await? else {
        return Ok(());
    };
    if revision(&head.authority_generation)? > revision(&current.generation)? {
        return Err(invalid());
    }
    let authority = if head.authority_generation == current.generation {
        current.clone()
    } else {
        let history: AuthorityHistory = transaction
            .read(key(
                "authority-history",
                &format!("{:020}", revision(&head.authority_generation)?),
            ))
            .await?
            .ok_or_else(invalid)?;
        history.certificate
    };
    authority.verify()?;
    if authority.tenant != tenant || authority.generation != head.authority_generation {
        return Err(invalid());
    }
    head.verify(
        tenant,
        Some(&authority.generation),
        None,
        &sized::<32>(&authority.authority_signing_key)?,
    )?;
    Ok(())
}

pub(super) async fn fingerprint(transaction: &mut Transaction) -> RpcResult<Option<String>> {
    Ok(transaction
        .content_epoch()
        .await?
        .as_ref()
        .map(ContentEpoch::fingerprint)
        .transpose()?)
}

pub(super) async fn require_current(
    transaction: &mut Transaction,
    expected: Option<&str>,
) -> RpcResult<()> {
    if fingerprint(transaction).await?.as_deref() != expected {
        return Err(super::objects::conflict());
    }
    Ok(())
}

pub(super) async fn content_number(transaction: &mut Transaction) -> RpcResult<i64> {
    match transaction.content_epoch().await? {
        Some(head) => revision(&head.number),
        None => Ok(0),
    }
}
