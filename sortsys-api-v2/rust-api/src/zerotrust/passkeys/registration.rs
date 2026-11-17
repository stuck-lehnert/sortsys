use super::*;

pub(super) async fn list(
    service: &AuthService,
    request: &RequestContext,
) -> RpcResult<Vec<PasskeyListItem>> {
    let auth = service.authenticate(&request.headers).await?;
    let repository = service.records()?.tenant(&auth.tenant)?;
    let mut transaction = repository.transaction()?;
    let (account, _) = accounts::checked_session(&mut transaction, &auth).await?;
    let root = setup::metadata_root(&mut transaction, &auth.tenant).await?;
    let mut result = Vec::new();
    for record in directory(&mut transaction, account.id).await? {
        if record.deleted_at.is_some() || record.generation != root.profile.authority.generation {
            continue;
        }
        record.verify_identity(&account)?;
        result.push(PasskeyListItem {
            id: Id(record.id),
            credential_id: record.registration.raw_id,
            identity_proof: record.identity_proof,
            label: record.label,
            created_at: record.created_at,
            last_used_at: record.last_used_at,
            opens_data: record.key_vault.is_some(),
        });
    }
    result.sort_by(|a, b| {
        b.created_at
            .cmp(&a.created_at)
            .then_with(|| b.id.0.cmp(&a.id.0))
    });
    transaction.validate().await?;
    Ok(result)
}

pub(super) async fn options(
    service: &AuthService,
    request: &RequestContext,
) -> RpcResult<RegistrationOptionsOutput> {
    let _admission = auth_limits::admit_login()?;
    let origin = origin(service, request)?;
    let auth = service.authenticate(&request.headers).await?;
    let repository = service.records()?.tenant(&auth.tenant)?;
    let mut transaction = repository.transaction()?;
    let (account, tenant) = accounts::checked_session(&mut transaction, &auth).await?;
    let root = setup::metadata_root(&mut transaction, &auth.tenant).await?;
    let mut excluded = Vec::new();
    for record in directory(&mut transaction, account.id).await? {
        if record.deleted_at.is_none()
            && record.generation == root.profile.authority.generation
            && record.rp_id == origin.rp_id
        {
            record.verify_identity(&account)?;
            excluded.push(webauthn::CredentialDescriptor::public_key(
                record.registration.raw_id,
                record.registration.transports.unwrap_or_default(),
            ));
        }
    }
    let mut claims = Challenge::new(Purpose::Register, origin)?;
    claims.registration = Some(RegistrationContext {
        tenant: auth.tenant.clone(),
        user_id: account.id,
        session_id: auth.session.id.parse().map_err(|_| denied())?,
        credential_revision: account.credential()?.revision,
        account_epoch: account.epoch,
        tenant_epoch: tenant.epoch,
        authority_generation: root.profile.authority.generation,
    });
    let output = RegistrationOptionsOutput {
        challenge_token: service.issue_challenge_token(&claims)?,
        options: CreationOptions {
            challenge: claims.challenge,
            rp: RelyingParty {
                name: "sortsys".into(),
                id: origin.rp_id.clone(),
            },
            user: PasskeyUser {
                id: user_handle(&auth.tenant, account.id)?,
                name: format!("{}@{}", account.username, auth.tenant),
                display_name: account.username,
            },
            pub_key_cred_params: vec![CredentialParameter {
                r#type: "public-key".into(),
                alg: -7,
            }],
            timeout: webauthn::TIMEOUT_MS,
            attestation: "none".into(),
            authenticator_selection: AuthenticatorSelection {
                resident_key: "required".into(),
                require_resident_key: true,
                user_verification: "required".into(),
            },
            exclude_credentials: excluded,
        },
    };
    transaction.validate().await?;
    Ok(output)
}

