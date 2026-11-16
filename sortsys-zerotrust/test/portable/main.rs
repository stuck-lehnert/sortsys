use serde::Deserialize;
use sortsys_zerotrust::{
    anchors::RecordAnchor,
    crypto::{decode, packet_hash, sized},
    delegations::{DelegationCertificate, DelegationContext},
    immutable,
    migration::{MigrationInventory, MigrationSeal},
    opentimestamps,
    policy::{Action, Effect, PolicyRef, RuleRef},
    protocol::EncryptedObject,
};

#[derive(Deserialize)]
struct Rule {
    subject: String,
    scope: String,
    facet: String,
    actions: Vec<Action>,
    effect: Effect,
}

#[derive(Deserialize)]
struct Policy {
    tenant: String,
    version: String,
    rules: Vec<Rule>,
    signature: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserVector {
    signer: String,
    object: EncryptedObject,
    policy: Policy,
    permanent: EncryptedObject,
    migration: MigrationSeal,
    packet_digest: String,
    proof: String,
    anchored: RecordAnchor,
    replacement: RecordAnchor,
    anchor_digest: String,
    delegation: DelegationCertificate<Namespace>,
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
    vector.anchored.follows(None).unwrap();
    vector.replacement.follows(Some(&vector.anchored)).unwrap();
    assert_eq!(
        vector.replacement.fingerprint().unwrap(),
        vector.anchor_digest
    );
    let signer = sized::<32>(&vector.signer).unwrap();
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
