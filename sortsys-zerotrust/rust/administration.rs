//! Scoped permission administration using certified member keys. Root-signed
//! checkpoints authorize flat profiles; no private tenant authority is shared.
use crate::{
    Result,
    crypto::{encode, frame, identifier, invalid, revision, signed_packet_frame, sized, verify},
    policy::{Action, Effect, PolicyRef, RuleRef},
    protocol::IdentityCertificate,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
#[cfg(feature = "typescript")]
use ts_rs::TS;

const ORDINARY_ACTIONS: [Action; 5] = [
    Action::Read,
    Action::Create,
    Action::Update,
    Action::Delete,
    Action::Approve,
];

#[derive(Clone, Deserialize, Serialize)]
#[cfg_attr(feature = "typescript", derive(TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AdministrativeProfile<F = String> {
    pub tenant: String,
    pub root_signature: String,
    pub version: String,
    pub subject: String,
    pub scope: String,
    pub facet: F,
    pub actions: Vec<Action>,
    pub author: IdentityCertificate,
    pub signature: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[cfg_attr(feature = "typescript", derive(TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PolicyAdministration<R, F = String> {
    pub root: Box<R>,
    pub profiles: Vec<AdministrativeProfile<F>>,
    pub author: IdentityCertificate,
    pub previous_signature: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript", ts(optional))]
    pub continuation: Option<String>,
}

#[derive(Clone, Copy)]
pub struct AdministrativeProfileRef<'a> {
    pub tenant: &'a str,
    pub root_signature: &'a str,
    pub version: &'a str,
    pub subject: &'a str,
    pub scope: &'a str,
    pub facet: &'a str,
    pub actions: &'a [Action],
    pub author: &'a IdentityCertificate,
    pub signature: &'a str,
}

pub struct PolicyAdministrationRef<'a> {
    pub root: Box<PolicyRef<'a>>,
    pub root_signature: &'a str,
    pub profiles: Vec<AdministrativeProfileRef<'a>>,
    pub author: &'a IdentityCertificate,
    pub previous_signature: &'a str,
    pub continuation: Option<&'a str>,
}

fn signed_certificate(certificate: &IdentityCertificate) -> Result<String> {
    Ok(encode(&signed_packet_frame(
        &certificate.frame()?,
        &certificate.signature,
    )?))
}

impl<F: AsRef<str>> AdministrativeProfile<F> {
    pub fn as_protocol(&self) -> AdministrativeProfileRef<'_> {
        AdministrativeProfileRef {
            tenant: &self.tenant,
            root_signature: &self.root_signature,
            version: &self.version,
            subject: &self.subject,
            scope: &self.scope,
            facet: self.facet.as_ref(),
            actions: &self.actions,
            author: &self.author,
            signature: &self.signature,
        }
    }
}

impl AdministrativeProfileRef<'_> {
    pub fn key(&self) -> (&str, &str, &str) {
        (self.subject, self.scope, self.facet)
    }

    pub fn frame(&self) -> Result<Vec<u8>> {
        for value in [self.tenant, self.subject, self.scope, self.facet] {
            identifier(value)?;
        }
        revision(self.version)?;
        sized::<64>(self.root_signature)?;
        if self.author.tenant != self.tenant || self.actions.len() > ORDINARY_ACTIONS.len() {
            return Err(invalid());
        }
        let mut previous = None;
        for action in self.actions {
            let index = ORDINARY_ACTIONS
                .iter()
                .position(|candidate| candidate == action)
                .ok_or_else(invalid)?;
            if previous.is_some_and(|previous| index <= previous) {
                return Err(invalid());
            }
            previous = Some(index);
        }
        Ok(frame(
            "sortsys/administrative-profile/v1",
            &[
                self.tenant,
                self.root_signature,
                self.version,
                self.subject,
                self.scope,
                self.facet,
                &encode(&frame(
                    "sortsys/profile-actions/v1",
                    &self
                        .actions
                        .iter()
                        .map(|action| action.name())
                        .collect::<Vec<_>>(),
                )),
                &signed_certificate(self.author)?,
            ],
        ))
    }

    pub fn admits(&self, root: &PolicyRef<'_>, signature: &str) -> Result<bool> {
        self.frame()?;

        self.admitted_by(root, signature)
    }

    fn admitted_by(&self, root: &PolicyRef<'_>, signature: &str) -> Result<bool> {
        if self.tenant != root.tenant
            || self.root_signature != signature
            || revision(self.version)? <= revision(root.version)?
        {
            return Ok(false);
        }
        if root
            .suspended
            .is_some_and(|subjects| subjects.iter().any(|subject| subject == self.subject))
        {
            return Ok(false);
        }
        let protected = root.rules.iter().any(|rule| {
            rule.subject == self.subject
                && rule.scope == self.scope
                && rule.facet == self.facet
                && rule.effect == Effect::Allow
                && rule.actions.contains(&Action::Grant)
        });
        if protected
            || !root.allows_with(
                &[],
                &self.author.user,
                self.scope,
                self.facet,
                Action::Grant,
            )
        {
            return Ok(false);
        }
        for action in self.actions {
            if !root.allows_with(&[], &self.author.user, self.scope, self.facet, *action) {
                return Ok(false);
            }
        }
        Ok(true)
    }

    pub fn verify(
        &self,
        root: &PolicyRef<'_>,
        signature: &str,
        authority: &[u8],
        generation: &str,
    ) -> Result<()> {
        if self.author.generation != generation {
            return Err(invalid());
        }

        let frame = self.frame()?;
        if !self.admitted_by(root, signature)? {
            return Err(invalid());
        }

        self.author.verify(authority)?;
        verify(
            &sized::<32>(&self.author.signing_key)?,
            self.signature,
            &frame,
        )
    }
}

