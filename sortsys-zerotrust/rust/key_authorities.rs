//! Scoped user signatures for encrypted key packages. This historical proof
//! never replaces live Grant/Read checks and actor validation during publication.
use crate::{
    Result,
    crypto::{encode, frame, identifier, invalid, revision, signed_packet_frame, sized, verify},
    protocol::IdentityCertificate,
};
use serde::{Deserialize, Serialize};
#[cfg(feature = "typescript")]
use ts_rs::TS;

#[derive(Clone, Deserialize, Serialize)]
#[cfg_attr(feature = "typescript", derive(TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KeyAuthority<F = String> {
    pub tenant: String,
    pub generation: String,
    pub scope: String,
    pub facet: F,
    pub holder: IdentityCertificate,
    pub signature: String,
}

pub struct KeyAuthorityContext<'a> {
    pub tenant: &'a str,
    pub generation: &'a str,
    pub scope: &'a str,
    pub facet: &'a str,
    pub holder: Option<&'a str>,
}

pub struct KeyAuthorityRef<'a> {
    pub tenant: &'a str,
    pub generation: &'a str,
    pub scope: &'a str,
    pub facet: &'a str,
    pub holder: &'a IdentityCertificate,
    pub signature: &'a str,
}

impl<F: AsRef<str>> KeyAuthority<F> {
    pub fn as_protocol(&self) -> KeyAuthorityRef<'_> {
        KeyAuthorityRef {
            tenant: &self.tenant,
            generation: &self.generation,
            scope: &self.scope,
            facet: self.facet.as_ref(),
            holder: &self.holder,
            signature: &self.signature,
        }
    }

    pub fn frame(&self) -> Result<Vec<u8>> {
        self.as_protocol().frame()
    }
    pub fn author(&self) -> Result<String> {
        self.as_protocol().author()
    }
    pub fn verify(&self, expected: &KeyAuthorityContext<'_>, authority: &[u8]) -> Result<()> {
        self.as_protocol().verify(expected, authority)
    }
}

impl KeyAuthorityRef<'_> {
    pub fn frame(&self) -> Result<Vec<u8>> {
        for value in [self.tenant, self.scope, self.facet] {
            identifier(value)?;
        }
        revision(self.generation)?;
        if self.holder.tenant != self.tenant || self.holder.generation != self.generation {
            return Err(invalid());
        }
        let holder = encode(&signed_packet_frame(
            &self.holder.frame()?,
            &self.holder.signature,
        )?);
        Ok(frame(
            "sortsys/key-authority/v1",
            &[
                self.tenant,
                self.generation,
                self.scope,
                self.facet,
                &holder,
            ],
        ))
    }

    pub fn author(&self) -> Result<String> {
        sized::<64>(self.signature)?;
        Ok(format!("delegate:{}", self.signature))
    }

    pub fn verify(&self, expected: &KeyAuthorityContext<'_>, authority: &[u8]) -> Result<()> {
        if self.tenant != expected.tenant
            || self.generation != expected.generation
            || self.scope != expected.scope
            || self.facet != expected.facet
            || expected
                .holder
                .is_some_and(|holder| holder != self.holder.user)
        {
            return Err(invalid());
        }
        self.holder.verify(authority)?;
        verify(authority, self.signature, &self.frame()?)
    }
}