pub(super) async fn finish(
    service: &AuthService,
    request: &RequestContext,
    input: PasskeyRegistrationInput,
) -> RpcResult<Success> {
    let _admission = auth_limits::admit_login()?;
    let claims = challenge(service, request, &input.challenge_token, Purpose::Register)?;
    let origin = origin(service, request)?;
    let auth = service.authenticate(&request.headers).await?;
    let registered = webauthn::verify_registration(&input.credential, &claims.challenge, origin)?;
    let repository = service.records()?.tenant(&auth.tenant)?;
    let mut transaction = repository.transaction()?;
    let (account, tenant) = accounts::checked_session(&mut transaction, &auth).await?;
    let attempt = service
        .reserve_login("passkey-register", &[&auth.tenant, &account.id.to_string()])
        .await?;
    let root = setup::metadata_root(&mut transaction, &auth.tenant).await?;
    let expected = claims.registration.as_ref().ok_or_else(denied)?;
    if expected.tenant != auth.tenant
        || expected.user_id != account.id
        || expected.session_id.to_string() != auth.session.id
        || expected.account_epoch != account.epoch
        || expected.tenant_epoch != tenant.epoch
        || expected.credential_revision != account.credential()?.revision
        || expected.authority_generation != root.profile.authority.generation
    {
        return Err(denied());
    }
    let id = accounts::random_id()?;
    let now = Utc::now();
    let mut record = StoredPasskey {
        id,
        tenant: auth.tenant.clone(),
        user_id: account.id,
        generation: root.profile.authority.generation.clone(),
        user_handle: user_handle(&auth.tenant, account.id)?,
        label: input.label,
        origin: origin.value.clone(),
        rp_id: origin.rp_id.clone(),
        registration: input.credential,
        registration_challenge: claims.challenge.clone(),
        exchange_hash: hash(input.challenge_token.as_bytes()),
        identity_proof: input.identity_proof,
        key_vault: input.key_vault,
        counter: 0,
        backup_eligible: false,
        backed_up: false,
        created_at: now,
        last_used_at: None,
        deleted_at: None,
    };
    record.set_state(registered.state);
    record.verify_identity(&account)?;
    let index = index_key(&origin.rp_id, &registered.credential_id);
    transaction
        .prefetch(vec![index.clone(), passkey_key(id)])
        .await?;
    if transaction
        .read::<StoredPasskey>(passkey_key(id))
        .await?
        .is_some()
    {
        return Err(crate::control::conflict());
    }
    if let Some(previous) = transaction.read::<i64>(index.clone()).await? {
        let existing: StoredPasskey = transaction
            .read(passkey_key(previous))
            .await?
            .ok_or_else(denied)?;
        if existing.user_id != account.id
            || existing.tenant != auth.tenant
            || existing.rp_id != origin.rp_id
            || existing.registration.raw_id != registered.credential_id
            || (existing.deleted_at.is_none() && existing.generation == record.generation)
        {
            return Err(crate::control::conflict());
        }
    }
    let records = directory(&mut transaction, account.id).await?;
    let mut active: Vec<i64> = records
        .iter()
        .filter(|record| {
            record.deleted_at.is_none() && record.generation == root.profile.authority.generation
        })
        .map(|record| record.id)
        .collect();
    if active.len() >= MAX_PASSKEYS {
        return Err(RpcError::new(ErrorCode::BadRequest, "Too many passkeys"));
    }
    active.push(id);
    // Credential IDs must be unique across every tenant sharing this RP. A
    // permanent public ownership reservation precedes publication in the tenant
    // file. A failed local commit grants no login and the same owner can retry.
    consume(&mut transaction, &claims).await?;
    reserve_owner(service, &record).await?;
    transaction.put_protected(passkey_key(id), &record).await?;
    transaction
        .put_protected(directory_key(account.id), &active)
        .await?;
    transaction.put(index, &id).await?;
    security_event(&mut transaction, &accounts::subject(account.id))?;
    transaction.commit().await?;
    attempt.succeeded(service.records()?).await;
    Ok(Success { success: true })
}

pub(super) async fn delete(
    service: &AuthService,
    request: &RequestContext,
    input: DeleteInput,
) -> RpcResult<Success> {
    let auth = service.authenticate(&request.headers).await?;
    let repository = service.records()?.tenant(&auth.tenant)?;
    let mut transaction = repository.transaction()?;
    let (account, _) = accounts::checked_session(&mut transaction, &auth).await?;
    let mut record: StoredPasskey = transaction
        .read(passkey_key(input.id.0))
        .await?
        .ok_or_else(denied)?;
    record.verify_identity(&account)?;
    verify(
        &sized::<32>(&account.credential()?.vault.signing_key)?,
        &input.identity_proof,
        &webauthn::deletion_frame(
            &auth.tenant,
            &accounts::subject(account.id),
            &input.id.encode(),
        )?,
    )?;
    if record.deleted_at.is_none() {
        record.deleted_at = Some(Utc::now());
        let active: Vec<i64> = directory(&mut transaction, account.id)
            .await?
            .iter()
            .filter(|key| key.id != input.id.0 && key.deleted_at.is_none())
            .map(|key| key.id)
            .collect();
        transaction
            .put_protected(passkey_key(record.id), &record)
            .await?;
        transaction
            .put_protected(directory_key(account.id), &active)
            .await?;
        security_event(&mut transaction, &accounts::subject(account.id))?;
        transaction.commit().await?;
    } else {
        transaction.validate().await?;
    }
    Ok(Success { success: true })
}
