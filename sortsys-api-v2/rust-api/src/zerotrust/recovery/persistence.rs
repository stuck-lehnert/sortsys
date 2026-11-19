//! Recovery is one atomic tenant commit, without a cross-database cutover.
use super::super::{
    objects::{AuthorityHistory, registry},
    setup::{self, RootState},
};
use super::*;
use crate::{
    auth::AuthService,
    control::{Repository, Transaction, accounts, key, tenants},
};
use chrono::{DateTime, Utc};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Challenge {
    pub generation: String,
    pub nonce: String,
    pub expires_at: DateTime<Utc>,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Receipt {
    hash: String,
    generation: String,
    authority_signature: String,
}
fn challenge_key(id: &str) -> RpcResult<sortsys_zerotrust::metadata::RecordKey> {
    identifier(id)?;
    Ok(key("recovery-challenges", id))
}
pub(super) async fn repository(service: &AuthService, tenant: &str) -> RpcResult<Repository> {
    tenants::published_repository(service.records()?, tenant).await
}
pub(super) fn snapshot(root: &RootState) -> RpcResult<String> {
    let inventory = InventorySnapshot {
        generation: revision(&root.profile.authority.generation)?,
        catalog_version: revision(&root.catalog_version)?,
        policy_version: revision(&root.policy_version)?,
    };
    inventory.ensure_current(inventory.generation)?;
    Ok(inventory.id())
}
pub(super) async fn challenge(
    transaction: &mut Transaction,
    root: &RootState,
    id: &str,
) -> RpcResult<Challenge> {
    let challenge: Challenge = transaction
        .read(challenge_key(id)?)
        .await?
        .ok_or_else(conflict)?;
    if challenge.generation != root.profile.authority.generation
        || challenge.expires_at <= Utc::now()
    {
        return Err(conflict());
    }
    sized::<32>(&challenge.nonce)?;
    Ok(challenge)
}
fn verify_seed(root: &RootState, proof: &str, message: &[u8]) -> RpcResult<()> {
    verify(
        &sized::<32>(&root.profile.authority.recovery_signing_key)?,
        proof,
        message,
    )
}
fn plan_hash(plan: &RecoveryPlan) -> RpcResult<String> {
    Ok(encode(&Sha256::digest(
        serde_json::to_vec(plan).map_err(internal)?,
    )))
}

async fn prefetch_publication(
    transaction: &mut Transaction,
    plan: &RecoveryPlan,
    owner: i64,
) -> RpcResult<()> {
    let generation = &plan.next_setup.authority.generation;
    let version = &plan.next_setup.policy.version;
    let mut protected = vec![
        accounts::account_key(owner),
        accounts::tenant_key(),
        super::inventory::record_key(),
        key(
            "authority-history",
            &format!("{:020}", revision(generation)?),
        ),
        setup::identity_history_key(&plan.next_setup.owner)?,
        setup::identity_head_key(&plan.next_setup.owner)?,
        key("policies", version),
        key("policy-generations", version),
    ];
    for envelope in &plan.old_key_envelopes {
        protected.push(registry::envelope_key(
            &envelope.object,
            &envelope.generation,
            &envelope.recipient,
        )?);
    }
    for definition in &plan.domains {
        protected.push(registry::domain_access_key(&definition.id));
        protected.push(registry::definition_key(
            &definition.id,
            &definition.generation,
            generation,
        )?);
        for envelope in &definition.envelopes {
            protected.push(registry::envelope_key(
                &definition.id,
                &definition.generation,
                &envelope.recipient,
            )?);
        }
        protected.push(registry::recovery_key(&registry::RecoveryKeyReference {
            domain: definition.id.clone(),
            generation: definition.generation.clone(),
            authority_generation: generation.clone(),
        })?);
    }
    transaction.prefetch_protected(protected).await?;
    transaction
        .prefetch(vec![
            key("usernames", &plan.username),
            key("member-directory", &format!("{owner:020}")),
        ])
        .await
}
async fn public_head(service: &AuthService, input: TenantInput) -> RpcResult<RecoveryHead> {
    let root = setup::public_root(service.records()?, &input.tenant).await?;
    Ok(RecoveryHead {
        phase: "active".into(),
        generation: root.profile.authority.generation.clone(),
        authority: root.profile.authority,
        operation: None,
    })
}
async fn account_lookup(
    service: &AuthService,
    input: InspectInput,
) -> RpcResult<Option<ExistingAccount>> {
    let _admission = crate::auth_limits::admit_login()?;
    let message = sortsys_zerotrust::recovery::account_lookup_frame(
        &input.tenant,
        &input.generation,
        &input.nonce,
    )?;
    let repository = repository(service, &input.tenant).await?;
    let mut transaction = repository.transaction()?;
    let root = setup::metadata_root(&mut transaction, &input.tenant).await?;
    if input.generation != root.profile.authority.generation {
        return Err(conflict());
    }
    verify_seed(&root, &input.proof, &message)?;
    let result = super::account::describe(&mut transaction, &root).await?;
    transaction.validate().await?;
    Ok(result)
}
async fn member_lookup(
    service: &AuthService,
    input: MemberLookupInput,
) -> RpcResult<Option<ExistingAccount>> {
    let _admission = crate::auth_limits::admit_login()?;
    let message = sortsys_zerotrust::recovery::member_lookup_frame(
        &input.tenant,
        &input.generation,
        &input.username,
        &input.nonce,
    )?;
    let repository = repository(service, &input.tenant).await?;
    let mut transaction = repository.transaction()?;
    let root = setup::metadata_root(&mut transaction, &input.tenant).await?;
    if input.generation != root.profile.authority.generation {
        return Err(conflict());
    }
    verify_seed(&root, &input.proof, &message)?;
    let result = super::account::describe_member(&mut transaction, &root, &input.username).await?;
    transaction.validate().await?;
    Ok(result)
}
async fn source(service: &AuthService, input: InspectInput) -> RpcResult<RecoverySourceHead> {
    let _admission = crate::auth_limits::admit_login()?;
    sized::<32>(&input.nonce)?;
    let repository = repository(service, &input.tenant).await?;
    let mut transaction = repository.transaction()?;
    let root = setup::metadata_root(&mut transaction, &input.tenant).await?;
    if input.generation != root.profile.authority.generation {
        return Err(conflict());
    }
    verify_seed(
        &root,
        &input.proof,
        &frame(
            "sortsys/recovery-inspect/v1",
            &[&input.tenant, &input.generation, &input.nonce],
        ),
    )?;
    let expiry_collection = format!("recovery-challenge-expiry-{}", input.generation);
    let mut after = Some(format!("{:020}", Utc::now().timestamp() + 1));
    let mut active = 0;
    loop {
        let page = transaction
            .scan::<String>(&expiry_collection, after)
            .await?;
        active += page.records.len();
        if active >= 128 {
            return Err(
                RpcError::new(ErrorCode::TooManyRequests, "Too many recovery challenges")
                    .with_http_code(429),
            );
        }
        after = page.after;
        if after.is_none() {
            break;
        }
    }
    let id = random_id()?;
    let mut nonce = [0; 32];
    getrandom::fill(&mut nonce).map_err(|_| invalid())?;
    let challenge = Challenge {
        generation: input.generation,
        nonce: encode(&nonce),
        expires_at: Utc::now() + chrono::Duration::minutes(15),
    };
    let challenge_record = challenge_key(&id)?;
    if transaction
        .read::<Value>(challenge_record.clone())
        .await?
        .is_some()
    {
        return Err(conflict());
    }
    transaction
        .put_expiring(challenge_record, &challenge, challenge.expires_at)
        .await?;
    transaction
        .put_expiring(
            key(
                &expiry_collection,
                &format!("{:020}:{id}", challenge.expires_at.timestamp()),
            ),
            &id,
            challenge.expires_at,
        )
        .await?;
    let output = RecoverySourceHead {
        challenge_id: id,
        challenge: challenge.nonce,
        snapshot: snapshot(&root)?,
        authority: root.profile.authority,
        catalog: root.profile.catalog,
        catalog_version: root.catalog_version,
        policy_version: root.policy_version,
    };
    transaction.commit().await?;
    Ok(output)
}
async fn registration(
    service: &AuthService,
    input: RegistrationInput,
) -> RpcResult<RegistrationOutput> {
    if let Some(version) = &input.account_version {
        sized::<32>(version)?;
    }
    let _admission = crate::auth_limits::admit_login()?;
    identifier(&input.username)?;
    let owner = input
        .subject
        .strip_prefix("user:")
        .and_then(|value| Id::decode(value).ok())
        .filter(|id| id.0 > 0 && accounts::subject(id.0) == input.subject)
        .ok_or_else(invalid)?;
    if input.account_version.is_none() && input.username != format!("recovery-{}", owner.encode()) {
        return Err(invalid());
    }
    let repository = repository(service, &input.tenant).await?;
    let mut transaction = repository.transaction()?;
    let root = setup::metadata_root(&mut transaction, &input.tenant).await?;
    challenge(&mut transaction, &root, &input.challenge_id).await?;
    let message = if input.member == Some(true) {
        let account = sortsys_zerotrust::recovery::ExistingRecoveryAccount {
            subject: input.subject.clone(),
            username: input.username.clone(),
            version: input.account_version.clone().ok_or_else(invalid)?,
        };
        sortsys_zerotrust::recovery::member_registration_frame(
            &input.tenant,
            &input.challenge_id,
            &account,
            &input.registration_request,
        )?
    } else {
        frame(
            "sortsys/recovery-registration/v3",
            &[
                &input.tenant,
                &input.challenge_id,
                &input.username,
                &input.subject,
                &input.registration_request,
                input.account_version.as_deref().unwrap_or(""),
            ],
        )
    };
    verify_seed(&root, &input.proof, &message)?;
    if input.member == Some(true) {
        super::account::member_target(
            &mut transaction,
            &root,
            &input.subject,
            &input.username,
            input.account_version.as_deref().ok_or_else(invalid)?,
        )
        .await?;
    } else {
        super::account::target(
            &mut transaction,
            &root,
            &input.subject,
            &input.username,
            input.account_version.as_deref(),
        )
        .await?;
    }
    let response = recovery_registration(
        &repository,
        &input.tenant,
        &input.subject,
        &input.registration_request,
    )
    .await?;
    transaction.validate().await?;
    Ok(RegistrationOutput {
        registration_response: response,
    })
}
pub(super) async fn begin(service: &AuthService, input: RecoveryPlan) -> RpcResult<Success> {
    let _admission = crate::auth_limits::admit_login()?;
    identifier(&input.transition.operation)?;
    // Public proofs are checked before reading the full key inventory.
    validate_plan(&input).await?;
    let tenant = &input.transition.tenant;
    let repository = repository(service, tenant).await?;
    let mut transaction = repository.transaction()?;
    let root = setup::metadata_root(&mut transaction, tenant).await?;
    let receipt_key = key("recovery-operations", &input.transition.operation);
    let hash = plan_hash(&input)?;
    if let Some(receipt) = transaction.read::<Receipt>(receipt_key.clone()).await? {
        if receipt.hash != hash
            || receipt.generation != root.profile.authority.generation
            || receipt.authority_signature != root.profile.authority.signature
        {
            return Err(conflict());
        }
        transaction.validate().await?;
        return Ok(Success { success: true });
    }
    if serde_json::to_value(&root.profile.authority).map_err(internal)?
        != serde_json::to_value(&input.source_authority).map_err(internal)?
        || root.profile.authority.generation != input.transition.generation
        || root.catalog_version != input.transition.catalog_version
        || revision(&root.policy_version)?.checked_add(1)
            != Some(revision(&input.next_setup.policy.version)?)
    {
        return Err(conflict());
    }
    let grant = challenge(&mut transaction, &root, &input.challenge_id).await?;
    if grant.nonce != input.transition.challenge {
        return Err(conflict());
    }
    let descriptors = registry::retained_catalog(&mut transaction).await?;
    if descriptors.len() != input.domains.len() {
        return Err(conflict());
    }
    transaction
        .prefetch(
            descriptors
                .iter()
                .flat_map(|descriptor| registry::domain_keys(&descriptor.id))
                .collect(),
        )
        .await?;
    let next_domains = input
        .domains
        .iter()
        .map(|domain| (domain.id.as_str(), domain))
        .collect::<BTreeMap<_, _>>();
    let mut domains = BTreeMap::new();
    for descriptor in descriptors {
        let current = registry::retained_domain(&mut transaction, &descriptor.id).await?;
        let next = next_domains.get(current.id.as_str()).ok_or_else(conflict)?;
        if current.scope != descriptor.scope
            || current.facet != descriptor.facet
            || current.scope != next.scope
            || current.facet != next.facet
            || revision(&current.generation)?.checked_add(1) != Some(revision(&next.generation)?)
        {
            return Err(conflict());
        }
        domains.insert(current.id.clone(), current);
    }
    let owner = input.owner_id()?;
    prefetch_publication(&mut transaction, &input, owner.0).await?;
    let previous_account = super::account::target(
        &mut transaction,
        &root,
        &input.next_setup.owner.user,
        &input.username,
        input.account_version.as_deref(),
    )
    .await?;
    let mut member_accounts = Vec::new();
    for member in input.members.iter().flatten() {
        member_accounts.push(
            super::account::member_target(
                &mut transaction,
                &root,
                &member.account.subject,
                &member.account.username,
                &member.account.version,
            )
            .await?,
        );
    }
    // The API proves public coverage, not the plaintext inside an envelope.
    let supplied = input
        .old_key_envelopes
        .iter()
        .map(|envelope| (envelope.object.as_str(), envelope.generation.as_str()))
        .collect::<BTreeSet<_>>();
    let expected = domains
        .values()
        .flat_map(|domain| {
            domain
                .definitions
                .keys()
                .map(move |generation| (domain.id.as_str(), generation.as_str()))
        })
        .collect::<BTreeSet<_>>();
    if supplied != expected {
        return Err(invalid());
    }
    super::inventory::reserve_recovery(&mut transaction, domains.len(), expected.len()).await?;
    let generation = input.next_setup.authority.generation.clone();
    let now = Utc::now();
    let credential_revision = match &previous_account {
        Some(account) => account.credential()?.revision,
        None => 0,
    }
    .checked_add(1)
    .ok_or_else(conflict)?;
    let mut account = previous_account.unwrap_or_else(|| accounts::Account {
        id: owner.0,
        username: input.username.clone(),
        locale: "de".into(),
        epoch: 0,
        roles: vec![],
        created_at: now,
        modified_at: now,
        deactivated_at: None,
        archived_at: None,
        deleted_at: None,
        credential: None,
    });
    account.epoch = account.epoch.checked_add(1).ok_or_else(conflict)?;
    account.roles = vec![":admin".into()];
    account.modified_at = now;
    account.credential = Some(accounts::Credential {
        revision: credential_revision,
        record: encode(&validate_registration(&input.registration_record)?),
        vault: input.vault.clone(),
        certificate: serde_json::to_value(&input.next_setup.owner).map_err(internal)?,
    });
    transaction
        .put_protected(accounts::account_key(owner.0), &account)
        .await?;
    transaction
        .put(
            key("usernames", &input.username),
            &accounts::Username { user_id: owner.0 },
        )
        .await?;
    transaction
        .put(
            key("member-directory", &format!("{:020}", owner.0)),
            &owner.0,
        )
        .await?;
    super::super::passkeys::retire_account_credentials(&mut transaction, owner.0).await?;
    for (member, mut account) in input.members.iter().flatten().zip(member_accounts) {
        account.epoch = account.epoch.checked_add(1).ok_or_else(conflict)?;
        account.roles.clear();
        account.modified_at = now;
        account.credential = Some(accounts::Credential {
            revision: account
                .credential()?
                .revision
                .checked_add(1)
                .ok_or_else(conflict)?,
            record: encode(&validate_registration(&member.registration_record)?),
            vault: member.vault.clone(),
            certificate: serde_json::to_value(&member.certificate).map_err(internal)?,
        });
        super::super::passkeys::retire_account_credentials(&mut transaction, account.id).await?;
        transaction
            .put_protected(accounts::account_key(account.id), &account)
            .await?;
        setup::append_identity(
            &mut transaction,
            &member.certificate,
            &sized::<32>(&input.next_setup.authority.authority_signing_key)?,
        )
        .await?;
    }
    let authority_key = key(
        "authority-history",
        &format!("{:020}", revision(&generation)?),
    );
    if transaction
        .read::<Value>(authority_key.clone())
        .await?
        .is_some()
    {
        return Err(conflict());
    }
    transaction.put_protected(authority_key, &AuthorityHistory {
        certificate: input.next_setup.authority.clone(),
        transition: Some(serde_json::json!({"sourceAuthority": input.source_authority, "transition": input.transition, "proof": input.proof, "nextProof": input.next_proof})),
    }).await?;
    setup::append_identity(
        &mut transaction,
        &input.next_setup.owner,
        &sized::<32>(&input.next_setup.authority.authority_signing_key)?,
    )
    .await?;
    let version = &input.next_setup.policy.version;
    if transaction
        .read::<Value>(key("policies", version))
        .await?
        .is_some()
    {
        return Err(conflict());
    }
    transaction
        .put_protected(key("policies", version), &input.next_setup.policy)
        .await?;
    transaction
        .put_protected(key("policy-generations", version), &generation)
        .await?;
    for envelope in &input.old_key_envelopes {
        transaction
            .put_protected(
                registry::envelope_key(
                    &envelope.object,
                    &envelope.generation,
                    &envelope.recipient,
                )?,
                envelope,
            )
            .await?;
        domains
            .get_mut(&envelope.object)
            .ok_or_else(invalid)?
            .recipients
            .entry(envelope.generation.clone())
            .or_default()
            .insert(envelope.recipient.clone());
    }
    for definition in &input.domains {
        let domain = domains.get_mut(&definition.id).ok_or_else(invalid)?;
        domain.generation = definition.generation.clone();
        domain.policy_version = version.clone();
        domain.sequence = revision(&domain.sequence)?
            .checked_add(1)
            .ok_or_else(conflict)?
            .to_string();
        domain
            .definitions
            .entry(definition.generation.clone())
            .or_default()
            .push(generation.clone());
        domain.recipients.insert(
            definition.generation.clone(),
            BTreeSet::from([input.transition.next_administrator.clone()]),
        );
        transaction
            .put_protected(
                registry::definition_key(&definition.id, &definition.generation, &generation)?,
                definition,
            )
            .await?;
        for envelope in &definition.envelopes {
            transaction
                .put_protected(
                    registry::envelope_key(
                        &definition.id,
                        &definition.generation,
                        &envelope.recipient,
                    )?,
                    envelope,
                )
                .await?;
        }
        let reference = registry::RecoveryKeyReference {
            domain: definition.id.clone(),
            generation: definition.generation.clone(),
            authority_generation: generation.clone(),
        };
        transaction
            .put_protected(registry::recovery_key(&reference)?, &reference)
            .await?;
        registry::publish_domain(&mut transaction, domain).await?;
    }
    let mut status: accounts::TenantStatus = transaction
        .read(accounts::tenant_key())
        .await?
        .ok_or_else(conflict)?;
    status.epoch = status.epoch.checked_add(1).ok_or_else(conflict)?;
    transaction
        .put_protected(accounts::tenant_key(), &status)
        .await?;
    catalog::protect_published_pages(
        &mut transaction,
        &input.challenge_id,
        &input.next_setup.authority,
    )
    .await?;
    setup::write_root(
        &mut transaction,
        &RootState {
            policy_version: version.clone(),
            catalog_version: revision(&root.catalog_version)?
                .checked_add(1)
                .ok_or_else(conflict)?
                .to_string(),
            profile: input.next_setup.clone(),
        },
    )
    .await?;
    transaction
        .anchor("authority", &input.next_setup.authority)
        .await?;
    transaction
        .put(
            receipt_key,
            &Receipt {
                hash,
                generation: generation.clone(),
                authority_signature: input.next_setup.authority.signature,
            },
        )
        .await?;
    transaction
        .delete(challenge_key(&input.challenge_id)?)
        .await?;
    transaction.notify("recovery", &serde_json::json!({"generation": generation}))?;
    transaction.commit().await?;
    Ok(Success { success: true })
}
async fn resume(service: &AuthService, input: ResumeInput) -> RpcResult<Success> {
    identifier(&input.operation)?;
    let repository = repository(service, &input.tenant).await?;
    let mut transaction = repository.transaction()?;
    let root = setup::metadata_root(&mut transaction, &input.tenant).await?;
    let receipt: Receipt = transaction
        .read(key("recovery-operations", &input.operation))
        .await?
        .ok_or_else(conflict)?;
    if receipt.generation != root.profile.authority.generation
        || receipt.authority_signature != root.profile.authority.signature
    {
        return Err(conflict());
    }
    transaction.validate().await?;
    Ok(Success { success: true })
}
pub(crate) fn register(
    builder: ProcedureRegistryBuilder,
    service: Arc<AuthService>,
) -> ProcedureRegistryBuilder {
    let builder = pages::register(builder, Arc::clone(&service));
    let builder = uploads::register(builder, Arc::clone(&service));
    let builder = catalog::register(builder, Arc::clone(&service));
    let header = Arc::clone(&service);
    let inspect = Arc::clone(&service);
    let lookup = Arc::clone(&service);
    let member = Arc::clone(&service);
    let enroll = Arc::clone(&service);
    let apply = Arc::clone(&service);
    builder
        .query("zerotrust.recovery.head", move |_, input: TenantInput| {
            let service = Arc::clone(&header);
            async move { public_head(&service, input).await }
        })
        .mutation(
            "zerotrust.recovery.inspect",
            move |_, input: InspectInput| {
                let service = Arc::clone(&inspect);
                async move { source(&service, input).await }
            },
        )
        .mutation(
            "zerotrust.recovery.account",
            move |_, input: InspectInput| {
                let service = Arc::clone(&lookup);
                async move { account_lookup(&service, input).await }
            },
        )
        .mutation(
            "zerotrust.recovery.member",
            move |_, input: MemberLookupInput| {
                let service = Arc::clone(&member);
                async move { member_lookup(&service, input).await }
            },
        )
        .mutation(
            "zerotrust.recovery.registration",
            move |_, input: RegistrationInput| {
                let service = Arc::clone(&enroll);
                async move { registration(&service, input).await }
            },
        )
        .mutation("zerotrust.recovery.begin", move |_, input: RecoveryPlan| {
            let service = Arc::clone(&apply);
            async move { begin(&service, input).await }
        })
        .mutation("zerotrust.recovery.resume", move |_, input: ResumeInput| {
            let service = Arc::clone(&service);
            async move { resume(&service, input).await }
        })
}
