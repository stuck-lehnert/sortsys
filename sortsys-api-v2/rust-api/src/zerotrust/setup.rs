use super::{
    crypto::{encode, frame, invalid, sized, verify},
    wire::{
        Action, AuthorityCertificate, Effect, Facet, IdentityCertificate, SealedBox, SignedPolicy,
    },
};
use crate::{
    AppState,
    api::Success,
    error::{ErrorCode, RpcError, RpcResult},
    ids::Id,
    procedures::common::{authenticated_pool, forbidden, internal},
    rpc::{ProcedureRegistryBuilder, RequestContext},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use std::sync::Arc;
use ts_rs::TS;

fn conflict(message: &'static str) -> RpcError {
    RpcError::new(ErrorCode::Conflict, message).with_http_code(409)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browser_bootstrap_verifies_without_private_or_recovery_keys_on_the_server() {
        let fixture: Value =
            serde_json::from_str(include_str!("../../tests/fixtures/zerotrust-setup.json"))
                .unwrap();
        let input: SetupInput = serde_json::from_value(fixture["setup"].clone()).unwrap();
        let encryption = sized::<32>(fixture["owner"]["encryptionKey"].as_str().unwrap()).unwrap();
        let signing = sized::<32>(fixture["owner"]["signingKey"].as_str().unwrap()).unwrap();
        input
            .validate("test", "user:interop", &encryption, &signing)
            .unwrap();
        assert!(
            input
                .validate("other", "user:interop", &encryption, &signing)
                .is_err()
        );
        assert!(
            input
                .validate("test", "user:other", &encryption, &signing)
                .is_err()
        );
        let mut changed = input.clone();
        changed.authority.recovery_signing_key = encode(&[1; 32]);
        assert!(
            changed
                .validate("test", "user:interop", &encryption, &signing)
                .is_err()
        );
        let mut bad = fixture["setup"].clone();
        bad["seedPhrase"] = serde_json::json!("must never be an accepted server parameter");
        assert!(serde_json::from_value::<SetupInput>(bad).is_err());
    }

    #[test]
    fn access_status_requires_a_certificate_matching_the_current_root_and_account_keys() {
        let fixture: Value =
            serde_json::from_str(include_str!("../../tests/fixtures/zerotrust-setup.json"))
                .unwrap();
        let setup: SetupInput = serde_json::from_value(fixture["setup"].clone()).unwrap();
        let make = || AccountCertification {
            identity_certificate: serde_json::to_value(&setup.owner).unwrap(),
            encryption_key: sized::<32>(&setup.owner.encryption_key).unwrap().to_vec(),
            signing_key: sized::<32>(&setup.owner.signing_key).unwrap().to_vec(),
            authority_key: Some(
                sized::<32>(&setup.authority.authority_signing_key)
                    .unwrap()
                    .to_vec(),
            ),
        };
        assert!(make().valid("test", "user:interop", 1));
        assert!(!make().valid("test", "user:other", 1));
        assert!(!make().valid("other", "user:interop", 1));
        assert!(!make().valid("test", "user:interop", 2));
        let mut pending = make();
        pending.identity_certificate = serde_json::json!({"format":"pending"});
        assert!(!pending.valid("test", "user:interop", 1));
        let mut replaced = make();
        replaced.encryption_key.fill(1);
        assert!(!replaced.valid("test", "user:interop", 1));
        let mut replaced = make();
        replaced.authority_key = Some(vec![1; 32]);
        assert!(!replaced.valid("test", "user:interop", 1));
    }
}

#[derive(Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct SetupInput {
    pub authority: AuthorityCertificate,
    pub owner: IdentityCertificate,
    pub authority_envelope: SealedBox,
    pub catalog: SealedBox,
    pub policy: SignedPolicy,
    pub proof: String,
}
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct Status {
    tenant: String,
    phase: String,
    generation: String,
    policy_version: String,
    catalog_version: String,
    account_enrolled: bool,
    account_certified: bool,
    access_ready: bool,
    profile: Option<SetupInput>,
}

