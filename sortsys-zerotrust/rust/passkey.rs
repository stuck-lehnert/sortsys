//! Public, account-signed binding for a browser's WebAuthn PRF key wrapper.
//! The PRF result and unwrapped account key never enter this protocol.
use crate::Result;
use crate::crypto::{AccountVault, decode, frame, identifier, invalid, sized, verify};
use serde::{Deserialize, Serialize};
#[cfg(feature = "typescript")]
use ts_rs::TS;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[cfg_attr(feature = "typescript", derive(TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PasskeyVault {
    pub format: String,
    pub tenant: String,
    pub username: String,
    pub rp_id: String,
    pub credential_id: String,
    pub encryption_key: String,
    pub signing_key: String,
    pub wrapped_key: String,
    pub signature: String,
}

impl PasskeyVault {
    pub fn frame(&self) -> Result<Vec<u8>> {
        if self.format != "sortsys-passkey-vault-v1"
            || self.rp_id.is_empty()
            || self.rp_id.len() > 253
            || !self
                .rp_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b".-_:[]".contains(&byte))
        {
            return Err(invalid());
        }
        identifier(&self.tenant)?;
        identifier(&self.username)?;
        if decode(&self.credential_id, 1024)?.is_empty() {
            return Err(invalid());
        }
        sized::<32>(&self.encryption_key)?;
        sized::<32>(&self.signing_key)?;
        sized::<40>(&self.wrapped_key)?;
        sized::<64>(&self.signature)?;
        Ok(frame(
            "sortsys/passkey-vault/v1",
            &[
                &self.format,
                &self.tenant,
                &self.username,
                &self.rp_id,
                &self.credential_id,
                &self.encryption_key,
                &self.signing_key,
                &self.wrapped_key,
            ],
        ))
    }

    /// RP and credential ID must come from the verified WebAuthn ceremony,
    /// account public keys from the authenticated account's persisted vault.
    pub fn verify_binding(
        &self,
        account: &AccountVault,
        rp_id: &str,
        credential_id: &str,
    ) -> Result<()> {
        account.validate()?;
        if self.tenant != account.tenant
            || self.username != account.username
            || self.encryption_key != account.encryption_key
            || self.signing_key != account.signing_key
            || self.rp_id != rp_id
            || self.credential_id != credential_id
        {
            return Err(invalid());
        }
        verify(
            &sized::<32>(&account.signing_key)?,
            &self.signature,
            &self.frame()?,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Deserialize)]
    struct Vector {
        account: AccountVault,
        packet: PasskeyVault,
    }

    fn vector() -> Vector {
        serde_json::from_str(include_str!("../test/fixtures/passkey-vault.json")).unwrap()
    }

    #[test]
    fn browser_wrapper_requires_the_persisted_account_and_verified_ceremony() {
        let input = vector();
        input
            .packet
            .verify_binding(&input.account, "example.test", &input.packet.credential_id)
            .unwrap();
        assert!(
            input
                .packet
                .verify_binding(&input.account, "other.test", &input.packet.credential_id)
                .is_err()
        );
        assert!(
            input
                .packet
                .verify_binding(&input.account, "example.test", "other")
                .is_err()
        );
        let mut account = input.account.clone();
        account.username = "another-user".into();
        assert!(
            input
                .packet
                .verify_binding(&account, "example.test", &input.packet.credential_id)
                .is_err()
        );
        let mut packet = input.packet.clone();
        packet.wrapped_key = crate::crypto::encode(&[0; 40]);
        assert!(
            packet
                .verify_binding(&input.account, "example.test", &packet.credential_id)
                .is_err()
        );
    }

    #[test]
    fn authenticator_secrets_are_never_an_accepted_server_field() {
        let mut input: serde_json::Value =
            serde_json::from_str(include_str!("../test/fixtures/passkey-vault.json")).unwrap();
        input["packet"]["prfOutput"] = serde_json::json!("must never be uploaded");
        assert!(serde_json::from_value::<PasskeyVault>(input["packet"].clone()).is_err());
    }
}
