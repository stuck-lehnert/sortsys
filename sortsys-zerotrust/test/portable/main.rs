use serde::Deserialize;
use sha2::{Digest, Sha256};
use sortsys_zerotrust::{
    administration::{PolicyAdministration, PolicyAdministrationRef},
    anchors::RecordAnchor,
    credentials::CredentialPrincipal,
    crypto::{AccountVault, decode, encode, packet_hash, sized},
    delegations::{DelegationCertificate, DelegationContext},
    domains::{DomainFrameRef, DomainSignerRef},
    immutable,
    key_authorities::{KeyAuthority, KeyAuthorityContext},
    migration::{MigrationInventory, MigrationSeal},
    opentimestamps,
    policy::{Action, Effect, PolicyRef, RuleRef},
    prepared_payload::PreparedPayloadManifest,
    protocol::{EncryptedObject, SealedBox},
    recovery_inventory::{DEFAULT_RECOVERY_LIMITS, RecoveryInventory},
    resource_access::{ResourceAccessContext, ResourceAccessState},
    webauthn::{self, RegistrationCredential},
};

#[derive(Clone, Deserialize)]
struct Rule {
    subject: String,
    scope: String,
    facet: String,
    actions: Vec<Action>,
    effect: Effect,
}

#[derive(Clone, Deserialize)]
struct Policy {
    tenant: String,
    version: String,
    rules: Vec<Rule>,
    signature: String,
    suspended: Option<Vec<String>>,
    administration: Option<PolicyAdministration<Policy>>,
}