#[derive(sqlx::FromRow)]
struct AccountCertification {
    identity_certificate: Value,
    encryption_key: Vec<u8>,
    signing_key: Vec<u8>,
    authority_key: Option<Vec<u8>>,
}
impl AccountCertification {
    fn valid(self, tenant: &str, subject: &str, generation: i64) -> bool {
        let Ok(certificate) =
            serde_json::from_value::<IdentityCertificate>(self.identity_certificate)
        else {
            return false;
        };
        certificate.tenant == tenant
            && certificate.user == subject
            && certificate.generation == generation.to_string()
            && sized::<32>(&certificate.encryption_key)
                .is_ok_and(|key| key.as_slice() == self.encryption_key)
            && sized::<32>(&certificate.signing_key)
                .is_ok_and(|key| key.as_slice() == self.signing_key)
            && self
                .authority_key
                .is_some_and(|key| certificate.verify(&key).is_ok())
    }
}

pub(super) fn register(
    builder: ProcedureRegistryBuilder,
    state: Arc<AppState>,
) -> ProcedureRegistryBuilder {
    let status = Arc::clone(&state);
    builder.query("zerotrust.status",move|ctx,_input:()|{
        let state=Arc::clone(&status);
        async move {
            let (auth,pool)=authenticated_pool(&state,&ctx).await?;
            let user: i64 = auth.user.id.parse().map_err(internal)?;
            let (phase,generation,policy,catalog,profile):(String,i64,i64,i64,Option<Value>)=sqlx::query_as("SELECT phase,generation,policy_version,catalog_version,protected_profile FROM __zerotrust_state WHERE singleton")
                .fetch_one(&pool).await.map_err(internal)?;
            let enrolled:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM __zerotrust_accounts WHERE user_id=$1)").bind(user).fetch_one(&pool).await.map_err(internal)?;
            let certificate:Option<AccountCertification>=sqlx::query_as("SELECT a.identity_certificate,a.encryption_key,a.signing_key,s.authority_key FROM __zerotrust_accounts a CROSS JOIN __zerotrust_state s WHERE a.user_id=$1 AND s.singleton").bind(user).fetch_optional(&pool).await.map_err(internal)?;
            let certified=certificate.is_some_and(|value|value.valid(&auth.tenant,&format!("user:{}",Id(user).encode()),generation));
            let waiting:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM __zerotrust_invitations WHERE user_id=$1 AND generation=$2 AND accepted_at IS NOT NULL AND completed_at IS NULL) AND NOT EXISTS(SELECT 1 FROM __zerotrust_invitations WHERE user_id=$1 AND generation=$2 AND completed_at IS NOT NULL)").bind(user).bind(generation).fetch_one(&pool).await.map_err(internal)?;
            Ok(Status{tenant:auth.tenant,phase,generation:generation.to_string(),policy_version:policy.to_string(),catalog_version:catalog.to_string(),account_enrolled:enrolled,account_certified:certified,access_ready:certified && !waiting,profile:profile.map(serde_json::from_value).transpose().map_err(internal)?})
        }
    }).mutation("zerotrust.setup",move|ctx,input:SetupInput|{
        let state=Arc::clone(&state);
        async move{setup(&state,&ctx,input).await}
    })
}
pub(super) fn register_contract(builder: ProcedureRegistryBuilder) -> ProcedureRegistryBuilder {
    builder
        .query_stub::<(), Status>("zerotrust.status")
        .mutation_stub::<SetupInput, Success>("zerotrust.setup")
}

pub(super) fn packet_hash(message: Vec<u8>, signature: &str) -> RpcResult<String> {
    sized::<64>(signature)?;
    Ok(encode(&Sha256::digest(frame(
        "sortsys/signed-packet/v1",
        &[&encode(&message), signature],
    ))))
}
impl SetupInput {
    pub fn frame(&self) -> RpcResult<Vec<u8>> {
        let hashes = [
            packet_hash(self.authority.frame()?, &self.authority.signature)?,
            packet_hash(self.owner.frame()?, &self.owner.signature)?,
            packet_hash(
                self.authority_envelope.frame()?,
                &self.authority_envelope.signature,
            )?,
            packet_hash(self.catalog.frame()?, &self.catalog.signature)?,
            packet_hash(self.policy.frame()?, &self.policy.signature)?,
        ];
        let mut fields = vec![self.authority.tenant.as_str(), self.owner.user.as_str()];
        fields.extend(hashes.iter().map(String::as_str));
        Ok(frame("sortsys/tenant-setup/v1", &fields))
    }
    fn validate(
        &self,
        tenant: &str,
        subject: &str,
        encryption_key: &[u8],
        signing_key: &[u8],
    ) -> RpcResult<()> {
        self.validate_for(tenant, subject, encryption_key, signing_key, 1, 1, &[])
    }

