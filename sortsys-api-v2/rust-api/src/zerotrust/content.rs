//! Content selection is authorized by the tenant authority, independently of
//! operator snapshot storage and independently of account/seed recovery.
use super::{
    crypto::{invalid, revision, sized},
    objects::AuthorityHistory,
    wire::AuthorityCertificate,
};
use crate::{
    control::{Transaction, key},
    error::RpcResult,
};

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
