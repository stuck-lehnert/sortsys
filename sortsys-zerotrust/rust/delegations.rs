//! Authority-certified resource creation without handing out the authority key.
//! Applications still define namespaces and validate current permission,
//! revocation and resource bindings in the same transaction as publication.
use crate::{
    Result,
    crypto::{frame, identifier, invalid, packet_hash, revision, verify},
    protocol::IdentityCertificate,
};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
#[cfg(feature = "typescript")]
use ts_rs::TS;

#[derive(Clone, Deserialize, Serialize)]
#[cfg_attr(feature = "typescript", derive(TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DelegationCertificate<N = String> {
    pub tenant: String,
    pub id: String,
    pub generation: String,
    pub namespace: N,
    pub creator: IdentityCertificate,
    pub readers: Vec<IdentityCertificate>,
    pub signature: String,
}

#[derive(Clone, Copy)]
pub struct DelegationContext<'a> {
    pub tenant: &'a str,
    pub generation: &'a str,
    pub namespace: &'a str,
    pub creator: &'a str,
}

/// Borrow application-owned packets without cloning their certificates.
pub struct DelegationRef<'a> {
    pub tenant: &'a str,
    pub id: &'a str,
    pub generation: &'a str,
    pub namespace: &'a str,
    pub creator: &'a IdentityCertificate,
    pub readers: &'a [IdentityCertificate],
    pub signature: &'a str,
}

impl<N: AsRef<str>> DelegationCertificate<N> {
    pub fn as_protocol(&self) -> DelegationRef<'_> {
        DelegationRef {
            tenant: &self.tenant,
            id: &self.id,
            generation: &self.generation,
            namespace: self.namespace.as_ref(),
            creator: &self.creator,
            readers: &self.readers,
            signature: &self.signature,
        }
    }

    pub fn frame(&self) -> Result<Vec<u8>> {
        self.as_protocol().frame()
    }

    pub fn verify(&self, expected: &DelegationContext<'_>, authority: &[u8]) -> Result<()> {
        self.as_protocol().verify(expected, authority)
    }
}

impl DelegationRef<'_> {
    pub fn frame(&self) -> Result<Vec<u8>> {
        identifier(self.tenant)?;
        identifier(self.id)?;
        identifier(self.namespace)?;
        revision(self.generation)?;
        if self.readers.is_empty() || self.readers.len() > 8 {
            return Err(invalid());
        }
        let mut subjects = HashSet::new();
        for reader in self.readers {
            if !subjects.insert(&reader.user) {
                return Err(invalid());
            }
        }
        let mut hashes = Vec::new();
        for member in std::iter::once(self.creator).chain(self.readers) {
            if member.tenant != self.tenant || member.generation != self.generation {
                return Err(invalid());
            }
            hashes.push(packet_hash(&member.frame()?, &member.signature)?);
        }
        let mut fields = vec![self.tenant, self.id, self.generation, self.namespace];
        fields.extend(hashes.iter().map(String::as_str));
        Ok(frame("sortsys/creation-capability/v1", &fields))
    }

    pub fn verify(&self, expected: &DelegationContext<'_>, authority: &[u8]) -> Result<()> {
        if self.tenant != expected.tenant
            || self.generation != expected.generation
            || self.namespace != expected.namespace
            || self.creator.user != expected.creator
        {
            return Err(invalid());
        }
        verify(authority, self.signature, &self.frame()?)?;
        for member in std::iter::once(self.creator).chain(self.readers) {
            member.verify(authority)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::encode;
    use ed25519_dalek::{Signer, SigningKey};

    fn context() -> DelegationContext<'static> {
        DelegationContext {
            tenant: "laboratory:alpha",
            generation: "1",
            namespace: "experiment",
            creator: "researcher:kai",
        }
    }

    fn certificate(user: &str, seed: u8, authority: &SigningKey) -> IdentityCertificate {
        let mut certificate = IdentityCertificate {
            tenant: context().tenant.into(),
            generation: context().generation.into(),
            user: user.into(),
            encryption_key: encode(&[seed; 32]),
            signing_key: encode(
                SigningKey::from_bytes(&[seed; 32])
                    .verifying_key()
                    .as_bytes(),
            ),
            signature: String::new(),
        };
        certificate.signature = encode(&authority.sign(&certificate.frame().unwrap()).to_bytes());
        certificate
    }

    fn fixture() -> (DelegationCertificate, SigningKey) {
        let authority = SigningKey::from_bytes(&[1; 32]);
        let mut delegation = DelegationCertificate {
            tenant: context().tenant.into(),
            id: "delegation:experiment42".into(),
            generation: context().generation.into(),
            namespace: context().namespace.into(),
            creator: certificate(context().creator, 2, &authority),
            readers: vec![certificate("researcher:lee", 3, &authority)],
            signature: String::new(),
        };
        delegation.signature = encode(&authority.sign(&delegation.frame().unwrap()).to_bytes());
        (delegation, authority)
    }

    #[test]
    fn authority_delegations_require_the_expected_account_and_namespace() {
        let (delegation, authority) = fixture();
        let key = authority.verifying_key();
        delegation.verify(&context(), key.as_bytes()).unwrap();
        let mut rebound = delegation.clone();
        rebound.namespace = "appointment".into();
        assert!(
            rebound
                .verify(
                    &DelegationContext {
                        namespace: "appointment",
                        ..context()
                    },
                    key.as_bytes(),
                )
                .is_err()
        );
        for changed in [
            DelegationContext {
                tenant: "laboratory:beta",
                ..context()
            },
            DelegationContext {
                generation: "2",
                ..context()
            },
            DelegationContext {
                namespace: "appointment",
                ..context()
            },
            DelegationContext {
                creator: "researcher:intruder",
                ..context()
            },
        ] {
            assert!(delegation.verify(&changed, key.as_bytes()).is_err());
        }
        let intruder = SigningKey::from_bytes(&[4; 32]);
        assert!(
            delegation
                .verify(&context(), intruder.verifying_key().as_bytes())
                .is_err()
        );
    }

    #[test]
    fn recipients_are_structurally_bounded_and_individually_authority_certified() {
        let (delegation, authority) = fixture();
        let key = authority.verifying_key();
        let mut changed = delegation.clone();
        changed.readers.clear();
        assert!(changed.frame().is_err());
        changed = delegation.clone();
        changed.readers.push(changed.readers[0].clone());
        assert!(changed.frame().is_err());
        changed = delegation.clone();
        changed.readers[0].tenant = "laboratory:beta".into();
        assert!(changed.frame().is_err());
        changed = delegation.clone();
        changed.creator.generation = "2".into();
        assert!(changed.frame().is_err());
        changed = delegation.clone();
        changed.namespace = "*".into();
        assert!(changed.frame().is_err());
        changed = delegation.clone();
        changed.readers[0].signature = encode(&[0; 64]);
        // A valid outer signature does not certify an invalid member identity.
        changed.signature = encode(&authority.sign(&changed.frame().unwrap()).to_bytes());
        assert!(changed.verify(&context(), key.as_bytes()).is_err());

        let mut extra_field = serde_json::to_value(&delegation).unwrap();
        extra_field["privateKey"] = serde_json::json!("forbidden");
        assert!(serde_json::from_value::<DelegationCertificate>(extra_field).is_err());
    }
}
