use crate::Result;
use crate::crypto::{decode, frame, identifier, invalid, revision, sized, verify};
use serde::{Deserialize, Serialize};
#[cfg(feature = "typescript")]
use ts_rs::TS;

#[derive(Clone, Deserialize, Serialize)]
#[cfg_attr(feature = "typescript", derive(TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthorityCertificate {
    pub tenant: String,
    pub generation: String,
    pub recovery_encryption_key: String,
    pub recovery_signing_key: String,
    pub authority_signing_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript", ts(optional))]
    pub context: Option<String>,
    pub signature: String,
}
impl AuthorityCertificate {
    pub fn frame(&self) -> Result<Vec<u8>> {
        identifier(&self.tenant)?;
        revision(&self.generation)?;
        sized::<32>(&self.recovery_encryption_key)?;
        sized::<32>(&self.recovery_signing_key)?;
        sized::<32>(&self.authority_signing_key)?;
        let mut fields: Vec<&str> = vec![
            &self.tenant,
            &self.generation,
            &self.recovery_encryption_key,
            &self.recovery_signing_key,
            &self.authority_signing_key,
        ];
        if let Some(context) = &self.context {
            identifier(context)?;
            fields.push(context);
            return Ok(frame("sortsys/authority/v2", &fields));
        }
        Ok(frame("sortsys/authority/v1", &fields))
    }
    pub fn verify(&self) -> Result<()> {
        verify(
            &sized::<32>(&self.recovery_signing_key)?,
            &self.signature,
            &self.frame()?,
        )
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[cfg_attr(feature = "typescript", derive(TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IdentityCertificate {
    pub tenant: String,
    pub generation: String,
    pub user: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript", ts(optional))]
    pub previous_signature: Option<String>,
    pub encryption_key: String,
    pub signing_key: String,
    pub signature: String,
}
impl IdentityCertificate {
    pub fn frame(&self) -> Result<Vec<u8>> {
        identifier(&self.tenant)?;
        identifier(&self.user)?;
        revision(&self.generation)?;
        sized::<32>(&self.encryption_key)?;
        sized::<32>(&self.signing_key)?;
        let mut fields = vec![
            self.tenant.as_str(),
            self.generation.as_str(),
            self.user.as_str(),
            self.encryption_key.as_str(),
            self.signing_key.as_str(),
        ];
        if let Some(previous) = &self.previous_signature {
            sized::<64>(previous)?;
            fields.push(previous);
            return Ok(frame("sortsys/identity-certificate/v2", &fields));
        }
        Ok(frame("sortsys/identity-certificate/v1", &fields))
    }

    pub fn succeeds(&self, previous: &Self) -> Result<()> {
        self.frame()?;
        previous.frame()?;
        sized::<64>(&previous.signature)?;
        if self.tenant != previous.tenant
            || self.generation != previous.generation
            || self.user != previous.user
            || self.previous_signature.as_deref() != Some(&previous.signature)
        {
            return Err(invalid());
        }
        Ok(())
    }
    pub fn verify(&self, key: &[u8]) -> Result<()> {
        verify(key, &self.signature, &self.frame()?)
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[cfg_attr(feature = "typescript", derive(TS))]
#[serde(deny_unknown_fields)]
pub struct SealedBox {
    pub tenant: String,
    pub purpose: String,
    pub object: String,
    pub generation: String,
    pub recipient: String,
    pub author: String,
    pub format: String,
    pub enc: String,
    pub ciphertext: String,
    pub signature: String,
}
impl SealedBox {
    pub fn frame(&self) -> Result<Vec<u8>> {
        identifier(&self.tenant)?;
        identifier(&self.object)?;
        identifier(&self.recipient)?;
        identifier(&self.author)?;
        revision(&self.generation)?;
        if self.format != "sortsys-hpke-v1"
            || ![
                "area-key",
                "object-key",
                "authority-key",
                "recovery-catalog",
                "validation-request",
                "validation-result",
                "search-request",
                "search-result",
                "live-llm-context",
                "resource-command-key",
                "project-planning-title",
            ]
            .contains(&self.purpose.as_str())
        {
            return Err(invalid());
        }
        sized::<32>(&self.enc)?;
        if decode(&self.ciphertext, 32 * 1024 * 1024 + 16)?.len() < 16 {
            return Err(invalid());
        }
        Ok(frame(
            "sortsys/hpke/v1",
            &[
                &self.tenant,
                &self.purpose,
                &self.object,
                &self.generation,
                &self.recipient,
                &self.author,
                &self.format,
                &self.enc,
                &self.ciphertext,
            ],
        ))
    }
    pub fn verify(&self, key: &[u8]) -> Result<()> {
        verify(key, &self.signature, &self.frame()?)
    }
}
#[derive(Clone, Deserialize, Serialize)]
#[cfg_attr(feature = "typescript", derive(TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EncryptedObject<F = String> {
    pub tenant: String,
    pub scope: String,
    pub facet: F,
    pub object: String,
    pub revision: String,
    pub generation: String,
    pub policy_version: String,
    pub author: String,
    pub format: String,
    pub nonce: String,
    pub ciphertext: String,
    pub wrapped_key: String,
    pub signature: String,
}
impl<F: AsRef<str>> EncryptedObject<F> {
    pub fn is_tombstone(&self) -> bool {
        self.format == "sortsys-object-tombstone-v1"
    }
    pub fn frame(&self) -> Result<Vec<u8>> {
        identifier(self.facet.as_ref())?;
        for value in [&self.tenant, &self.scope, &self.object, &self.author] {
            identifier(value)?;
        }
        for value in [&self.revision, &self.generation, &self.policy_version] {
            revision(value)?;
        }
        if self.format != "sortsys-object-v1" && !self.is_tombstone() {
            return Err(invalid());
        }
        sized::<12>(&self.nonce)?;
        sized::<40>(&self.wrapped_key)?;
        let length = decode(&self.ciphertext, 16 * 1024 * 1024 + 16)?.len();
        if length < 16 || self.is_tombstone() && (length != 16 || self.revision == "1") {
            return Err(invalid());
        }
        Ok(frame(
            "sortsys/object/v1",
            &[
                &self.tenant,
                &self.scope,
                self.facet.as_ref(),
                &self.object,
                &self.revision,
                &self.generation,
                &self.policy_version,
                &self.author,
                &self.format,
                &self.nonce,
                &self.ciphertext,
                &self.wrapped_key,
            ],
        ))
    }
    pub fn verify(&self, key: &[u8]) -> Result<()> {
        verify(key, &self.signature, &self.frame()?)
    }
}

#[cfg(test)]
mod identity_succession_tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn browser_certificate_successors_bind_exact_scope_and_preserve_old_signatures() {
        let vector: Value =
            serde_json::from_str(include_str!("../test/fixtures/identity-succession.json"))
                .unwrap();
        let authority: AuthorityCertificate =
            serde_json::from_value(vector["authority"].clone()).unwrap();
        authority.verify().unwrap();
        let root = sized::<32>(&authority.authority_signing_key).unwrap();
        let initial: IdentityCertificate =
            serde_json::from_value(vector["initial"].clone()).unwrap();
        let next: IdentityCertificate = serde_json::from_value(vector["next"].clone()).unwrap();
        let latest: IdentityCertificate = serde_json::from_value(vector["latest"].clone()).unwrap();
        for certificate in [&initial, &next, &latest] {
            certificate.verify(&root).unwrap();
        }
        next.succeeds(&initial).unwrap();
        latest.succeeds(&next).unwrap();
        assert!(latest.succeeds(&initial).is_err());
        for field in ["tenant", "generation", "user", "previousSignature"] {
            let mut changed = vector["next"].clone();
            changed[field] = match field {
                "tenant" => Value::from("different"),
                "generation" => Value::from("2"),
                "user" => Value::from("account:someone-else"),
                _ => Value::from(latest.signature.clone()),
            };
            let changed: IdentityCertificate = serde_json::from_value(changed).unwrap();
            assert!(changed.succeeds(&initial).is_err());
            assert!(changed.verify(&root).is_err());
        }
        let old: EncryptedObject = serde_json::from_value(vector["oldObject"].clone()).unwrap();
        let new: EncryptedObject = serde_json::from_value(vector["newObject"].clone()).unwrap();
        old.verify(&sized::<32>(&initial.signing_key).unwrap())
            .unwrap();
        new.verify(&sized::<32>(&latest.signing_key).unwrap())
            .unwrap();
        assert!(
            old.verify(&sized::<32>(&latest.signing_key).unwrap())
                .is_err()
        );
        assert!(
            new.verify(&sized::<32>(&initial.signing_key).unwrap())
                .is_err()
        );
    }
}
