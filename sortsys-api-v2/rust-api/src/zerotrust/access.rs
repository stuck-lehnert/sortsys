use super::{
    crypto::sized,
    wire::{Action, Facet, IdentityCertificate, Rule, SignedPolicy},
};
use crate::{auth::AuthResult, error::RpcResult, error::forbidden, ids::Id};

pub(super) struct Root {
    pub generation: i64,
    pub policy_version: i64,
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

/// Load the public authorization context from the same tenant file as the
/// account and ciphertext references. Every observation participates in CAS.
pub(super) async fn metadata_security(
    transaction: &mut crate::control::Transaction,
    auth: &AuthResult,
) -> RpcResult<Security> {
    metadata_security_for_domains(transaction, auth, None).await
}

pub(super) async fn metadata_security_for_domains(
    transaction: &mut crate::control::Transaction,
    auth: &AuthResult,
    domains: Option<&[String]>,
) -> RpcResult<Security> {
    metadata_security_for_selection(transaction, auth, domains, DomainReads::WithHeads).await
}

enum DomainReads {
    WithHeads,
    OriginsOnly,
}

async fn metadata_security_for_selection(
    transaction: &mut crate::control::Transaction,
    auth: &AuthResult,
    domains: Option<&[String]>,
    domain_reads: DomainReads,
) -> RpcResult<Security> {
    use crate::control::{accounts, key};
    let (account, _) = accounts::checked_session(transaction, auth).await?;
    let stored = super::setup::metadata_root(transaction, &auth.tenant).await?;
    let certificate = &stored.profile.authority;
    let generation = super::crypto::revision(&certificate.generation)?;
    let authority = sized::<32>(&certificate.authority_signing_key)?.to_vec();
    let mut records = vec![key("policies", &stored.policy_version)];
    if let Some(domains) = domains {
        let origins = format!("created-areas-{generation}");
        for domain in domains {
            records.push(key(&origins, domain));
            if matches!(domain_reads, DomainReads::WithHeads) {
                records.push(key("domains", domain));
            }
        }
    }
    transaction.prefetch(records).await?;
    let subject = format!("user:{}", Id(account.id).encode());
    let identity: IdentityCertificate =
        serde_json::from_value(account.credential()?.certificate.clone())
            .map_err(|_| forbidden())?;
    identity.verify(&authority)?;
    if identity.tenant != auth.tenant
        || identity.user != subject
        || identity.generation != certificate.generation
        || identity.signing_key != account.credential()?.vault.signing_key
        || identity.encryption_key != account.credential()?.vault.encryption_key
    {
        return Err(forbidden());
    }
    let policy: SignedPolicy = transaction
        .read(key("policies", &stored.policy_version))
        .await?
        .ok_or_else(forbidden)?;
    policy.verify(&authority)?;
    if policy.tenant != auth.tenant
        || policy.version != stored.policy_version
        || policy
            .suspended
            .as_ref()
            .is_some_and(|members| members.contains(&subject))
    {
        return Err(forbidden());
    }
    let origins = super::creation::metadata_origins(
        transaction,
        auth,
        generation,
        &authority,
        &subject,
        &policy,
        domains,
    )
    .await?;
    let inherited = origins
        .iter()
        .flat_map(|origin| {
            let mut rules = origin.rules();
            rules.extend(origin.active_booking_rules(&policy));
            rules
        })
        .collect();
    sized::<32>(&certificate.recovery_encryption_key)?;
    sized::<32>(&certificate.recovery_signing_key)?;
    Ok(Security {
        root: Root {
            generation,
            policy_version: super::crypto::revision(&stored.policy_version)?,
        },
        policy,
        subject,
        signing_key: sized::<32>(&identity.signing_key)?.to_vec(),
        authority,
        origins,
        inherited,
    })
}

pub(super) struct MetadataContext {
    pub auth: AuthResult,
    pub transaction: crate::control::Transaction,
    pub repository: crate::control::Repository,
    pub security: Security,
}

/// Resolve an object's public domain inside the transaction that will also
/// authorize it. The lookup is not a read permission; callers must authorize
/// before returning data or publishing a change.
pub(super) struct MetadataRequest {
    pub auth: AuthResult,
    pub transaction: crate::control::Transaction,
    pub repository: crate::control::Repository,
}

impl MetadataRequest {
    pub async fn open(
        service: &crate::auth::AuthService,
        request: &crate::rpc::RequestContext,
    ) -> RpcResult<Self> {
        let auth = service.authenticate(&request.headers).await?;
        let repository = service.records()?.tenant(&auth.tenant)?;
        let transaction = repository.transaction()?;
        Ok(Self {
            auth,
            transaction,
            repository,
        })
    }

    pub async fn authorize(self, domains: Option<&[String]>) -> RpcResult<MetadataContext> {
        self.authorize_for(domains, DomainReads::WithHeads).await
    }

    /// A public origin inventory does not depend on mutable content heads.
    pub async fn authorize_origins(self, domains: &[String]) -> RpcResult<MetadataContext> {
        self.authorize_for(Some(domains), DomainReads::OriginsOnly)
            .await
    }

    async fn authorize_for(
        mut self,
        domains: Option<&[String]>,
        domain_reads: DomainReads,
    ) -> RpcResult<MetadataContext> {
        let security = metadata_security_for_selection(
            &mut self.transaction,
            &self.auth,
            domains,
            domain_reads,
        )
        .await?;
        Ok(MetadataContext {
            auth: self.auth,
            transaction: self.transaction,
            repository: self.repository,
            security,
        })
    }
}

pub(super) async fn metadata_context(
    service: &crate::auth::AuthService,
    request: &crate::rpc::RequestContext,
) -> RpcResult<MetadataContext> {
    metadata_context_for_domains(service, request, None).await
}

/// High frequency operations need only the creation grants for their own
/// domains. The current session, authority and policy are still checked and
/// included in the transaction's read set on every request.
pub(super) async fn metadata_context_for_domains(
    service: &crate::auth::AuthService,
    request: &crate::rpc::RequestContext,
    domains: Option<&[String]>,
) -> RpcResult<MetadataContext> {
    MetadataRequest::open(service, request)
        .await?
        .authorize(domains)
        .await
}
