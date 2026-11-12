//! Delete standalone offers without damaging projects or dependent documents.
use std::sync::Arc;

use sqlx::PgConnection;

use super::{commercial, common::internal};
use crate::{
    AppState,
    api::Success,
    error::RpcResult,
    ids::Id,
    object_storage,
    rpc::{ProcedureRegistryBuilder, RequestContext},
};

pub fn register(
    builder: ProcedureRegistryBuilder,
    state: Arc<AppState>,
) -> ProcedureRegistryBuilder {
    builder.mutation(
        "commercial.cases.delete",
        move |context, input: commercial::CaseInput| {
            let state = Arc::clone(&state);
            async move { delete(&state, &context, input.id).await }
        },
    )
}

pub fn register_contract(builder: ProcedureRegistryBuilder) -> ProcedureRegistryBuilder {
    builder.mutation_stub::<commercial::CaseInput, Success>("commercial.cases.delete")
}

async fn delete(state: &AppState, context: &RequestContext, id: Id) -> RpcResult<Success> {
    let (auth, pool) = commercial::access(state, context, true).await?;
    let mut tx = pool.begin().await.map_err(internal)?;
    let keys = delete_offer(&mut tx, id).await?;
    // Resolve configuration before committing; object deletion must happen only
    // after a successful commit so rollback cannot leave missing documents.
    let storage = if keys.is_empty() {
        None
    } else {
        object_storage::tenant_config(&state.tenants, &auth.tenant, false).await?
    };
    tx.commit().await.map_err(internal)?;
    if let Some(storage) = storage {
        for key in keys {
            if let Err(error) = object_storage::delete_object(&storage, &key).await {
                tracing::warn!(?error, "Could not clean up deleted offer object");
            }
        }
    }
    Ok(Success { success: true })
}

async fn delete_offer(connection: &mut PgConnection, id: Id) -> RpcResult<Vec<String>> {
    let case = commercial::locked_case(connection, id).await?;
    if !matches!(case.kind.as_str(), "offer" | "alternative") {
        return Err(commercial::conflict(
            "Only standalone offers can be deleted",
        ));
    }
    if case.project_id.is_some() {
        return Err(commercial::conflict(
            "Offer is linked to a project and cannot be deleted",
        ));
    }
    let dependent: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM commercial_cases WHERE parent_case_id=$1) \
         OR EXISTS(SELECT 1 FROM project_financial_entries WHERE commercial_case_id=$1) \
         OR EXISTS(SELECT 1 FROM commercial_documents d JOIN commercial_documents source \
           ON source.id=d.source_document_id WHERE source.case_id=$1 AND d.case_id<>$1)",
    )
    .bind(id)
    .fetch_one(&mut *connection)
    .await
    .map_err(internal)?;
    if dependent {
        return Err(commercial::conflict(
            "Offer has dependent workflows or documents and cannot be deleted",
        ));
    }
    let keys: Vec<String> = sqlx::query_scalar(
        "SELECT object_key FROM commercial_documents WHERE case_id=$1 UNION \
         SELECT s.object_key FROM commercial_document_snapshots s JOIN commercial_documents d \
         ON d.id=s.document_id WHERE d.case_id=$1",
    )
    .bind(id)
    .fetch_all(&mut *connection)
    .await
    .map_err(internal)?;
    sqlx::query("UPDATE commercial_cases SET selected_offer_document_id=NULL WHERE id=$1")
        .bind(id)
        .execute(&mut *connection)
        .await
        .map_err(internal)?;
    sqlx::query("UPDATE commercial_documents SET source_document_id=NULL,source_version=NULL WHERE case_id=$1")
        .bind(id).execute(&mut *connection).await.map_err(internal)?;
    sqlx::query("DELETE FROM commercial_document_snapshots WHERE document_id IN (SELECT id FROM commercial_documents WHERE case_id=$1)")
        .bind(id).execute(&mut *connection).await.map_err(internal)?;
    // Foreign keys remain the final protection against concurrent cross-case references.
    for statement in [
        "DELETE FROM commercial_documents WHERE case_id=$1",
        "DELETE FROM commercial_case_events WHERE case_id=$1",
        "DELETE FROM commercial_cases WHERE id=$1",
    ] {
        sqlx::query(statement)
            .bind(id)
            .execute(&mut *connection)
            .await
            .map_err(|error| {
                if error
                    .as_database_error()
                    .is_some_and(|error| error.is_foreign_key_violation())
                {
                    commercial::conflict(
                        "Offer has dependent workflows or documents and cannot be deleted",
                    )
                } else {
                    internal(error)
                }
            })?;
    }
    // Deliberately retain the offer-number ledger: deleted numbers are never reusable.
    Ok(keys)
}
