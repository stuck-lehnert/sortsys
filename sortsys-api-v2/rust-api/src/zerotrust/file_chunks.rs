//! Immutable ciphertext blocks; contents, names and manifests remain private.
use super::{
    access::security,
    crypto::{identifier, invalid},
    objects::{envelope_reference, persist_envelope, read_envelope},
    wire::{Action, EncryptedObject, Facet},
};
use crate::{
    AppState,
    api::Success,
    procedures::common::{authenticated_pool, forbidden, internal, not_found},
    rpc::ProcedureRegistryBuilder,
};
use serde::Deserialize;
use serde_json::Value;
use std::sync::Arc;
use ts_rs::TS;

#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct Put {
    domain: String,
    envelope: EncryptedObject,
}
#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct Get {
    domain: String,
    id: String,
}

fn chunk_prefix(domain: &str, scope: &str) -> crate::error::RpcResult<String> {
    let namespace = if scope == "organization" && domain == "organization:attachment" {
        "organization"
    } else {
        scope.strip_prefix("project:").ok_or_else(invalid)?
    };
    Ok(format!("file-data:{namespace}:"))
}

pub(super) fn register(
    builder: ProcedureRegistryBuilder,
    state: Arc<AppState>,
) -> ProcedureRegistryBuilder {
    let put = Arc::clone(&state);
    builder.mutation("zerotrust.fileChunks.put", move |ctx, input: Put| {
        let state = Arc::clone(&put);
        async move {
            identifier(&input.domain)?;
            let (auth, pool) = authenticated_pool(&state, &ctx).await?;
            let mut tx = pool.begin().await.map_err(internal)?;
            let guard = security(&mut tx, state.tenants.master(), &auth, false).await?;
            let area: Option<(String, String, i64, bool)> = sqlx::query_as("SELECT scope,facet,generation,rotation_required FROM __zerotrust_domains WHERE id=$1")
                .bind(&input.domain).fetch_optional(&mut *tx).await.map_err(internal)?;
            let (scope, facet, generation, rotating) = area.ok_or_else(forbidden)?;
            let prefix = chunk_prefix(&input.domain, &scope)?;
            let envelope = &input.envelope;
            if facet != Facet::Attachment.name() || envelope.facet != Facet::Attachment || envelope.scope != scope
                || envelope.tenant != auth.tenant || envelope.author != guard.subject || envelope.revision != "1"
                || !envelope.object.starts_with(&prefix) || envelope.ciphertext.len() > 1024 * 1024
                || !guard.allows(&guard.subject, &scope, Facet::Attachment, Action::Read)
                || !(guard.allows(&guard.subject, &scope, Facet::Attachment, Action::Create) || guard.allows(&guard.subject, &scope, Facet::Attachment, Action::Update)) { return Err(forbidden()); }
            envelope.verify(&guard.signing_key)?;
            // Independent replicas serialize immutable publication by ID. This
            // staging write deliberately does not advance the metadata head.
            sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))").bind(format!("sortsys:file-chunk:{}", envelope.object)).execute(&mut *tx).await.map_err(internal)?;
            let reference = envelope_reference(envelope)?;
            let previous: Option<(String, Value)> = sqlx::query_as("SELECT domain_id,envelope FROM __zerotrust_file_chunks WHERE id=$1")
                .bind(&envelope.object).fetch_optional(&mut *tx).await.map_err(internal)?;
            if let Some(old) = previous {
                if old != (input.domain, reference) { return Err(super::objects::conflict()); }
                return Ok(Success { success: true });
            }
            if rotating || envelope.generation != generation.to_string() || envelope.policy_version != guard.root.policy_version.to_string() { return Err(super::objects::conflict()); }
            persist_envelope(&state, &auth.tenant, envelope).await?;
            sqlx::query("INSERT INTO __zerotrust_file_chunks(id,domain_id,envelope) VALUES($1,$2,$3)")
                .bind(&envelope.object).bind(&input.domain).bind(reference).execute(&mut *tx).await.map_err(internal)?;
            tx.commit().await.map_err(internal)?;
            Ok(Success { success: true })
        }
    }).query("zerotrust.fileChunks.get", move |ctx, input: Get| {
        let state = Arc::clone(&state);
        async move {
            identifier(&input.domain)?; identifier(&input.id)?;
            let (auth, pool) = authenticated_pool(&state, &ctx).await?;
            let mut tx = pool.begin().await.map_err(internal)?;
            let guard = security(&mut tx, state.tenants.master(), &auth, false).await?;
            let scope: Option<String> = sqlx::query_scalar("SELECT scope FROM __zerotrust_domains WHERE id=$1 AND facet='attachment'")
                .bind(&input.domain).fetch_optional(&mut *tx).await.map_err(internal)?;
            let scope = scope.ok_or_else(forbidden)?;
            if !guard.allows(&guard.subject, &scope, Facet::Attachment, Action::Read) { return Err(forbidden()); }
            let reference: Value = sqlx::query_scalar("SELECT envelope FROM __zerotrust_file_chunks WHERE id=$1 AND domain_id=$2")
                .bind(&input.id).bind(&input.domain).fetch_optional(&mut *tx).await.map_err(internal)?.ok_or_else(not_found)?;
            let envelope = read_envelope(&state, &auth.tenant, reference).await?;
            if envelope.tenant != auth.tenant || envelope.scope != scope || envelope.facet != Facet::Attachment || envelope.object != input.id || envelope.revision != "1" { return Err(invalid()); }
            Ok(envelope)
        }
    })
}
pub(super) fn register_contract(builder: ProcedureRegistryBuilder) -> ProcedureRegistryBuilder {
    builder
        .mutation_stub::<Put, Success>("zerotrust.fileChunks.put")
        .query_stub::<Get, EncryptedObject>("zerotrust.fileChunks.get")
}

#[cfg(test)]
mod tests {
    use super::chunk_prefix;

    #[test]
    fn organization_assets_have_one_explicit_namespace() {
        assert_eq!(
            chunk_prefix("organization:attachment", "organization").unwrap(),
            "file-data:organization:"
        );
        assert_eq!(
            chunk_prefix("project:123:attachment", "project:123").unwrap(),
            "file-data:123:"
        );
        assert!(chunk_prefix("organization:billing", "organization").is_err());
        assert!(chunk_prefix("arbitrary:attachment", "organization").is_err());
        assert!(chunk_prefix("organization:attachment", "catalog:customers").is_err());
    }
}
