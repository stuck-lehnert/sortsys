use super::*;

pub(super) async fn options(
    service: &AuthService,
    request: &RequestContext,
    input: Option<LoginOptionsInput>,
) -> RpcResult<LoginOptionsOutput> {
    let _admission = auth_limits::admit_login()?;
    let origin = origin(service, request)?;
    let mut claims = Challenge::new(Purpose::Login, origin)?;
    if let Some(hint) = input {
        let tenant = tenants::normalized_name(&hint.tenant)?;
        let username = hint.username.trim().to_lowercase();
        sortsys_zerotrust::crypto::identifier(&username)?;
        claims.hint = Some(LoginHint { tenant, username });
    }
    // Discoverable credentials carry a bounded opaque tenant/account locator.
    // Options therefore reveal neither account existence nor credential IDs.
    Ok(LoginOptionsOutput {
        challenge_token: service.issue_challenge_token(&claims)?,
        options: RequestOptions {
            challenge: claims.challenge,
            rp_id: origin.rp_id.clone(),
            allow_credentials: Vec::new(),
            timeout: webauthn::TIMEOUT_MS,
            user_verification: "required".into(),
        },
    })
}

pub(super) async fn finish(
    service: &AuthService,
    request: &RequestContext,
    input: LoginInput,
) -> RpcResult<PasskeyLoginOutput> {
    let _admission = auth_limits::admit_login()?;
    let claims = challenge(service, request, &input.challenge_token, Purpose::Login)?;
    webauthn::credential_id(
        &input.credential.id,
        &input.credential.raw_id,
        &input.credential.r#type,
    )?;
    let origin = origin(service, request)?;
    let handle = input
        .credential
        .response
        .user_handle
        .as_deref()
        .ok_or_else(denied)?;
    let (fingerprint, subject) = webauthn::parse_routing_user_handle(handle)?;
    let bytes: [u8; 8] = subject.try_into().map_err(|_| denied())?;
    let user = i64::from_be_bytes(bytes);
    if user <= 0 {
        return Err(denied());
    }
    let mut routing = service.records()?.transaction()?;
    let tenant_key = key("tenant-routes", &format!("t_{fingerprint}"));
    let owner_key = ownership_key(&origin.rp_id, &input.credential.raw_id);
    routing
        .prefetch(vec![tenant_key.clone(), owner_key.clone()])
        .await?;
    let tenant: String = routing.read(tenant_key).await?.ok_or_else(denied)?;
    let owner: Ownership = routing.read(owner_key).await?.ok_or_else(denied)?;
    if owner.tenant != tenant
        || owner.user_id != user
        || owner.rp_id != origin.rp_id
        || owner.credential_id != input.credential.raw_id
    {
        return Err(denied());
    }
    routing.validate().await?;
    if webauthn::tenant_fingerprint(&tenant)? != fingerprint
        || user_handle(&tenant, user)? != handle
    {
        return Err(denied());
    }
    let attempt = service
        .reserve_login("passkey-user", &[&tenant, &user.to_string()])
        .await?;
    let repository = tenants::published_repository(service.records()?, &tenant).await?;
    let mut transaction = repository.transaction()?;
    let index = index_key(&origin.rp_id, &input.credential.raw_id);
    transaction
        .prefetch(vec![
            accounts::account_key(user),
            accounts::tenant_key(),
            index.clone(),
        ])
        .await?;
    let account: accounts::Account = transaction
        .read(accounts::account_key(user))
        .await?
        .ok_or_else(denied)?;
    let status: accounts::TenantStatus = transaction
        .read(accounts::tenant_key())
        .await?
        .ok_or_else(denied)?;
    let id: i64 = transaction.read(index).await?.ok_or_else(denied)?;
    let mut record: StoredPasskey = transaction
        .read(passkey_key(id))
        .await?
        .ok_or_else(denied)?;
    let root = setup::metadata_root(&mut transaction, &tenant).await?;
    if !account.active(Utc::now())
        || !status.available(Utc::now())
        || account.id != user
        || record.id != id
        || record.user_id != user
        || record.tenant != tenant
        || record.rp_id != origin.rp_id
        || record.deleted_at.is_some()
        || record.generation != root.profile.authority.generation
        || record.registration.raw_id != input.credential.raw_id
        || claims
            .hint
            .as_ref()
            .is_some_and(|hint| hint.tenant != tenant || hint.username != account.username)
    {
        return Err(denied());
    }
    record.verify_identity(&account)?;
    let registered_origin = Origin::parse(&record.origin)?;
    if registered_origin.rp_id != record.rp_id {
        return Err(denied());
    }
    let registered = webauthn::verify_registration(
        &record.registration,
        &record.registration_challenge,
        &registered_origin,
    )?;
    let state = webauthn::verify_authentication(
        &input.credential,
        &registered,
        &claims.challenge,
        origin,
        &record.user_handle,
    )?;
    if record.backup_eligible != registered.state.backup_eligible {
        return Err(denied());
    }
    state.follows(&record.state())?;
    consume(&mut transaction, &claims).await?;
    record.set_state(state);
    record.last_used_at = Some(Utc::now());
    transaction.put_protected(passkey_key(id), &record).await?;
    let address = request
        .headers
        .get("x-forwarded-for")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(',').next())
        .map(str::trim);
    let user_agent = request
        .headers
        .get("user-agent")
        .and_then(|value| value.to_str().ok());
    let session =
        accounts::new_session(&mut transaction, &account, &status, address, user_agent).await?;
    transaction.commit().await?;
    attempt.succeeded(service.records()?).await;
    Ok(PasskeyLoginOutput {
        token: service
            .issue_user_token(&tenant, &session.id.to_string())
            .map_err(internal)?,
        tenant,
        subject: accounts::subject(account.id),
        username: account.username.clone(),
        account_vault: Some(account.credential()?.vault.clone()),
        key_vault: record.key_vault,
    })
}
