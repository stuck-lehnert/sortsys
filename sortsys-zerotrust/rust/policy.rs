use crate::Result;
use crate::crypto::{encode, frame, identifier, invalid, revision, sized, verify};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
#[cfg(feature = "typescript")]
use ts_rs::TS;

/// A borrowed rule avoids copying large signed policies for admission checks.
/// Facet and subject vocabularies belong to the consuming application.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct RuleRef<'a> {
    pub subject: &'a str,
    pub scope: &'a str,
    pub facet: &'a str,
    pub actions: &'a [Action],
    pub effect: Effect,
    pub origin: Option<&'a str>,
}

pub struct PolicyRef<'a> {
    pub tenant: &'a str,
    pub version: &'a str,
    pub rules: Vec<RuleRef<'a>>,
    pub suspended: Option<&'a [String]>,
    pub transaction: Option<&'a PolicyTransaction>,
    pub administration: Option<crate::administration::PolicyAdministrationRef<'a>>,
}

impl PolicyRef<'_> {
    pub fn frame(&self) -> Result<Vec<u8>> {
        identifier(self.tenant)?;
        revision(self.version)?;
        if self.rules.len() > 10_000 {
            return Err(invalid());
        }
        let mut fields = vec![self.tenant.to_owned(), self.version.to_owned()];
        if let Some(subjects) = self.suspended {
            if subjects.len() > 10_000 {
                return Err(invalid());
            }
            for (index, subject) in subjects.iter().enumerate() {
                identifier(subject)?;
                if index > 0 && subjects[index - 1] >= *subject {
                    return Err(invalid());
                }
            }
            fields.push(encode(&frame(
                "sortsys/suspended/v1",
                &subjects.iter().map(String::as_str).collect::<Vec<_>>(),
            )));
        } else if self.transaction.is_some() {
            fields.push(String::new());
        }
        if let Some(transaction) = self.transaction {
            fields.push(encode(&transaction.frame()?));
        }
        for rule in &self.rules {
            fields.push(encode(&rule.frame()?));
        }
        let domain = if self.transaction.is_some() {
            "sortsys/policy/v3"
        } else if self.suspended.is_some() {
            "sortsys/policy/v2"
        } else {
            "sortsys/policy/v1"
        };
        let primary_frame = frame(
            domain,
            &fields.iter().map(String::as_str).collect::<Vec<_>>(),
        );
        match &self.administration {
            Some(administration) => administration.frame(&primary_frame),
            None => Ok(primary_frame),
        }
    }

    pub fn verify(&self, key: &[u8], signature: &str) -> Result<()> {
        if let Some(administration) = &self.administration {
            return administration.verify(self, signature, key);
        }
        verify(key, signature, &self.frame()?)
    }

    /// Compare independently verified policies at an application checkpoint.
    /// The new version retains the same authority and profile provenance.
    pub fn continues(
        &self,
        previous: &Self,
        previous_signature: &str,
        binding: &str,
    ) -> Result<bool> {
        sized::<32>(binding)?;
        if self.tenant != previous.tenant
            || revision(previous.version)?.checked_add(1) != Some(revision(self.version)?)
            || self.transaction.is_some()
            || self.suspended != previous.suspended
            || self.rules.len() != previous.rules.len()
        {
            return Ok(false);
        }
        for (current, previous) in self.rules.iter().zip(&previous.rules) {
            if current.frame()? != previous.frame()? {
                return Ok(false);
            }
        }
        Ok(match (&self.administration, &previous.administration) {
            (None, None) => true,
            (Some(current), Some(previous)) => {
                current.continues(previous, previous_signature, binding)
            }
            _ => false,
        })
    }

    /// Evaluate an already verified policy. Extra rules must have their own
    /// authenticated provenance; hierarchy is never inferred from scope names.
    pub fn allows_with(
        &self,
        inherited: &[RuleRef<'_>],
        subject: &str,
        scope: &str,
        facet: &str,
        action: Action,
    ) -> bool {
        allows(
            self.rules.iter().chain(inherited).copied(),
            self.suspended,
            PermissionRequest {
                subject,
                scope,
                facet,
                action,
            },
        )
    }
}

pub struct PermissionRequest<'a> {
    pub subject: &'a str,
    pub scope: &'a str,
    pub facet: &'a str,
    pub action: Action,
}

/// Evaluate authenticated rules without allocating another policy projection.
pub fn allows<'a>(
    rules: impl IntoIterator<Item = RuleRef<'a>>,
    suspended: Option<&[String]>,
    request: PermissionRequest<'_>,
) -> bool {
    if suspended.is_some_and(|subjects| subjects.iter().any(|value| value == request.subject)) {
        return false;
    }
    let mut allowed = false;
    for rule in rules {
        if rule.subject != request.subject
            || rule.scope != request.scope
            || rule.facet != request.facet
            || !rule.actions.contains(&request.action)
        {
            continue;
        }
        if rule.effect == Effect::Deny {
            return false;
        }
        allowed = true;
    }
    allowed
}