    #[allow(clippy::too_many_arguments)]
    pub fn validate_for(
        &self,
        tenant: &str,
        subject: &str,
        encryption_key: &[u8],
        signing_key: &[u8],
        generation: i64,
        policy_version: i64,
        scopes: &[(String, Facet)],
    ) -> RpcResult<()> {
        if self.authority.tenant != tenant
            || self.authority.generation != generation.to_string()
            || self.owner.tenant != tenant
            || self.owner.generation != generation.to_string()
            || self.owner.user != subject
            || sized::<32>(&self.owner.encryption_key)?.as_slice() != encryption_key
            || sized::<32>(&self.owner.signing_key)?.as_slice() != signing_key
            || self.policy.tenant != tenant
            || self.policy.version != policy_version.to_string()
        {
            return Err(invalid());
        }
        self.authority.verify()?;
        let authority = sized::<32>(&self.authority.authority_signing_key)?;
        self.owner.verify(&authority)?;
        self.policy.verify(&authority)?;
        let mut expected = vec![
            Facet::Scope,
            Facet::ContractQuantities,
            Facet::Measurement,
            Facet::OfferPrices,
            Facet::Calculation,
            Facet::Procurement,
            Facet::Billing,
            Facet::MasterData,
            Facet::Personnel,
            Facet::Attachment,
        ]
        .into_iter()
        .map(|facet| (format!("tenant:{tenant}"), facet))
        .collect::<Vec<_>>();
        for scope in scopes {
            if !expected.contains(scope) {
                expected.push(scope.clone());
            }
        }
        if self.policy.rules.len() != expected.len()
            || self.policy.rules.iter().any(|r| {
                r.subject != subject
                    || !expected.contains(&(r.scope.clone(), r.facet))
                    || r.effect != Effect::Allow
                    || r.actions.len() != 6
            })
            || expected
                .iter()
                .any(|(scope, facet)| !self.policy.allows(subject, scope, *facet, Action::Grant))
        {
            return Err(invalid());
        }
        let authority_subject = format!("authority:{generation}");
        let recovery_subject = format!("recovery:{generation}");
        for (envelope, purpose, object, recipient) in [
            (
                &self.authority_envelope,
                "authority-key",
                authority_subject.as_str(),
                subject,
            ),
            (
                &self.catalog,
                "recovery-catalog",
                "catalog",
                recovery_subject.as_str(),
            ),
        ] {
            if envelope.tenant != tenant
                || envelope.purpose != purpose
                || envelope.object != object
                || envelope.recipient != recipient
                || envelope.generation != generation.to_string()
                || envelope.author != authority_subject
            {
                return Err(invalid());
            }
            envelope.verify(&authority)?;
        }
        verify(signing_key, &self.proof, &self.frame()?)
    }
}

