//! Stable credential identities are independent of mutable login aliases.
use crate::{
    Result,
    crypto::{encode, frame, identifier},
};
use serde::{Deserialize, Serialize};

pub const OPAQUE_SERVER_IDENTIFIER: &str = "sortsys/opaque/v2";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct CredentialPrincipal {
    pub tenant: String,
    pub subject: String,
}

impl CredentialPrincipal {
    pub fn identifier(&self) -> Result<String> {
        identifier(&self.tenant)?;
        identifier(&self.subject)?;
        Ok(encode(&frame(
            "sortsys/credential-principal/v1",
            &[&self.tenant, &self.subject],
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credential_boundaries_cannot_be_reassigned_by_slash_concatenation() {
        let first = CredentialPrincipal {
            tenant: "practice/alpha".into(),
            subject: "doctor:lee".into(),
        };
        let second = CredentialPrincipal {
            tenant: "practice".into(),
            subject: "alpha/doctor:lee".into(),
        };
        assert_ne!(first.identifier().unwrap(), second.identifier().unwrap());
        assert!(
            serde_json::from_str::<CredentialPrincipal>(
                r#"{"tenant":"practice","subject":"doctor:lee","username":"alias"}"#,
            )
            .is_err()
        );
        let empty = CredentialPrincipal {
            subject: String::new(),
            ..first
        };
        assert!(empty.identifier().is_err());
    }
}
