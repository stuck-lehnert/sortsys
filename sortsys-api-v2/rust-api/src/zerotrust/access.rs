use sqlx::{FromRow, PgConnection, PgPool};

use super::{
    crypto::{invalid, sized},
    wire::{Action, AuthorityCertificate, Facet, IdentityCertificate, Rule, SignedPolicy},
};
use crate::{
    auth::AuthResult,
    error::RpcResult,
    ids::Id,
    procedures::common::{forbidden, internal},
};

#[derive(FromRow)]
pub(super) struct Root {
    pub phase: String,
    pub generation: i64,
    pub policy_version: i64,
    pub catalog_version: i64,
    pub authority_key: Option<Vec<u8>>,
    pub recovery_encryption_key: Option<Vec<u8>>,
    pub recovery_signing_key: Option<Vec<u8>>,
}
pub(super) struct Security {
    pub root: Root,
    pub policy: SignedPolicy,
    pub subject: String,
    pub signing_key: Vec<u8>,
    pub authority: Vec<u8>,
    pub origins: Vec<super::creation::CreationOrigin>,
    pub inherited: Vec<Rule>,
}
impl Security {
    pub fn allows(&self, subject: &str, scope: &str, facet: Facet, action: Action) -> bool {
        self.policy
            .allows_with(&self.inherited, subject, scope, facet, action)
    }
}

/// Pending accounts use this only while accepting a signed invitation.
pub(super) async fn tenant_root(
    tx: &mut PgConnection,
    master: &PgPool,
    auth: &AuthResult,
    exclusive: bool,
) -> RpcResult<(Root, Vec<u8>)> {
    let (root, authority) = current_root(tx, master, &auth.tenant, exclusive).await?;
    // Authentication may have happened before waiting on the state lock.
    let current:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM user_sessions s JOIN users u ON u.id=s.user_id WHERE s.id=$1 AND u.id=$2 AND u.deactivated_at IS NULL AND s.expires_at>statement_timestamp() AND ($3=FALSE OR EXISTS(SELECT 1 FROM user_role_assignments r WHERE r.user_id=u.id AND r.role_name=':admin')))")
        .bind(auth.session.id.parse::<i64>().map_err(internal)?).bind(auth.user.id.parse::<i64>().map_err(internal)?).bind(auth.is_admin()).fetch_one(&mut *tx).await.map_err(internal)?;
    if !current {
        return Err(forbidden());
    }
    Ok((root, authority))
}

/// Public authority metadata. This never grants access to protected objects.
pub(super) async fn current_root(
    tx: &mut PgConnection,
    master: &PgPool,
    tenant: &str,
    exclusive: bool,
) -> RpcResult<(Root, Vec<u8>)> {
    let query = if exclusive {
        "SELECT phase,generation,policy_version,catalog_version,authority_key,recovery_encryption_key,recovery_signing_key FROM __zerotrust_state WHERE singleton FOR UPDATE"
    } else {
        "SELECT phase,generation,policy_version,catalog_version,authority_key,recovery_encryption_key,recovery_signing_key FROM __zerotrust_state WHERE singleton FOR SHARE"
    };
    let root = sqlx::query_as::<_, Root>(query)
        .fetch_one(&mut *tx)
        .await
        .map_err(internal)?;
    if !["enrolling", "active"].contains(&root.phase.as_str()) {
        return Err(forbidden());
    }
    let head: Option<i64> =
        sqlx::query_scalar("SELECT generation FROM __zerotrust_recovery_heads WHERE tenant=$1")
            .bind(tenant)
            .fetch_optional(master)
            .await
            .map_err(internal)?;
    if head != Some(root.generation) {
        return Err(forbidden());
    }
    let authority = root.authority_key.clone().ok_or_else(forbidden)?;
    let certificate: serde_json::Value =
        sqlx::query_scalar("SELECT certificate FROM __zerotrust_authorities WHERE generation=$1")
            .bind(root.generation)
            .fetch_one(&mut *tx)
            .await
            .map_err(internal)?;
    let certificate: AuthorityCertificate =
        serde_json::from_value(certificate).map_err(|_| invalid())?;
    certificate.verify()?;
    if certificate.tenant != tenant
        || certificate.generation != root.generation.to_string()
        || sized::<32>(&certificate.authority_signing_key)?.as_slice() != authority
        || Some(sized::<32>(&certificate.recovery_signing_key)?.to_vec())
            != root.recovery_signing_key
        || Some(sized::<32>(&certificate.recovery_encryption_key)?.to_vec())
            != root.recovery_encryption_key
    {
        return Err(forbidden());
    }
    Ok((root, authority))
}

pub(super) async fn security(
    tx: &mut PgConnection,
    master: &PgPool,
    auth: &AuthResult,
    exclusive: bool,
) -> RpcResult<Security> {
    let (root, authority) = tenant_root(tx, master, auth, exclusive).await?;
    let user = auth.user.id.parse::<i64>().map_err(internal)?;
    let subject = format!("user:{}", Id(user).encode());
    let (signing_key,encryption_key,certificate):(Vec<u8>,Vec<u8>,serde_json::Value)=sqlx::query_as("SELECT signing_key,encryption_key,identity_certificate FROM __zerotrust_accounts WHERE user_id=$1")
        .bind(user).fetch_optional(&mut *tx).await.map_err(internal)?.ok_or_else(forbidden)?;
    let certificate: IdentityCertificate =
        serde_json::from_value(certificate).map_err(|_| forbidden())?;
    certificate.verify(&authority)?;
    if certificate.tenant != auth.tenant
        || certificate.generation != root.generation.to_string()
        || certificate.user != subject
        || sized::<32>(&certificate.signing_key)?.as_slice() != signing_key
        || sized::<32>(&certificate.encryption_key)?.as_slice() != encryption_key
    {
        return Err(forbidden());
    }
    let policy: serde_json::Value = sqlx::query_scalar(
        "SELECT policy FROM __zerotrust_policies WHERE version=$1 AND generation=$2",
    )
    .bind(root.policy_version)
    .bind(root.generation)
    .fetch_one(&mut *tx)
    .await
    .map_err(internal)?;
    let policy: SignedPolicy = serde_json::from_value(policy).map_err(|_| invalid())?;
    policy.verify(&authority)?;
    if policy.tenant != auth.tenant || policy.version != root.policy_version.to_string() {
        return Err(forbidden());
    }
    let origins = super::creation::origins(
        tx,
        &auth.tenant,
        root.generation,
        &authority,
        &subject,
        auth.is_admin(),
    )
    .await?;
    let inherited = origins
        .iter()
        .flat_map(super::creation::CreationOrigin::rules)
        .collect();
    Ok(Security {
        root,
        policy,
        subject,
        signing_key,
        authority,
        origins,
        inherited,
    })
}