impl PolicyAdministrationRef<'_> {
    pub fn frame(&self, permissions: &[u8]) -> Result<Vec<u8>> {
        if self.root.administration.is_some() || self.profiles.len() > 10000 {
            return Err(invalid());
        }
        sized::<64>(self.root_signature)?;
        sized::<64>(self.previous_signature)?;
        let mut fields = vec![
            encode(permissions),
            self.root_signature.to_owned(),
            signed_certificate(self.author)?,
            self.previous_signature.to_owned(),
        ];
        let purpose = if let Some(binding) = self.continuation {
            sized::<32>(binding)?;
            fields.push(binding.to_owned());
            "sortsys/delegated-policy-continuation/v1"
        } else {
            "sortsys/delegated-policy/v1"
        };
        fields.extend(
            self.profiles
                .iter()
                .map(|profile| profile.signature.to_owned()),
        );
        Ok(frame(
            purpose,
            &fields.iter().map(String::as_str).collect::<Vec<_>>(),
        ))
    }

    pub fn verify(&self, current: &PolicyRef<'_>, signature: &str, authority: &[u8]) -> Result<()> {
        if self.root.administration.is_some()
            || self.root.tenant != current.tenant
            || self.author.tenant != current.tenant
            || revision(self.root.version)? >= revision(current.version)?
            || self.root.suspended != current.suspended
            || self.continuation.is_some() && current.transaction.is_some()
        {
            return Err(invalid());
        }
        self.root.verify(authority, self.root_signature)?;
        self.author.verify(authority)?;
        let manager = self.root.rules.iter().any(|rule| {
            self.root.allows_with(
                &[],
                &self.author.user,
                rule.scope,
                rule.facet,
                Action::Grant,
            )
        });
        if !manager {
            return Err(invalid());
        }
        let mut previous = None;
        for profile in &self.profiles {
            if previous.is_some_and(|key| profile.key() <= key)
                || revision(profile.version)? > revision(current.version)?
            {
                return Err(invalid());
            }
            profile.verify(
                &self.root,
                self.root_signature,
                authority,
                &self.author.generation,
            )?;
            previous = Some(profile.key());
        }
        if let Some(transaction) = current.transaction
            && (transaction.author != self.author.user
                || transaction.previous_signature != self.previous_signature)
        {
            return Err(invalid());
        }

        if !self.matches_rules(&current.rules) {
            return Err(invalid());
        }

        let permissions = current.frame()?;
        if self.continuation.is_some() {
            return verify(authority, signature, &permissions);
        }
        verify(
            &sized::<32>(&self.author.signing_key)?,
            signature,
            &permissions,
        )
    }

    // The rule frame encodes these fields in order, including action order
    // and the presence of an origin. Compare them directly; the signed
    // current frame still validates every rule before signature verification.
    fn matches_rules(&self, rules: &[RuleRef<'_>]) -> bool {
        let keys = self
            .profiles
            .iter()
            .map(AdministrativeProfileRef::key)
            .collect::<std::collections::HashSet<_>>();
        let mut actual = rules.iter();

        for rule in &self.root.rules {
            let derived = rule.origin.is_some()
                && rule.effect == Effect::Allow
                && !rule.actions.contains(&Action::Grant);
            if (derived || !keys.contains(&(rule.subject, rule.scope, rule.facet)))
                && actual.next() != Some(rule)
            {
                return false;
            }
        }

        for profile in &self.profiles {
            let denied = ORDINARY_ACTIONS
                .iter()
                .copied()
                .filter(|action| !profile.actions.contains(action))
                .collect::<Vec<_>>();
            for (actions, effect) in [
                (profile.actions, Effect::Allow),
                (denied.as_slice(), Effect::Deny),
            ] {
                if actions.is_empty() {
                    continue;
                }

                let expected = RuleRef {
                    subject: profile.subject,
                    scope: profile.scope,
                    facet: profile.facet,
                    actions,
                    effect,
                    origin: None,
                };
                if actual.next() != Some(&expected) {
                    return false;
                }
            }
        }

        actual.next().is_none()
    }

    /// Both snapshots must be independently verified before admission. A root
    /// checkpoint discards delegation history while retaining effective rights.
    pub fn replaces(
        &self,
        previous: &PolicyRef<'_>,
        previous_signature: &str,
        actor: &IdentityCertificate,
        version: &str,
    ) -> Result<bool> {
        if self.continuation.is_some()
            || self.author.signature != actor.signature
            || self.previous_signature != previous_signature
            || revision(previous.version)?.checked_add(1) != Some(revision(version)?)
        {
            return Ok(false);
        }
        let (root_signature, profiles) = match &previous.administration {
            Some(value) => (value.root_signature, value.profiles.as_slice()),
            None => (previous_signature, &[][..]),
        };
        if self.root_signature != root_signature {
            return Ok(false);
        }
        let mut remaining = profiles
            .iter()
            .map(|profile| (profile.key(), profile))
            .collect::<HashMap<_, _>>();
        let mut changed = false;
        for profile in &self.profiles {
            let known = remaining.remove(&profile.key());
            if known.is_none_or(|known| known.signature != profile.signature) {
                if profile.author.signature != actor.signature || profile.version != version {
                    return Ok(false);
                }
                changed = true;
            }
        }
        Ok(changed && remaining.is_empty())
    }

    pub(super) fn continues(
        &self,
        previous: &Self,
        previous_signature: &str,
        binding: &str,
    ) -> bool {
        self.continuation == Some(binding)
            && self.previous_signature == previous_signature
            && self.root_signature == previous.root_signature
            && self.author.signature == previous.author.signature
            && self
                .profiles
                .iter()
                .map(|profile| profile.signature)
                .eq(previous.profiles.iter().map(|profile| profile.signature))
    }
}