impl RuleRef<'_> {
    pub fn frame(&self) -> Result<Vec<u8>> {
        for value in [self.subject, self.scope, self.facet] {
            identifier(value)?;
        }
        if self.actions.is_empty() || self.actions.len() > 6 {
            return Err(invalid());
        }
        for (index, action) in self.actions.iter().enumerate() {
            if self.actions[..index].contains(action) {
                return Err(invalid());
            }
        }
        let effect = match self.effect {
            Effect::Allow => "allow",
            Effect::Deny => "deny",
        };
        let mut fields = vec![self.subject, self.scope, self.facet, effect];
        if let Some(origin) = self.origin {
            identifier(origin)?;
            fields.push(origin);
        }
        fields.extend(self.actions.iter().map(|action| action.name()));
        let domain = if self.origin.is_some() {
            "sortsys/rule/v2"
        } else {
            "sortsys/rule/v1"
        };
        Ok(frame(domain, &fields))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[cfg_attr(feature = "typescript", derive(TS))]
#[serde(rename_all = "lowercase")]
pub enum Action {
    Read,
    Create,
    Update,
    Delete,
    Approve,
    Grant,
}
impl Action {
    pub fn name(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Create => "create",
            Self::Update => "update",
            Self::Delete => "delete",
            Self::Approve => "approve",
            Self::Grant => "grant",
        }
    }

    pub fn bit(self) -> u8 {
        match self {
            Self::Read => 1,
            Self::Create => 2,
            Self::Update => 4,
            Self::Delete => 8,
            Self::Approve => 16,
            Self::Grant => 32,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[cfg_attr(feature = "typescript", derive(TS))]
#[serde(rename_all = "lowercase")]
pub enum Effect {
    Allow,
    Deny,
}

#[derive(Clone, Deserialize, Serialize)]
#[cfg_attr(feature = "typescript", derive(TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PolicyTransaction {
    pub author: String,
    pub previous_signature: String,
    pub packets: Vec<String>,
    pub heads: Vec<PolicyHead>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript", ts(optional))]
    pub packet_commitment: Option<PacketCommitment>,
}
#[derive(Clone, Deserialize, Serialize)]
#[cfg_attr(feature = "typescript", derive(TS))]
#[serde(deny_unknown_fields)]
pub struct PacketCommitment {
    pub count: u32,
    pub digest: String,
}
impl PacketCommitment {
    pub fn from_signatures(packets: &[&str]) -> Result<Self> {
        if packets.len() <= 64 || packets.len() > 40_001 {
            return Err(invalid());
        }
        for (index, packet) in packets.iter().enumerate() {
            sized::<64>(packet)?;
            if index > 0 && packets[index - 1] >= *packet {
                return Err(invalid());
            }
        }
        Ok(Self {
            count: packets.len() as u32,
            digest: encode(&Sha256::digest(frame(
                "sortsys/packet-signatures/v1",
                packets,
            ))),
        })
    }
}
#[derive(Clone, Deserialize, Serialize)]
#[cfg_attr(feature = "typescript", derive(TS))]
#[serde(deny_unknown_fields)]
pub struct PolicyHead {
    pub domain: String,
    pub sequence: String,
}
impl PolicyTransaction {
    pub fn binds_packets(&self, packets: &[&str]) -> Result<bool> {
        self.frame()?;
        if let Some(expected) = &self.packet_commitment {
            let actual = PacketCommitment::from_signatures(packets)?;
            return Ok(expected.count == actual.count && expected.digest == actual.digest);
        }
        Ok(self
            .packets
            .iter()
            .map(String::as_str)
            .eq(packets.iter().copied()))
    }
    pub fn frame(&self) -> Result<Vec<u8>> {
        identifier(&self.author)?;
        sized::<64>(&self.previous_signature)?;
        if self.packets.len() > 64 || self.heads.is_empty() || self.heads.len() > 20_001 {
            return Err(invalid());
        }
        for (index, packet) in self.packets.iter().enumerate() {
            sized::<64>(packet)?;
            if index > 0 && self.packets[index - 1] >= *packet {
                return Err(invalid());
            }
        }
        let mut packet_binding = encode(&frame(
            "sortsys/packet-signatures/v1",
            &self.packets.iter().map(String::as_str).collect::<Vec<_>>(),
        ));
        let mut purpose = "sortsys/policy-transaction/v1";
        if let Some(commitment) = &self.packet_commitment {
            if !self.packets.is_empty() || commitment.count <= 64 || commitment.count > 40_001 {
                return Err(invalid());
            }
            sized::<32>(&commitment.digest)?;
            packet_binding = encode(&frame(
                "sortsys/packet-signature-commitment/v1",
                &[&commitment.count.to_string(), &commitment.digest],
            ));
            purpose = "sortsys/policy-transaction/v2";
        }
        let mut fields = vec![
            self.author.clone(),
            self.previous_signature.clone(),
            packet_binding,
        ];
        for (index, head) in self.heads.iter().enumerate() {
            identifier(&head.domain)?;
            if head.sequence != "0" {
                revision(&head.sequence)?;
            }
            if index > 0 && self.heads[index - 1].domain >= head.domain {
                return Err(invalid());
            }
            fields.push(encode(&frame(
                "sortsys/policy-head/v1",
                &[&head.domain, &head.sequence],
            )));
        }
        Ok(frame(
            purpose,
            &fields.iter().map(String::as_str).collect::<Vec<_>>(),
        ))
    }
}
