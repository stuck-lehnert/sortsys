//! Durable evidence and compare-and-swap leases shared by all API replicas.
use super::*;
use crate::{
    auth::AuthService,
    control::{Repository, Transaction, key},
    error::ErrorCode,
};
use chrono::{DateTime, Duration, Utc};
use sortsys_zerotrust::metadata::RecordKey;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredTarget {
    target: Target,
    artifact: Value,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Job {
    next_attempt: DateTime<Utc>,
    attempts: u32,
    lease: Option<String>,
    lease_expires: Option<DateTime<Utc>>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Queue {
    scope: String,
    kind: String,
}
fn queue_id(target: &Target) -> String {
    encode(&Sha256::digest(super::super::crypto::frame(
        "sortsys/timestamp-queue/v1",
        &[&target.scope, &target.kind],
    )))
}
fn index_key(scope: &str, object: &str, version: &str) -> sortsys_zerotrust::metadata::RecordKey {
    let index = encode(&Sha256::digest(super::super::crypto::frame(
        "sortsys/timestamp-index/v1",
        &[scope, object, version],
    )));
    key("timestamp-index", &format!("i_{index}"))
}
fn target_key(digest: &str) -> sortsys_zerotrust::metadata::RecordKey {
    key("timestamp-targets", &format!("t_{digest}"))
}
fn job_key(digest: &str) -> sortsys_zerotrust::metadata::RecordKey {
    key("timestamp-jobs", &format!("t_{digest}"))
}
fn due_key(target: &Target, when: DateTime<Utc>) -> sortsys_zerotrust::metadata::RecordKey {
    key(
        "timestamp-due",
        &format!(
            "q_{}:{:020}:{}",
            queue_id(target),
            when.timestamp_micros(),
            target.digest
        ),
    )
}
fn proof_collection(digest: &str) -> String {
    format!("timestamp-proofs-{digest}")
}
async fn record(
    transaction: &mut Transaction,
    target: Target,
    artifact: Value,
    protected: &[RecordKey],
) -> RpcResult<()> {
    let record_key = target_key(&target.digest);
    let record = StoredTarget { target, artifact };
    if let Some(previous) = transaction.read::<StoredTarget>(record_key.clone()).await? {
        if serde_json::to_value(previous).map_err(internal)?
            != serde_json::to_value(&record).map_err(internal)?
        {
            return Err(conflict());
        }
        return Ok(());
    }
    let target = &record.target;
    let index = index_key(&target.scope, &target.object, &target.revision);
    if transaction.read::<String>(index.clone()).await?.is_some() {
        return Err(conflict());
    }
    let queue_key = key("timestamp-queues", &format!("q_{}", queue_id(target)));
    let queue = Queue {
        scope: target.scope.clone(),
        kind: target.kind.clone(),
    };
    if let Some(previous) = transaction.read::<Queue>(queue_key.clone()).await? {
        if previous.scope != queue.scope || previous.kind != queue.kind {
            return Err(invalid());
        }
    } else {
        transaction.put(queue_key, &queue).await?;
    }
    let now = Utc::now();
    transaction.put(index.clone(), &target.digest).await?;
    transaction
        .put(
            job_key(&target.digest),
            &Job {
                next_attempt: now,
                attempts: 0,
                lease: None,
                lease_expires: None,
            },
        )
        .await?;
    transaction
        .put(due_key(target, now), &target.digest)
        .await?;
    transaction.put(record_key.clone(), &record).await?;
    let checkpoint_name = format!(
        "evidence-{}",
        encode(&Sha256::digest(super::super::crypto::frame(
            "sortsys/immutable-checkpoint/v1",
            &[&target.scope, &target.object],
        )))
    );
    let mut protected = protected.to_vec();
    protected.extend([record_key, index]);
    transaction
        .protect_records(&checkpoint_name, &protected)
        .await
}
pub(in crate::zerotrust) async fn record_object(
    transaction: &mut Transaction,
    envelope: &EncryptedObject,
    artifact: Value,
    protected: &[RecordKey],
) -> RpcResult<()> {
    if let Some(target) = object_target(envelope)? {
        record(transaction, target, artifact, protected).await?;
    }
    Ok(())
}
pub(in crate::zerotrust) async fn record_document(
    transaction: &mut Transaction,
    head: &DocumentHead,
    protected: &[RecordKey],
) -> RpcResult<()> {
    if let Some(target) = document_target(head)? {
        record(
            transaction,
            target,
            serde_json::to_value(head).map_err(internal)?,
            protected,
        )
        .await?;
    }
    Ok(())
}
async fn evidence(
    transaction: &mut Transaction,
    repository: &Repository,
    tenant: &str,
    stored: StoredTarget,
) -> RpcResult<Evidence> {
    let target = stored.target;
    if target.tenant != tenant {
        return Err(invalid());
    }
    let (artifact, expected) = if target.kind == "document" {
        let head: DocumentHead =
            serde_json::from_value(stored.artifact.clone()).map_err(|_| invalid())?;
        (stored.artifact, document_target(&head)?)
    } else {
        let reference: super::super::objects::CipherReference =
            serde_json::from_value(stored.artifact).map_err(|_| invalid())?;
        if reference.format != "sortsys-quack-ref-v1" {
            return Err(invalid());
        }
        let envelope = super::super::objects::metadata_read(repository, &reference.id).await?;
        let expected = object_target(&envelope)?;
        (serde_json::to_value(envelope).map_err(internal)?, expected)
    };
    if expected.as_ref() != Some(&target) {
        return Err(invalid());
    }
    let proofs = transaction
        .all::<String>(&proof_collection(&target.digest), 32)
        .await?;
    for proof in &proofs {
        super::super::ots::validate(
            &decode(proof, super::super::ots::MAX_BYTES)?,
            &sized::<32>(&target.digest)?,
        )?;
    }
    Ok(Evidence {
        target,
        artifact,
        proofs,
    })
}
fn requested_kind(input: &Get) -> RpcResult<String> {
    if input.object.starts_with("immutable:") {
        let prefix = format!("immutable:{}:", input.scope);
        let suffix = input.object.strip_prefix(&prefix).ok_or_else(invalid)?;
        let (facet, _) = suffix.split_once(':').ok_or_else(invalid)?;
        return Ok(format!("immutable-{facet}"));
    }
    if input.scope.starts_with("commercial:") {
        return Ok("document".into());
    }
    Ok("absence-request".into())
}
async fn get(
    service: &AuthService,
    request: &RequestContext,
    input: Get,
) -> RpcResult<Option<Evidence>> {
    identifier(&input.scope)?;
    identifier(&input.object)?;
    revision(&input.revision)?;
    let mut context = super::super::access::metadata_context(service, request).await?;
    if !readable(&context.security, &input.scope, &requested_kind(&input)?) {
        return Err(forbidden());
    }
    let digest: Option<String> = context
        .transaction
        .read(index_key(&input.scope, &input.object, &input.revision))
        .await?;
    let result = if let Some(digest) = digest {
        let stored: StoredTarget = context
            .transaction
            .read(target_key(&digest))
            .await?
            .ok_or_else(invalid)?;
        if stored.target.scope != input.scope
            || stored.target.object != input.object
            || stored.target.revision != input.revision
            || stored.target.digest != digest
        {
            return Err(invalid());
        }
        if !readable(&context.security, &stored.target.scope, &stored.target.kind) {
            return Err(forbidden());
        }
        Some(
            evidence(
                &mut context.transaction,
                &context.repository,
                &context.auth.tenant,
                stored,
            )
            .await?,
        )
    } else {
        None
    };
    context.transaction.validate().await?;
    Ok(result)
}

/// Queue enumeration is advisory: a newly inserted job can wait for the next
/// request. Claims themselves read the durable job and use its record version.
/// This avoids a tenant-wide scan lock when unrelated queues are processed.
async fn candidate(repository: &Repository, guard: &Security) -> RpcResult<Option<String>> {
    let mut after = None;
    let mut version = None;
    let mut earliest: Option<(String, String)> = None;
    let now = format!("{:020}", Utc::now().timestamp_micros());
    loop {
        let page = repository
            .scan::<Queue>("timestamp-queues", after, version)
            .await?;
        version = Some(page.version);
        for record in page.records {
            let queue = record.value.ok_or_else(invalid)?;
            if !readable(guard, &queue.scope, &queue.kind) {
                continue;
            }
            let prefix = format!("{}:", record.record.key);
            let due = repository
                .scan_prefix::<String>("timestamp-due", Some(&prefix), None, None, 1)
                .await?;
            let Some(first) = due.records.into_iter().next() else {
                continue;
            };
            let suffix = first.record.key.strip_prefix(&prefix).ok_or_else(invalid)?;
            let (time, digest) = suffix.split_once(':').ok_or_else(invalid)?;
            if time.len() != 20
                || !time.bytes().all(|byte| byte.is_ascii_digit())
                || time > now.as_str()
            {
                continue;
            }
            let value = first.value.ok_or_else(invalid)?;
            if value != digest {
                return Err(invalid());
            }
            let proposed = (time.to_owned(), value);
            if earliest
                .as_ref()
                .is_none_or(|previous| proposed < *previous)
            {
                earliest = Some(proposed);
            }
        }
        after = page.after;
        if after.is_none() {
            return Ok(earliest.map(|(_, digest)| digest));
        }
    }
}
async fn claim(service: &AuthService, request: &RequestContext) -> RpcResult<Option<Work>> {
    let mut context = super::super::access::metadata_context(service, request).await?;
    let Some(digest) = candidate(&context.repository, &context.security).await? else {
        context.transaction.validate().await?;
        return Ok(None);
    };
    let mut job: Job = context
        .transaction
        .read(job_key(&digest))
        .await?
        .ok_or_else(invalid)?;
    let stored: StoredTarget = context
        .transaction
        .read(target_key(&digest))
        .await?
        .ok_or_else(invalid)?;
    let now = Utc::now();
    if stored.target.digest != digest
        || !readable(&context.security, &stored.target.scope, &stored.target.kind)
    {
        return Err(forbidden());
    }
    if job.next_attempt > now || job.lease_expires.is_some_and(|expires| expires > now) {
        return Err(conflict());
    }
    let previous_due = due_key(&stored.target, job.next_attempt);
    let indexed: String = context
        .transaction
        .read(previous_due.clone())
        .await?
        .ok_or_else(conflict)?;
    if indexed != digest {
        return Err(invalid());
    }
    let result = evidence(
        &mut context.transaction,
        &context.repository,
        &context.auth.tenant,
        stored.clone(),
    )
    .await?;
    let lease = random_id()?;
    let expires = now + Duration::minutes(2);
    job.attempts = job.attempts.saturating_add(1).min(20);
    job.lease = Some(lease.clone());
    job.lease_expires = Some(expires);
    job.next_attempt = expires;
    context.transaction.delete(previous_due).await?;
    context
        .transaction
        .put(due_key(&stored.target, expires), &digest)
        .await?;
    context.transaction.put(job_key(&digest), &job).await?;
    context.transaction.commit().await?;
    Ok(Some(Work {
        lease,
        evidence: result,
    }))
}
async fn work(service: &AuthService, request: &RequestContext) -> RpcResult<Option<Work>> {
    for attempt in 0..4 {
        match claim(service, request).await {
            Err(error) if matches!(error.code, ErrorCode::Conflict) && attempt < 3 => continue,
            result => return result,
        }
    }
    unreachable!("Each final attempt returns its result")
}
async fn finish(service: &AuthService, request: &RequestContext, input: Finish) -> RpcResult<()> {
    let digest_bytes = sized::<32>(&input.digest)?;
    identifier(&input.lease)?;
    let proof = input
        .proof
        .as_ref()
        .map(|value| decode(value, super::super::ots::MAX_BYTES))
        .transpose()?;
    let pending = proof
        .as_ref()
        .map(|bytes| super::super::ots::validate(bytes, &digest_bytes))
        .transpose()?;
    let mut context = super::super::access::metadata_context(service, request).await?;
    let mut job: Job = context
        .transaction
        .read(job_key(&input.digest))
        .await?
        .ok_or_else(conflict)?;
    let stored: StoredTarget = context
        .transaction
        .read(target_key(&input.digest))
        .await?
        .ok_or_else(conflict)?;
    let now = Utc::now();
    if job.lease.as_deref() != Some(&input.lease)
        || !job.lease_expires.is_some_and(|expires| expires > now)
    {
        return Err(conflict());
    }
    if stored.target.digest != input.digest || stored.target.tenant != context.auth.tenant {
        return Err(invalid());
    }
    if !readable(&context.security, &stored.target.scope, &stored.target.kind) {
        return Err(forbidden());
    }
    if let Some(bytes) = proof {
        let collection = proof_collection(&input.digest);
        let known = context.transaction.all::<String>(&collection, 32).await?;
        let encoded = encode(&bytes);
        if !known.contains(&encoded) {
            if known.len() >= 32 {
                return Err(invalid());
            }
            let proof_hash = encode(&Sha256::digest(&bytes));
            let proof_key = key(&collection, &format!("p_{proof_hash}"));
            context.transaction.put(proof_key.clone(), &encoded).await?;
            context
                .transaction
                .protect_records(
                    &format!("timestamp-proof:{}:{proof_hash}", input.digest),
                    &[proof_key],
                )
                .await?;
        }
    }
    let delay = match pending {
        Some(true) => 21_600,
        Some(false) => 86_400,
        None => (60i64 * 2i64.pow(job.attempts.min(9))).min(21_600),
    };
    context
        .transaction
        .delete(due_key(&stored.target, job.next_attempt))
        .await?;
    job.next_attempt = now + Duration::seconds(delay);
    job.lease = None;
    job.lease_expires = None;
    if pending.is_some() {
        job.attempts = 0;
    }
    context
        .transaction
        .put(due_key(&stored.target, job.next_attempt), &input.digest)
        .await?;
    context
        .transaction
        .put(job_key(&input.digest), &job)
        .await?;
    context.transaction.commit().await?;
    Ok(())
}
pub(crate) fn register(
    builder: ProcedureRegistryBuilder,
    service: Arc<AuthService>,
) -> ProcedureRegistryBuilder {
    let get_service = Arc::clone(&service);
    let work_service = Arc::clone(&service);
    builder
        .query("zerotrust.timestamps.get", move |ctx, input: Get| {
            let service = Arc::clone(&get_service);
            async move { get(&service, &ctx, input).await }
        })
        .mutation("zerotrust.timestamps.work", move |ctx, _: ()| {
            let service = Arc::clone(&work_service);
            async move { work(&service, &ctx).await }
        })
        .mutation("zerotrust.timestamps.finish", move |ctx, input: Finish| {
            let service = Arc::clone(&service);
            async move { finish(&service, &ctx, input).await }
        })
}
