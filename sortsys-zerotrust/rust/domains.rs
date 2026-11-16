//! Canonical domain proofs shared by application adapters and independent
//! consumers. Envelope and live-permission checks remain separate obligations.
use crate::{
    Result,
    crypto::{frame, identifier, invalid, packet_hash, revision, sized},
    key_authorities::KeyAuthorityRef,
};

pub struct DomainCreationRef<'a> {
    pub tenant: &'a str,
    pub id: &'a str,
    pub scope: &'a str,
    pub facet: &'a str,
    pub frame: &'a [u8],
    pub signature: &'a str,
}

pub enum DomainSignerRef<'a> {
    Authority,
    Creator(DomainCreationRef<'a>),
    Manager(KeyAuthorityRef<'a>),
}

pub struct DomainFrameRef<'a> {
    pub tenant: &'a str,
    pub id: &'a str,
    pub scope: &'a str,
    pub facet: &'a str,
    pub generation: &'a str,
    pub policy_version: &'a str,
    /// User envelopes in canonical order followed by the recovery envelope.
    pub envelope_hashes: &'a [String],
    pub signer: DomainSignerRef<'a>,
}

impl DomainFrameRef<'_> {
    pub fn frame(&self) -> Result<Vec<u8>> {
        for value in [self.tenant, self.id, self.scope, self.facet] {
            identifier(value)?;
        }
        revision(self.generation)?;
        revision(self.policy_version)?;
        if self.envelope_hashes.is_empty() || self.envelope_hashes.len() > 10001 {
            return Err(invalid());
        }
        for hash in self.envelope_hashes {
            sized::<32>(hash)?;
        }
        let mut hashes = self.envelope_hashes.to_vec();
        let domain = match &self.signer {
            DomainSignerRef::Authority => "sortsys/domain/v1",
            DomainSignerRef::Creator(origin) => {
                if self.generation != "1"
                    || origin.tenant != self.tenant
                    || origin.id != self.id
                    || origin.scope != self.scope
                    || origin.facet != self.facet
                {
                    return Err(invalid());
                }
                hashes.push(packet_hash(origin.frame, origin.signature)?);
                "sortsys/domain-created/v1"
            }
            DomainSignerRef::Manager(authority) => {
                if authority.tenant != self.tenant
                    || authority.scope != self.scope
                    || authority.facet != self.facet
                {
                    return Err(invalid());
                }
                hashes.push(packet_hash(&authority.frame()?, authority.signature)?);
                "sortsys/domain-managed/v1"
            }
        };
        let mut fields = vec![
            self.tenant,
            self.id,
            self.scope,
            self.facet,
            self.generation,
            self.policy_version,
        ];
        fields.extend(hashes.iter().map(String::as_str));
        Ok(frame(domain, &fields))
    }
}