impl Policy {
    fn as_protocol(&self) -> PolicyRef<'_> {
        PolicyRef {
            tenant: &self.tenant,
            version: &self.version,
            rules: self
                .rules
                .iter()
                .map(|rule| RuleRef {
                    subject: &rule.subject,
                    scope: &rule.scope,
                    facet: &rule.facet,
                    actions: &rule.actions,
                    effect: rule.effect,
                    origin: None,
                })
                .collect(),
            suspended: self.suspended.as_deref(),
            transaction: None,
            administration: self
                .administration
                .as_ref()
                .map(|value| PolicyAdministrationRef {
                    root: Box::new(value.root.as_protocol()),
                    root_signature: &value.root.signature,
                    profiles: value
                        .profiles
                        .iter()
                        .map(|profile| profile.as_protocol())
                        .collect(),
                    author: &value.author,
                    previous_signature: &value.previous_signature,
                }),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserVector {
    passkey: PasskeyVector,
    credential: String,
    account_vault: AccountVault,
    inventory: RecoveryInventory,
    payload: PayloadVector,
    signer: String,
    object: EncryptedObject,
    object_share: SealedBox,
    object_share_binding: String,
    policy: Policy,
    permanent: EncryptedObject,
    migration: MigrationSeal,
    packet_digest: String,
    proof: String,
    anchored: RecordAnchor,
    replacement: RecordAnchor,
    anchor_digest: String,
    delegation: DelegationCertificate<Namespace>,
    access_state: ResourceAccessState,
    administrative_policy: Policy,
    managed_domain: ManagedDomain,
    unchanged_administration: Policy,
    administration_revoked: Policy,
    stale_administration: Policy,
}

#[derive(Deserialize)]
struct PasskeyVector {
    credential: RegistrationCredential,
    binding: PasskeyBinding,
    proof: String,
    deletion: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PasskeyBinding {
    tenant: String,
    subject: String,
    user_handle: String,
    exchange_hash: String,
    credential_hash: String,
    key_vault_hash: String,
    label: String,
}

#[derive(Deserialize)]
struct PayloadVector {
    manifest: PreparedPayloadManifest,
    parts: Vec<String>,
    content: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManagedDomain {
    tenant: String,
    id: String,
    scope: String,
    facet: String,
    generation: String,
    policy_version: String,
    envelopes: Vec<SealedBox>,
    recovery_envelope: SealedBox,
    key_authority: KeyAuthority,
    proof: String,
}

impl ManagedDomain {
    fn frame(&self) -> sortsys_zerotrust::Result<Vec<u8>> {
        let hashes = self
            .envelopes
            .iter()
            .chain(std::iter::once(&self.recovery_envelope))
            .map(|envelope| packet_hash(&envelope.frame()?, &envelope.signature))
            .collect::<sortsys_zerotrust::Result<Vec<_>>>()?;
        DomainFrameRef {
            tenant: &self.tenant,
            id: &self.id,
            scope: &self.scope,
            facet: &self.facet,
            generation: &self.generation,
            policy_version: &self.policy_version,
            envelope_hashes: &hashes,
            signer: DomainSignerRef::Manager(self.key_authority.as_protocol()),
        }
        .frame()
    }
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum Namespace {
    Experiment,
    Appointment,
}

impl AsRef<str> for Namespace {
    fn as_ref(&self) -> &str {
        match self {
            Self::Experiment => "experiment",
            Self::Appointment => "appointment",
        }
    }
}

fn main() {
    let vector: BrowserVector = serde_json::from_str(include_str!("browser-vector.json")).unwrap();
    let principal = CredentialPrincipal {
        tenant: "laboratory:alpha".into(),
        subject: "researcher:kai".into(),
    };
    assert_eq!(principal.identifier().unwrap(), vector.credential);
    vector.account_vault.validate().unwrap();
    assert_eq!(vector.account_vault.tenant, principal.tenant);
    assert_eq!(vector.account_vault.subject, principal.subject);
    vector.inventory.validate(DEFAULT_RECOVERY_LIMITS).unwrap();
    assert_eq!(vector.inventory.key_generations, 10_003);
    assert!(vector.payload.parts.len() > 1);
    assert_eq!(
        vector
            .payload
            .manifest
            .assemble(&vector.payload.parts)
            .unwrap(),
        vector.payload.content
    );
    vector.anchored.follows(None).unwrap();
    vector.replacement.follows(Some(&vector.anchored)).unwrap();
    assert_eq!(
        vector.replacement.fingerprint().unwrap(),
        vector.anchor_digest
    );
    let signer = sized::<32>(&vector.signer).unwrap();
    let passkey = &vector.passkey;
    let binding = &passkey.binding;
    let enrollment = webauthn::RegistrationBinding {
        tenant: &binding.tenant,
        subject: &binding.subject,
        user_handle: &binding.user_handle,
        exchange_hash: &binding.exchange_hash,
        credential_hash: &binding.credential_hash,
        key_vault_hash: &binding.key_vault_hash,
        label: &binding.label,
    };
    assert_eq!(binding.tenant, "laboratory:alpha");
    assert_eq!(binding.subject, "researcher:kai");
    assert_eq!(
        binding.user_handle,
        webauthn::routing_user_handle(&binding.tenant, &[42]).unwrap()
    );
    assert_eq!(
        binding.credential_hash,
        encode(&Sha256::digest(
            webauthn::registration_frame(&passkey.credential).unwrap()
        ))
    );
    sortsys_zerotrust::crypto::verify(&signer, &passkey.proof, &enrollment.frame().unwrap())
        .unwrap();
    sortsys_zerotrust::crypto::verify(
        &signer,
        &passkey.deletion,
        &webauthn::deletion_frame(&binding.tenant, &binding.subject, "device:17").unwrap(),
    )
    .unwrap();
    let managed = &vector.managed_domain;
    managed
        .key_authority
        .verify(
            &KeyAuthorityContext {
                tenant: "laboratory:alpha",
                generation: "1",
                scope: "experiment:42",
                facet: "research-notes",
                holder: Some("researcher:kai"),
            },
            &signer,
        )
        .unwrap();
    let manager_key = sized::<32>(&managed.key_authority.holder.signing_key).unwrap();
    sortsys_zerotrust::crypto::verify(&manager_key, &managed.proof, &managed.frame().unwrap())
        .unwrap();
    for envelope in managed
        .envelopes
        .iter()
        .chain(std::iter::once(&managed.recovery_envelope))
    {
        assert_eq!(envelope.tenant, managed.tenant);
        assert_eq!(envelope.object, managed.id);
        assert_eq!(envelope.generation, managed.generation);
        assert_eq!(envelope.author, managed.key_authority.author().unwrap());
        envelope.verify(&manager_key).unwrap();
    }
    let mut substituted = managed.clone();
    substituted.scope = "experiment:other".into();
    assert!(substituted.frame().is_err());
    let administrative = vector.administrative_policy.as_protocol();
    administrative
        .verify(&signer, &vector.administrative_policy.signature)
        .unwrap();
    assert!(administrative.allows_with(
        &[],
        "researcher:ada",
        "experiment:42",
        "research-notes",
        Action::Update
    ));
    assert!(!administrative.allows_with(
        &[],
        "researcher:ada",
        "experiment:42",
        "research-notes",
        Action::Grant
    ));
    let admission = administrative.administration.as_ref().unwrap();
    assert!(
        admission
            .replaces(
                &admission.root,
                admission.root_signature,
                admission.author,
                &vector.administrative_policy.version
            )
            .unwrap()
    );
    let unchanged = vector.unchanged_administration.as_protocol();
    unchanged
        .verify(&signer, &vector.unchanged_administration.signature)
        .unwrap();
    assert!(
        !unchanged
            .administration
            .as_ref()
            .unwrap()
            .replaces(
                &administrative,
                &vector.administrative_policy.signature,
                admission.author,
                &vector.unchanged_administration.version
            )
            .unwrap()
    );
    let stale = vector.stale_administration.as_protocol();
    stale
        .verify(&signer, &vector.stale_administration.signature)
        .unwrap();
    assert!(
        !stale
            .administration
            .as_ref()
            .unwrap()
            .replaces(
                &vector.administration_revoked.as_protocol(),
                &vector.administration_revoked.signature,
                admission.author,
                &vector.stale_administration.version
            )
            .unwrap()
    );
    let mut altered = vector.administrative_policy.clone();
    altered.administration.as_mut().unwrap().profiles[0].subject = "researcher:intruder".into();
    assert!(
        altered
            .as_protocol()
            .verify(&signer, &altered.signature)
            .is_err()
    );
    let binding = encode(&[7; 32]);
    let access_context = ResourceAccessContext {
        tenant: "laboratory:alpha",
        resource: "experiment:42",
        object: "note:1",
        generation: "1",
        binding: &binding,
    };
    vector
        .access_state
        .verify(&access_context, &signer)
        .unwrap();
    assert_eq!(
        vector.access_state.packet_signature,
        vector.object.signature
    );
    let mut altered = vector.access_state.clone();
    altered.active = false;
    assert!(altered.verify(&access_context, &signer).is_err());
    let expected = DelegationContext {
        tenant: "laboratory:alpha",
        generation: "1",
        namespace: "experiment",
        creator: "researcher:kai",
    };
    vector.delegation.verify(&expected, &signer).unwrap();
    let mut substituted = vector.delegation.clone();
    substituted.namespace = Namespace::Appointment;
    assert!(substituted.verify(&expected, &signer).is_err());
    let mut substituted = vector.delegation.clone();
    substituted.readers[0].user = "researcher:intruder".into();
    assert!(substituted.verify(&expected, &signer).is_err());
    vector.object.verify(&signer).unwrap();
    assert_eq!(sortsys_zerotrust::object_shares::recipient_binding(
        Some(&vector.delegation.creator), Some(&vector.object_share),
    ).unwrap(), vector.object_share_binding);
    sortsys_zerotrust::object_shares::verify(
        &vector.object_share,
        &vector.object,
        &sortsys_zerotrust::object_shares::ObjectShareContext {
            authority_generation: "1",
            recipient: "researcher:kai",
            author: &vector.object.author,
        },
        &signer,
        &signer,
    )
    .unwrap();
    assert_eq!(vector.object.facet, "research-notes");
    let rules = vector
        .policy
        .rules
        .iter()
        .map(|rule| RuleRef {
            subject: &rule.subject,
            scope: &rule.scope,
            facet: &rule.facet,
            actions: &rule.actions,
            effect: rule.effect,
            origin: None,
        })
        .collect();
    let policy = PolicyRef {
        tenant: &vector.policy.tenant,
        version: &vector.policy.version,
        rules,
        suspended: None,
        transaction: None,
        administration: None,
    };
    policy.verify(&signer, &vector.policy.signature).unwrap();
    assert!(policy.allows_with(
        &[],
        "researcher:lee",
        "experiment:42",
        "research-notes",
        Action::Update
    ));
    assert!(!policy.allows_with(
        &[],
        "researcher:lee",
        "experiment:42",
        "research-notes",
        Action::Delete
    ));

    vector.permanent.verify(&signer).unwrap();
    assert_eq!(
        immutable::write_action(&vector.permanent).unwrap(),
        Some(Action::Create)
    );
    let digest = packet_hash(
        &vector.permanent.frame().unwrap(),
        &vector.permanent.signature,
    )
    .unwrap();
    assert_eq!(digest, vector.packet_digest);
    let proof = decode(&vector.proof, opentimestamps::MAX_BYTES).unwrap();
    assert!(
        opentimestamps::inspect(&proof, &sized::<32>(&digest).unwrap())
            .unwrap()
            .has_pending_attestations
    );
    assert!(opentimestamps::inspect(&proof, &[0; 32]).is_err());

    vector.migration.verify(&signer).unwrap();
    let mut source_inventory = MigrationInventory::default();
    let source_hash =
        packet_hash(&vector.object.frame().unwrap(), &vector.object.signature).unwrap();
    source_inventory
        .add(
            "record",
            &vector.object.object,
            &vector.object.revision,
            &source_hash,
        )
        .unwrap();
    assert_eq!(source_inventory.finish(), vector.migration.source);
    let mut target_inventory = MigrationInventory::default();
    target_inventory
        .add(
            "record",
            &vector.permanent.object,
            &vector.permanent.revision,
            &digest,
        )
        .unwrap();
    assert_eq!(target_inventory.finish(), vector.migration.target);
    let mut changed_seal = vector.migration;
    changed_seal.schema = "lab-schema:unverified".into();
    assert!(changed_seal.verify(&signer).is_err());

    let mut changed = vector.object;
    changed.facet = "appointments".into();
    assert!(changed.verify(&signer).is_err());
    let mut changed = vector.permanent;
    changed.revision = "2".into();
    assert!(immutable::write_action(&changed).is_err());
    println!(
        "Independent Rust consumer verified browser signatures, delegations, permissions, migration seals and OTS evidence."
    );
}
