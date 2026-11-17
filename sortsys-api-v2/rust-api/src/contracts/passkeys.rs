//! Wire contract for native passkey authentication and account-owned key wrappers.
use crate::{api::Success, ids::Id, rpc::ProcedureRegistryBuilder};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sortsys_zerotrust::{
    AccountVault,
    passkey::PasskeyVault,
    webauthn::{AuthenticationCredential, CredentialDescriptor, RegistrationCredential},
};
use ts_rs::TS;
pub fn register_contract(builder: ProcedureRegistryBuilder) -> ProcedureRegistryBuilder {
    builder
        .query_stub::<(), Vec<PasskeyListItem>>("auth.passkeys.list")
        .mutation_stub::<(), RegistrationOptionsOutput>("auth.passkeys.registerOptions")
        .mutation_stub::<PasskeyRegistrationInput, Success>("auth.passkeys.register")
        .mutation_stub::<DeleteInput, Success>("auth.passkeys.delete")
        .mutation_stub::<Option<LoginOptionsInput>, LoginOptionsOutput>(
            "auth.passkeys.loginOptions",
        )
        .mutation_stub::<LoginInput, PasskeyLoginOutput>("auth.passkeys.login")
}
#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PasskeyRegistrationInput {
    pub identity_proof: String,
    pub challenge_token: String,
    pub label: String,
    pub credential: RegistrationCredential,
    #[serde(default)]
    #[ts(optional)]
    pub key_vault: Option<PasskeyVault>,
}
#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeleteInput {
    pub identity_proof: String,
    pub id: Id,
}
#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LoginOptionsInput {
    pub tenant: String,
    pub username: String,
}
#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LoginInput {
    pub challenge_token: String,
    pub credential: AuthenticationCredential,
}
#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PasskeyListItem {
    pub credential_id: String,
    pub identity_proof: String,
    pub id: Id,
    pub label: String,
    #[ts(type = "Date")]
    pub created_at: DateTime<Utc>,
    #[ts(type = "Date | null")]
    pub last_used_at: Option<DateTime<Utc>>,
    pub opens_data: bool,
}
#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RegistrationOptionsOutput {
    pub challenge_token: String,
    pub options: CreationOptions,
}
#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CreationOptions {
    pub challenge: String,
    pub rp: RelyingParty,
    pub user: PasskeyUser,
    pub pub_key_cred_params: Vec<CredentialParameter>,
    pub timeout: u32,
    #[ts(type = "\"none\"")]
    pub attestation: String,
    pub authenticator_selection: AuthenticatorSelection,
    pub exclude_credentials: Vec<CredentialDescriptor>,
}
#[derive(Debug, Serialize, TS)]
pub struct RelyingParty {
    pub name: String,
    pub id: String,
}
#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PasskeyUser {
    pub id: String,
    pub name: String,
    pub display_name: String,
}
#[derive(Debug, Serialize, TS)]
pub struct CredentialParameter {
    #[ts(type = "\"public-key\"")]
    pub r#type: String,
    pub alg: i32,
}
#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AuthenticatorSelection {
    #[ts(type = "\"required\"")]
    pub resident_key: String,
    #[ts(type = "true")]
    pub require_resident_key: bool,
    #[ts(type = "\"required\"")]
    pub user_verification: String,
}
#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LoginOptionsOutput {
    pub challenge_token: String,
    pub options: RequestOptions,
}
#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RequestOptions {
    pub challenge: String,
    pub rp_id: String,
    pub allow_credentials: Vec<CredentialDescriptor>,
    pub timeout: u32,
    #[ts(type = "\"required\"")]
    pub user_verification: String,
}
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PasskeyLoginOutput {
    pub subject: String,
    pub token: String,
    pub tenant: String,
    pub username: String,
    pub account_vault: Option<AccountVault>,
    pub key_vault: Option<PasskeyVault>,
}
