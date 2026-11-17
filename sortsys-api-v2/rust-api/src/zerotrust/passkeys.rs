//! Native WebAuthn authentication. Only public credential material and signed
//! account-key wrappers enter the API; PRF outputs remain in the browser.
use super::setup;
use crate::{
    api::Success,
    auth::AuthService,
    auth_limits,
    contracts::passkeys::*,
    control::{Transaction, accounts, key, tenants},
    error::{ErrorCode, RpcError, RpcResult, internal},
    ids::Id,
    rpc::{ProcedureRegistryBuilder, RequestContext},
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sortsys_zerotrust::{
    crypto::{encode, frame, signed_packet_frame, sized, verify},
    passkey::PasskeyVault,
    webauthn::{self, AuthenticatorState, Origin, RegistrationBinding, RegistrationCredential},
};
use std::sync::Arc;

mod login;
mod registration;

const MAX_PASSKEYS: usize = 32;
const CHALLENGE_SECONDS: i64 = 300;

#[derive(Clone, Default)]
pub struct Config {
    origin: Option<Origin>,
}
#[derive(Debug, thiserror::Error)]
#[error("SORTSYS_PUBLIC_ORIGIN must be an HTTPS origin; HTTP is permitted only on loopback")]
pub struct ConfigError;
impl Config {
    pub fn parse(value: Option<String>) -> Result<Self, ConfigError> {
        Ok(Self {
            origin: value
                .filter(|value| !value.is_empty())
                .map(|value| Origin::parse(&value).map_err(|_| ConfigError))
                .transpose()?,
        })
    }
    pub fn from_env() -> Result<Self, ConfigError> {
        Self::parse(crate::config::optional("SORTSYS_PUBLIC_ORIGIN"))
    }
    fn origin(&self) -> RpcResult<&Origin> {
        self.origin.as_ref().ok_or_else(|| {
            RpcError::new(
                ErrorCode::InternalServerError,
                "Passkeys are not configured",
            )
            .with_http_code(503)
        })
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RegistrationContext {
    tenant: String,
    user_id: i64,
    session_id: i64,
    credential_revision: u64,
    account_epoch: u64,
    tenant_epoch: u64,
    authority_generation: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LoginHint {
    tenant: String,
    username: String,
}
#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum Purpose {
    Register,
    Login,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Challenge {
    purpose: Purpose,
    challenge: String,
    origin: String,
    rp_id: String,
    registration: Option<RegistrationContext>,
    hint: Option<LoginHint>,
    iat: i64,
    exp: i64,
}
impl Challenge {
    fn new(purpose: Purpose, origin: &Origin) -> RpcResult<Self> {
        let now = Utc::now().timestamp();
        Ok(Self {
            purpose,
            challenge: webauthn::create_challenge()?,
            origin: origin.value.clone(),
            rp_id: origin.rp_id.clone(),
            registration: None,
            hint: None,
            iat: now,
            exp: now + CHALLENGE_SECONDS,
        })
    }
    fn expires_at(&self) -> RpcResult<DateTime<Utc>> {
        DateTime::from_timestamp(self.exp, 0).ok_or_else(denied)
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredPasskey {
    id: i64,
    tenant: String,
    user_id: i64,
    generation: String,
    user_handle: String,
    label: String,
    origin: String,
    rp_id: String,
    registration: RegistrationCredential,
    registration_challenge: String,
    exchange_hash: String,
    identity_proof: String,
    key_vault: Option<PasskeyVault>,
    counter: u32,
    backup_eligible: bool,
    backed_up: bool,
    created_at: DateTime<Utc>,
    last_used_at: Option<DateTime<Utc>>,
    deleted_at: Option<DateTime<Utc>>,
}
impl StoredPasskey {
    fn state(&self) -> AuthenticatorState {
        AuthenticatorState {
            counter: self.counter,
            backup_eligible: self.backup_eligible,
            backed_up: self.backed_up,
        }
    }
    fn set_state(&mut self, state: AuthenticatorState) {
        self.counter = state.counter;
        self.backup_eligible = state.backup_eligible;
        self.backed_up = state.backed_up;
    }
    fn verify_identity(&self, account: &accounts::Account) -> RpcResult<()> {
        if self.id <= 0
            || self.user_id != account.id
            || self.user_handle != user_handle(&self.tenant, account.id)?
        {
            return Err(denied());
        }
        let vault = &account.credential()?.vault;
        if vault.tenant != self.tenant || vault.subject != accounts::subject(account.id) {
            return Err(denied());
        }
        let credential_hash = hash(&webauthn::registration_frame(&self.registration)?);
        let key_hash = key_vault_hash(self.key_vault.as_ref())?;
        verify(
            &sized::<32>(&vault.signing_key)?,
            &self.identity_proof,
            &RegistrationBinding {
                tenant: &self.tenant,
                subject: &vault.subject,
                user_handle: &self.user_handle,
                exchange_hash: &self.exchange_hash,
                credential_hash: &credential_hash,
                key_vault_hash: &key_hash,
                label: &self.label,
            }
            .frame()?,
        )?;
        if let Some(wrapper) = &self.key_vault {
            wrapper.verify_binding(vault, &self.rp_id, &self.registration.raw_id)?;
        }
        Ok(())
    }
}

fn denied() -> RpcError {
    RpcError::new(ErrorCode::Unauthorized, "Passkey verification failed").with_http_code(401)
}
fn hash(bytes: &[u8]) -> String {
    encode(&Sha256::digest(bytes))
}
fn key_vault_hash(vault: Option<&PasskeyVault>) -> RpcResult<String> {
    match vault {
        Some(vault) => Ok(hash(&signed_packet_frame(
            &vault.frame()?,
            &vault.signature,
        )?)),
        None => Ok(String::new()),
    }
}
fn user_handle(tenant: &str, user: i64) -> RpcResult<String> {
    if user <= 0 {
        return Err(denied());
    }
    Ok(webauthn::routing_user_handle(tenant, &user.to_be_bytes())?)
}
fn passkey_key(id: i64) -> sortsys_zerotrust::metadata::RecordKey {
    key("passkeys", &Id(id).encode())
}
fn directory_key(user: i64) -> sortsys_zerotrust::metadata::RecordKey {
    key("passkey-users", &Id(user).encode())
}
fn index_key(rp_id: &str, credential: &str) -> sortsys_zerotrust::metadata::RecordKey {
    key(
        "passkey-index",
        &format!(
            "c_{}",
            hash(&frame("sortsys/passkey-index/v1", &[rp_id, credential]))
        ),
    )
}

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Ownership {
    tenant: String,
    user_id: i64,
    rp_id: String,
    credential_id: String,
}
fn ownership_key(rp_id: &str, credential_id: &str) -> sortsys_zerotrust::metadata::RecordKey {
    key(
        "passkey-owners",
        &format!(
            "c_{}",
            hash(&frame("sortsys/passkey-owner/v1", &[rp_id, credential_id]))
        ),
    )
}
async fn reserve_owner(service: &AuthService, record: &StoredPasskey) -> RpcResult<()> {
    let expected = Ownership {
        tenant: record.tenant.clone(),
        user_id: record.user_id,
        rp_id: record.rp_id.clone(),
        credential_id: record.registration.raw_id.clone(),
    };
    let key = ownership_key(&expected.rp_id, &expected.credential_id);
    let mut transaction = service.records()?.transaction()?;
    if let Some(previous) = transaction.read::<Ownership>(key.clone()).await? {
        if previous != expected {
            return Err(crate::control::conflict());
        }
        transaction.validate().await?;
    } else {
        // System metadata is the independent witness store itself. The
        // ownership reservation is create-once through this CAS operation; it
        // cannot be checkpointed into the same physical file.
        transaction.put(key, &expected).await?;
        transaction.commit().await?;
    }
    Ok(())
}
fn origin<'a>(service: &'a AuthService, request: &RequestContext) -> RpcResult<&'a Origin> {
    let origin = service.passkeys.origin()?;
    if request
        .headers
        .get("origin")
        .and_then(|value| value.to_str().ok())
        != Some(origin.value.as_str())
    {
        return Err(denied());
    }
    Ok(origin)
}
fn challenge(
    service: &AuthService,
    request: &RequestContext,
    token: &str,
    purpose: Purpose,
) -> RpcResult<Challenge> {
    if token.len() > 8192 {
        return Err(denied());
    }
    let claims: Challenge = service.verify_challenge_token(token)?;
    let expected = origin(service, request)?;
    let now = Utc::now().timestamp();
    sized::<32>(&claims.challenge)?;
    if claims.purpose != purpose
        || claims.origin != expected.value
        || claims.rp_id != expected.rp_id
        || claims.exp <= now
        || claims.iat > now + 30
        || claims.exp.checked_sub(claims.iat) != Some(CHALLENGE_SECONDS)
        || (purpose == Purpose::Register) != claims.registration.is_some()
        || purpose == Purpose::Register && claims.hint.is_some()
    {
        return Err(denied());
    }
    Ok(claims)
}

async fn consume(transaction: &mut Transaction, claims: &Challenge) -> RpcResult<()> {
    if claims.exp <= Utc::now().timestamp() {
        return Err(denied());
    }
    let used = key("passkey-uses", &format!("c_{}", claims.challenge));
    if transaction.read::<bool>(used.clone()).await?.is_some() {
        return Err(denied());
    }
    transaction
        .put_expiring(used, &true, claims.expires_at()?)
        .await
}
async fn directory(transaction: &mut Transaction, user: i64) -> RpcResult<Vec<StoredPasskey>> {
    let ids: Vec<i64> = transaction
        .read(directory_key(user))
        .await?
        .unwrap_or_default();
    if ids.len() > MAX_PASSKEYS
        || ids.iter().any(|id| *id <= 0)
        || ids.iter().collect::<std::collections::BTreeSet<_>>().len() != ids.len()
    {
        return Err(crate::control::unavailable());
    }
    let records = transaction
        .many::<StoredPasskey>(ids.iter().map(|id| passkey_key(*id)).collect())
        .await?;
    ids.iter()
        .zip(records)
        .map(|(id, record)| {
            let record = record.ok_or_else(crate::control::unavailable)?;
            if record.id != *id || record.user_id != user {
                return Err(crate::control::unavailable());
            }
            Ok(record)
        })
        .collect()
}
fn security_event(transaction: &mut Transaction, subject: &str) -> RpcResult<()> {
    transaction.notify("account", &serde_json::json!({"subject": subject}))
}

/// Retire device credentials in the same transaction as a signing-key change.
pub(in crate::zerotrust) async fn retire_account_credentials(
    transaction: &mut Transaction,
    user: i64,
) -> RpcResult<()> {
    let records = directory(transaction, user).await?;
    if records.is_empty() {
        return Ok(());
    }
    let mut keys = records
        .iter()
        .map(|record| passkey_key(record.id))
        .collect::<Vec<_>>();
    keys.push(directory_key(user));
    transaction.prefetch_protected(keys).await?;
    let now = Utc::now();
    for mut record in records {
        if record.deleted_at.is_none() {
            record.deleted_at = Some(now);
            transaction
                .put_protected(passkey_key(record.id), &record)
                .await?;
        }
    }
    transaction
        .put_protected(directory_key(user), &Vec::<i64>::new())
        .await
}

pub(crate) fn register(
    builder: ProcedureRegistryBuilder,
    service: Arc<AuthService>,
) -> ProcedureRegistryBuilder {
    let listing = Arc::clone(&service);
    let starting = Arc::clone(&service);
    let registering = Arc::clone(&service);
    let removing = Arc::clone(&service);
    let options = Arc::clone(&service);
    builder
        .query("auth.passkeys.list", move |request, _: ()| {
            let service = Arc::clone(&listing);
            async move { registration::list(&service, &request).await }
        })
        .mutation("auth.passkeys.registerOptions", move |request, _: ()| {
            let service = Arc::clone(&starting);
            async move { registration::options(&service, &request).await }
        })
        .mutation(
            "auth.passkeys.register",
            move |request, input: PasskeyRegistrationInput| {
                let service = Arc::clone(&registering);
                async move { registration::finish(&service, &request, input).await }
            },
        )
        .mutation(
            "auth.passkeys.delete",
            move |request, input: DeleteInput| {
                let service = Arc::clone(&removing);
                async move { registration::delete(&service, &request, input).await }
            },
        )
        .mutation(
            "auth.passkeys.loginOptions",
            move |request, input: Option<LoginOptionsInput>| {
                let service = Arc::clone(&options);
                async move { login::options(&service, &request, input).await }
            },
        )
        .mutation("auth.passkeys.login", move |request, input: LoginInput| {
            let service = Arc::clone(&service);
            async move { login::finish(&service, &request, input).await }
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn configured() -> AuthService {
        AuthService::from_credentials(
            Arc::from(b"synthetic-passkey-token-secret-261117".as_slice()),
            "unused".into(),
            None,
        )
        .with_passkeys(Config::parse(Some("https://app.example.test".into())).unwrap())
    }
    fn request(origin: &str) -> RequestContext {
        let mut headers = axum::http::HeaderMap::new();
        headers.insert("origin", origin.parse().unwrap());
        RequestContext { headers }
    }
    #[test]
    fn origins_are_configured_and_never_derived_from_a_supplied_header() {
        let service = configured();
        assert!(origin(&service, &request("https://app.example.test")).is_ok());
        assert!(origin(&service, &request("https://evil.example.test")).is_err());
        assert!(
            origin(
                &service,
                &RequestContext {
                    headers: Default::default()
                }
            )
            .is_err()
        );
        assert!(Config::parse(Some("https://app.example.test/path".into())).is_err());
        assert!(Config::default().origin().is_err());
    }
    #[test]
    fn validly_signed_tokens_still_require_the_right_ceremony_origin_and_strict_lifetime() {
        let service = configured();
        let request = request("https://app.example.test");
        let claims = Challenge::new(Purpose::Login, service.passkeys.origin().unwrap()).unwrap();
        assert!(
            challenge(
                &service,
                &request,
                &service.issue_challenge_token(&claims).unwrap(),
                Purpose::Login
            )
            .is_ok()
        );
        assert!(
            challenge(
                &service,
                &request,
                &service.issue_challenge_token(&claims).unwrap(),
                Purpose::Register
            )
            .is_err()
        );
        for mode in [
            "expired",
            "future",
            "origin",
            "overflow",
            "registration-context",
        ] {
            let mut changed = claims.clone();
            match mode {
                "expired" => {
                    changed.exp = Utc::now().timestamp() - 1;
                    changed.iat = changed.exp - CHALLENGE_SECONDS;
                }
                "future" => {
                    changed.iat += 90;
                    changed.exp += 90;
                }
                "origin" => changed.origin = "https://evil.example.test".into(),
                "overflow" => {
                    changed.iat = i64::MIN;
                    changed.exp = i64::MAX;
                }
                "registration-context" => changed.purpose = Purpose::Register,
                _ => unreachable!(),
            }
            assert!(
                challenge(
                    &service,
                    &request,
                    &service.issue_challenge_token(&changed).unwrap(),
                    changed.purpose
                )
                .is_err(),
                "{mode}"
            );
        }
    }
}