async fn setup(state: &AppState, ctx: &RequestContext, input: SetupInput) -> RpcResult<Success> {
    let (auth, pool) = authenticated_pool(state, ctx).await?;
    if !auth.is_admin() {
        return Err(forbidden());
    }
    let user_id = auth.user.id.parse::<i64>().map_err(internal)?;
    let subject = format!("user:{}", Id(user_id).encode());
    let profile = serde_json::to_value(&input).map_err(internal)?;
    let mut tx = pool.begin().await.map_err(internal)?;
    super::lock_cutover(&mut tx, true).await?;
    let (phase, previous): (String, Option<Value>) = sqlx::query_as(
        "SELECT phase,protected_profile FROM __zerotrust_state WHERE singleton FOR UPDATE",
    )
    .fetch_one(&mut *tx)
    .await
    .map_err(internal)?;
    let account: Option<(Vec<u8>, Vec<u8>)> = sqlx::query_as(
        "SELECT encryption_key,signing_key FROM __zerotrust_accounts WHERE user_id=$1",
    )
    .bind(user_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(internal)?;
    let (encryption_key, signing_key) =
        account.ok_or_else(|| conflict("OPAQUE enrollment is required before tenant setup"))?;
    input.validate(&auth.tenant, &subject, &encryption_key, &signing_key)?;
    if phase != "unenrolled" && !(phase == "enrolling" && previous.as_ref() == Some(&profile)) {
        return Err(conflict("Tenant keys have already been initialized"));
    }
    let session_id = auth.session.id.parse::<i64>().map_err(internal)?;
    let current:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM user_sessions s JOIN user_role_assignments r ON r.user_id=s.user_id WHERE s.id=$1 AND s.user_id=$2 AND s.expires_at>now() AND r.role_name=':admin')")
        .bind(session_id).bind(user_id).fetch_one(&mut *tx).await.map_err(internal)?;
    if !current {
        return Err(forbidden());
    }
    sqlx::query("UPDATE __zerotrust_state SET phase='enrolling',authority_key=$1,recovery_encryption_key=$2,recovery_signing_key=$3,protected_profile=$4,updated_at=now() WHERE singleton")
        .bind(sized::<32>(&input.authority.authority_signing_key)?.to_vec()).bind(sized::<32>(&input.authority.recovery_encryption_key)?.to_vec()).bind(sized::<32>(&input.authority.recovery_signing_key)?.to_vec()).bind(&profile)
        .execute(&mut *tx).await.map_err(internal)?;
    sqlx::query("INSERT INTO __zerotrust_policies(version,generation,policy,signature) VALUES(1,1,$1,$2) ON CONFLICT(version) DO NOTHING")
        .bind(serde_json::to_value(&input.policy).map_err(internal)?).bind(sized::<64>(&input.policy.signature)?.to_vec()).execute(&mut *tx).await.map_err(internal)?;
    sqlx::query("UPDATE __zerotrust_accounts SET identity_certificate=$1 WHERE user_id=$2")
        .bind(serde_json::to_value(&input.owner).map_err(internal)?)
        .bind(user_id)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    sqlx::query("INSERT INTO __zerotrust_authorities(generation,certificate) VALUES(1,$1) ON CONFLICT(generation) DO NOTHING")
        .bind(serde_json::to_value(&input.authority).map_err(internal)?)
        .execute(&mut *tx).await.map_err(internal)?;
    sqlx::query("INSERT INTO __zerotrust_identity_history(subject,generation,signing_key,certificate) VALUES($1,1,$2,$3) ON CONFLICT DO NOTHING")
        .bind(&subject).bind(&signing_key).bind(serde_json::to_value(&input.owner).map_err(internal)?)
        .execute(&mut *tx).await.map_err(internal)?;
    tx.commit().await.map_err(internal)?;
    sync_initial_head(state.tenants.master(), &input).await?;
    Ok(Success { success: true })
}
async fn sync_initial_head(master: &PgPool, input: &SetupInput) -> RpcResult<()> {
    sqlx::query("INSERT INTO __zerotrust_recovery_heads(tenant,generation,catalog_version,recovery_encryption_key,recovery_signing_key,authority_key,certificate,phase,catalog) VALUES($1,1,1,$2,$3,$4,$5,'enrolling',$6) ON CONFLICT(tenant) DO NOTHING")
        .bind(&input.authority.tenant).bind(sized::<32>(&input.authority.recovery_encryption_key)?.to_vec()).bind(sized::<32>(&input.authority.recovery_signing_key)?.to_vec()).bind(sized::<32>(&input.authority.authority_signing_key)?.to_vec()).bind(serde_json::to_value(&input.authority).map_err(internal)?).bind(serde_json::to_value(&input.catalog).map_err(internal)?)
        .execute(master).await.map_err(internal)?;
    let (generation,encryption,signing,authority):(i64,Vec<u8>,Vec<u8>,Vec<u8>)=sqlx::query_as("SELECT generation,recovery_encryption_key,recovery_signing_key,authority_key FROM __zerotrust_recovery_heads WHERE tenant=$1")
        .bind(&input.authority.tenant).fetch_one(master).await.map_err(internal)?;
    if generation != 1
        || encryption != sized::<32>(&input.authority.recovery_encryption_key)?
        || signing != sized::<32>(&input.authority.recovery_signing_key)?
        || authority != sized::<32>(&input.authority.authority_signing_key)?
    {
        return Err(conflict("Recovery keys have already changed"));
    }
    Ok(())
}
