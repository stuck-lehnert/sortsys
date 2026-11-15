use serde::Deserialize;
use sortsys_zerotrust::{
    crypto::{sized, verify},
    immutable,
    migration::MigrationFileReceipt,
    policy::{Action, Effect, PolicyRef, RuleRef},
    protocol::EncryptedObject,
    recovery::{RecoveryPageAccess, RecoveryTransition},
};

#[derive(Deserialize)]
struct PublicIdentity {
    #[serde(rename = "signingKey")]
    signing_key: String,
}

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
    suspended: Vec<String>,
    signature: String,
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
            suspended: Some(&self.suspended),
            transaction: None,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserVector {
    signer: PublicIdentity,
    object: EncryptedObject,
    policy: Policy,
    transition: RecoveryTransition,
    transition_signature: String,
    page_access: RecoveryPageAccess,
    page_signature: String,
    file_receipt: MigrationFileReceipt,
    permanent: EncryptedObject,
}

#[test]
fn permanent_records_support_another_application_and_never_allow_later_writes() {
    let input = vector();
    let key = sized::<32>(&input.signer.signing_key).unwrap();
    let permanent = input.permanent;
    permanent.verify(&key).unwrap();
    let binding = immutable::binding(&permanent).unwrap().unwrap();
    assert_eq!(binding.kind, "record");
    assert_eq!(binding.id, "visit_1");
    assert_eq!(
        immutable::write_action(&permanent).unwrap(),
        Some(Action::Create)
    );
    for (revision, format) in [
        ("2", "sortsys-object-v1"),
        ("2", "sortsys-object-tombstone-v1"),
        ("1", "sortsys-object-tombstone-v1"),
    ] {
        let mut changed = permanent.clone();
        changed.revision = revision.into();
        changed.format = format.into();
        assert!(immutable::write_action(&changed).is_err());
    }
    let mut rebound = permanent.clone();
    rebound.facet = "appointments".into();
    assert!(immutable::binding(&rebound).is_err());
    rebound = permanent.clone();
    rebound.object.push_str(":extra");
    assert!(immutable::binding(&rebound).is_err());
    assert!(immutable::binding(&input.object).unwrap().is_none());
}

#[test]
fn file_receipts_bind_each_reference_and_the_ordered_ciphertext_blocks() {
    let input = vector();
    let key = sized::<32>(&input.signer.signing_key).unwrap();
    let receipt = input.file_receipt;
    verify(&key, &receipt.proof, &receipt.frame().unwrap()).unwrap();

    let original = serde_json::to_value(&receipt).unwrap();
    for (field, replacement) in [
        ("tenant", "practice:other"),
        ("migration", "migration:other"),
        ("generation", "2"),
        ("source", "source:other"),
        ("bytes", "262152"),
        ("object", "archive:other"),
        ("revision", "2"),
        ("ciphertextHash", &receipt.blocks[0].hash),
        ("author", "doctor:other"),
    ] {
        let mut changed = original.clone();
        changed[field] = serde_json::json!(replacement);
        let changed: MigrationFileReceipt = serde_json::from_value(changed).unwrap();
        assert!(verify(&key, &changed.proof, &changed.frame().unwrap()).is_err());
    }
    let mut reordered = receipt.clone();
    reordered.blocks.reverse();
    assert!(verify(&key, &reordered.proof, &reordered.frame().unwrap()).is_err());

    let mut duplicated = receipt.clone();
    duplicated.blocks.push(duplicated.blocks[0].clone());
    assert!(duplicated.frame().is_err());
    for bytes in ["-1", "01", "1.0", "9223372036854775808"] {
        let mut invalid = receipt.clone();
        invalid.bytes = bytes.into();
        assert!(invalid.frame().is_err());
    }
    let mut extra_field = original;
    extra_field["filename"] = serde_json::json!("confidential.pdf");
    assert!(serde_json::from_value::<MigrationFileReceipt>(extra_field).is_err());
}

fn vector() -> BrowserVector {
    serde_json::from_str(include_str!("../../test/fixtures/framework.json")).unwrap()
}

#[test]
fn another_application_verifies_browser_packets_without_sortsys_models() {
    let mut input = vector();
    let key = sized::<32>(&input.signer.signing_key).unwrap();
    input.object.verify(&key).unwrap();
    verify(
        &key,
        &input.page_signature,
        &input.page_access.frame().unwrap(),
    )
    .unwrap();
    input.page_access.after = None;
    assert!(
        verify(
            &key,
            &input.page_signature,
            &input.page_access.frame().unwrap()
        )
        .is_err()
    );
    input
        .policy
        .as_protocol()
        .verify(&key, &input.policy.signature)
        .unwrap();
    verify(
        &key,
        &input.transition_signature,
        &input.transition.frame().unwrap(),
    )
    .unwrap();
    assert!(input.policy.as_protocol().allows_with(
        &[],
        "doctor:lee",
        "patient:ada",
        "patient-notes",
        Action::Update
    ));
    assert!(!input.policy.as_protocol().allows_with(
        &[],
        "doctor:other",
        "patient:ada",
        "patient-notes",
        Action::Read
    ));
    input.object.facet = "appointments".into();
    assert!(input.object.verify(&key).is_err());
    input.policy.rules[0].actions.push(Action::Delete);
    assert!(
        input
            .policy
            .as_protocol()
            .verify(&key, &input.policy.signature)
            .is_err()
    );
    input.transition.next_administrator = "doctor:other".into();
    assert!(
        verify(
            &key,
            &input.transition_signature,
            &input.transition.frame().unwrap()
        )
        .is_err()
    );
}

#[test]
fn application_denials_win_and_suspension_blocks_inherited_permissions() {
    let input = vector();
    let policy = input.policy.as_protocol();
    let deny = RuleRef {
        subject: "doctor:lee",
        scope: "patient:ada",
        facet: "patient-notes",
        actions: &[Action::Read],
        effect: Effect::Deny,
        origin: None,
    };
    assert!(!policy.allows_with(
        &[deny],
        "doctor:lee",
        "patient:ada",
        "patient-notes",
        Action::Read
    ));
    let allow = RuleRef {
        subject: "doctor:suspended",
        scope: "patient:ada",
        facet: "patient-notes",
        actions: &[Action::Read],
        effect: Effect::Allow,
        origin: None,
    };
    assert!(!policy.allows_with(
        &[allow],
        "doctor:suspended",
        "patient:ada",
        "patient-notes",
        Action::Read
    ));
}

#[test]
fn browser_migration_seal_and_streamed_inventory_verify_without_sortsys() {
    use sortsys_zerotrust::migration::{MigrationInventory, MigrationSeal};
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../test/fixtures/migration-completion.json"
    ))
    .unwrap();
    let seal: MigrationSeal = serde_json::from_value(fixture["seal"].clone()).unwrap();
    let mut inventory = MigrationInventory::default();
    for entry in fixture["entries"].as_array().unwrap() {
        inventory
            .add(
                entry["kind"].as_str().unwrap(),
                entry["id"].as_str().unwrap(),
                entry["revision"].as_str().unwrap(),
                entry["hash"].as_str().unwrap(),
            )
            .unwrap();
    }
    assert_eq!(inventory.finish(), seal.source);
    assert_eq!(MigrationInventory::default().finish(), seal.target);
    assert_eq!(
        sortsys_zerotrust::crypto::encode(&seal.frame().unwrap()),
        fixture["frame"].as_str().unwrap()
    );
    let key = sized::<32>(fixture["identity"]["signingKey"].as_str().unwrap()).unwrap();
    seal.verify(&key).unwrap();
    let mut changed = seal.clone();
    changed.target = seal.source.clone();
    assert!(changed.verify(&key).is_err());
    changed = seal.clone();
    changed.generation = "4".into();
    assert!(changed.verify(&key).is_err());
    let mut inventory = MigrationInventory::default();
    let hash = &seal.source.hash;
    inventory.add("record", "z", "0", hash).unwrap();
    assert!(inventory.add("record", "a", "0", hash).is_err());
    assert!(inventory.add("record", "z", "0", hash).is_err());
    assert!(inventory.add("record", "zz", "01", hash).is_err());
}

#[test]
fn browser_catalog_grants_bind_ciphertext_action_and_authority_generation() {
    use sortsys_zerotrust::{
        crypto::encode,
        recovery::{CatalogAction, RecoveryCatalogAccess},
    };
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../test/fixtures/recovery-catalog-access.json"
    ))
    .unwrap();
    let mut access: RecoveryCatalogAccess =
        serde_json::from_value(fixture["access"].clone()).unwrap();
    let key = sized::<32>(fixture["signingKey"].as_str().unwrap()).unwrap();
    let proof = fixture["proof"].as_str().unwrap();
    let message = access.frame().unwrap();
    assert_eq!(encode(&message), fixture["frame"].as_str().unwrap());
    verify(&key, proof, &message).unwrap();
    access.action = CatalogAction::Read;
    assert!(verify(&key, proof, &access.frame().unwrap()).is_err());
    access.action = CatalogAction::Write;
    access.target_generation = "2".into();
    assert!(access.frame().is_err());
    access.target_generation = "4".into();
    assert!(access.frame().is_err());
}
