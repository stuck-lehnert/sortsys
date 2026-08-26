//! Project/contact relationships.
//!
//! The relationship carries an optional project-specific label. Contact and
//! project records themselves stay owned by their respective tables.

use std::{collections::HashMap, sync::Arc};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, types::Json};
use ts_rs::TS;

use super::common::{
    Address, EmailEntry, PhoneEntry, authenticated_pool, authorized_pool, internal, not_found,
    trim_nullable,
};
use crate::{
    AppState,
    api::Success,
    error::RpcResult,
    ids::Id,
    rpc::{ProcedureRegistryBuilder, RequestContext},
};

pub fn register(
    builder: ProcedureRegistryBuilder,
    state: Arc<AppState>,
) -> ProcedureRegistryBuilder {
    let contact_projects_state = Arc::clone(&state);
    let list_state = Arc::clone(&state);
    let add_state = Arc::clone(&state);
    let set_state = Arc::clone(&state);

    builder
        .query(
            "contacts.projects.list",
            move |context, input: ContactProjectsInput| {
                let state = Arc::clone(&contact_projects_state);

                async move { list_projects_for_contact(&state, &context, input.contact_id).await }
            },
        )
        .query(
            "projects.contacts.list",
            move |context, input: ProjectContactsInput| {
                let state = Arc::clone(&list_state);

                async move { list_contacts_for_project(&state, &context, input.project_id).await }
            },
        )
        .mutation(
            "projects.contacts.add",
            move |context, mut input: ProjectContactMutationInput| {
                let state = Arc::clone(&add_state);

                async move {
                    normalize_label(&mut input.label)?;
                    add_contact(&state, &context, input).await
                }
            },
        )
        .mutation(
            "projects.contacts.set",
            move |context, mut input: ProjectContactsSetInput| {
                let state = Arc::clone(&set_state);

                async move {
                    for contact in &mut input.contacts {
                        normalize_label(&mut contact.label)?;
                    }

                    set_contacts(&state, &context, input).await
                }
            },
        )
        .mutation(
            "projects.contacts.remove",
            move |context, input: ProjectContactMutationInput| {
                let state = Arc::clone(&state);

                async move { remove_contact(&state, &context, input).await }
            },
        )
}

async fn list_projects_for_contact(
    state: &AppState,
    context: &RequestContext,
    contact_id: Id,
) -> RpcResult<Vec<ContactProject>> {
    let (auth, pool) = authenticated_pool(state, context).await?;
    let user_id = auth.user.id.parse::<i64>().map_err(internal)?;
    let can_view_all = auth.can_do("view:projects");

    let rows = sqlx::query_as::<_, ContactProjectRow>(
        r#"
        SELECT
            project.id,
            project.title,
            project.address,
            project.customer_id,
            project.responsible_project_leader_user_id,
            project.order_received_at,
            project.created_by_user_id,
            project.created_at,
            project.modified_at,
            project.finished_at
        FROM projects AS project
        INNER JOIN project_contacts AS relation
            ON relation.project_id = project.id
        WHERE relation.contact_id = $1
          AND (
              $2
              OR EXISTS (
                  SELECT 1
                  FROM project_user_assignments AS assignment
                  WHERE assignment.project_id = project.id
                    AND assignment.user_id = $3
              )
          )
        ORDER BY LOWER(project.title)
        "#,
    )
    .bind(contact_id.0)
    .bind(can_view_all)
    .bind(user_id)
    .fetch_all(&pool)
    .await
    .map_err(internal)?;

    Ok(rows.into_iter().map(ContactProject::from).collect())
}

async fn list_contacts_for_project(
    state: &AppState,
    context: &RequestContext,
    project_id: Id,
) -> RpcResult<Vec<ProjectContact>> {
    let (_, pool) = authorized_pool(state, context, "view:contacts").await?;

    let rows = sqlx::query_as::<_, ProjectContactRow>(
        r#"
        SELECT
            contact.id,
            contact.salutation,
            contact.first_name,
            contact.last_name,
            contact.address,
            contact.phone_numbers,
            contact.email_addresses,
            contact.created_at,
            contact.modified_at,
            relation.label
        FROM contacts AS contact
        INNER JOIN project_contacts AS relation
            ON relation.contact_id = contact.id
        WHERE relation.project_id = $1
        ORDER BY LOWER(contact.last_name), LOWER(contact.first_name)
        "#,
    )
    .bind(project_id.0)
    .fetch_all(&pool)
    .await
    .map_err(internal)?;

    Ok(rows.into_iter().map(ProjectContact::from).collect())
}

async fn add_contact(
    state: &AppState,
    context: &RequestContext,
    input: ProjectContactMutationInput,
) -> RpcResult<Success> {
    let (_, pool) = authorized_pool(state, context, "manage:projects").await?;

    ensure_relation_targets_exist(&pool, input.project_id, &[input.contact_id]).await?;

    sqlx::query(
        r#"
        INSERT INTO project_contacts (project_id, contact_id, label)
        VALUES ($1, $2, $3)
        ON CONFLICT (project_id, contact_id)
        DO UPDATE SET label = EXCLUDED.label
        "#,
    )
    .bind(input.project_id.0)
    .bind(input.contact_id.0)
    .bind(input.label)
    .execute(&pool)
    .await
    .map_err(internal)?;

    Ok(Success { success: true })
}

async fn set_contacts(
    state: &AppState,
    context: &RequestContext,
    input: ProjectContactsSetInput,
) -> RpcResult<Success> {
    let (_, pool) = authorized_pool(state, context, "manage:projects").await?;

    // The former Map-based implementation kept the final label when the same
    // contact appeared more than once. Preserve that behavior explicitly.
    let mut contact_by_id = HashMap::new();
    for contact in input.contacts {
        contact_by_id.insert(contact.contact_id.0, contact.label);
    }

    let contact_ids = contact_by_id.keys().copied().map(Id).collect::<Vec<_>>();
    ensure_relation_targets_exist(&pool, input.project_id, &contact_ids).await?;

    let mut transaction = pool.begin().await.map_err(internal)?;

    sqlx::query("DELETE FROM project_contacts WHERE project_id = $1")
        .bind(input.project_id.0)
        .execute(&mut *transaction)
        .await
        .map_err(internal)?;

    for (contact_id, label) in contact_by_id {
        sqlx::query(
            "INSERT INTO project_contacts (project_id, contact_id, label) VALUES ($1, $2, $3)",
        )
        .bind(input.project_id.0)
        .bind(contact_id)
        .bind(label)
        .execute(&mut *transaction)
        .await
        .map_err(internal)?;
    }

    transaction.commit().await.map_err(internal)?;

    Ok(Success { success: true })
}

async fn remove_contact(
    state: &AppState,
    context: &RequestContext,
    input: ProjectContactMutationInput,
) -> RpcResult<Success> {
    let (_, pool) = authorized_pool(state, context, "manage:projects").await?;

    let result =
        sqlx::query("DELETE FROM project_contacts WHERE project_id = $1 AND contact_id = $2")
            .bind(input.project_id.0)
            .bind(input.contact_id.0)
            .execute(&pool)
            .await
            .map_err(internal)?;

    if result.rows_affected() == 0 {
        return Err(not_found());
    }

    Ok(Success { success: true })
}

async fn ensure_relation_targets_exist(
    pool: &sqlx::PgPool,
    project_id: Id,
    contact_ids: &[Id],
) -> RpcResult<()> {
    let project_exists =
        sqlx::query_scalar::<_, bool>("SELECT EXISTS (SELECT 1 FROM projects WHERE id = $1)")
            .bind(project_id.0)
            .fetch_one(pool)
            .await
            .map_err(internal)?;

    if !project_exists {
        return Err(not_found());
    }

    if contact_ids.is_empty() {
        return Ok(());
    }

    let raw_ids = contact_ids.iter().map(|id| id.0).collect::<Vec<_>>();
    let contact_count =
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM contacts WHERE id = ANY($1)")
            .bind(&raw_ids)
            .fetch_one(pool)
            .await
            .map_err(internal)?;

    if contact_count != raw_ids.len() as i64 {
        return Err(not_found());
    }

    Ok(())
}

fn normalize_label(label: &mut Option<String>) -> RpcResult<()> {
    trim_nullable(label, "label", 127)
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ContactProjectsInput {
    contact_id: Id,
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProjectContactsInput {
    project_id: Id,
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProjectContactMutationInput {
    project_id: Id,
    contact_id: Id,

    #[serde(default)]
    #[ts(optional = nullable)]
    label: Option<String>,
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProjectContactsSetInput {
    project_id: Id,
    contacts: Vec<ProjectContactEntry>,
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProjectContactEntry {
    contact_id: Id,

    #[serde(default)]
    #[ts(optional = nullable)]
    label: Option<String>,
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct ProjectContact {
    id: Id,
    salutation: Option<String>,
    first_name: Option<String>,
    last_name: Option<String>,
    address: Option<Address>,
    phone_numbers: Vec<PhoneEntry>,
    email_addresses: Vec<EmailEntry>,

    #[ts(type = "Date")]
    created_at: DateTime<Utc>,

    #[ts(type = "Date")]
    modified_at: DateTime<Utc>,

    label: Option<String>,
}

#[derive(FromRow)]
struct ProjectContactRow {
    id: i64,
    salutation: Option<String>,
    first_name: Option<String>,
    last_name: Option<String>,
    address: Option<Json<Address>>,
    phone_numbers: Json<Vec<PhoneEntry>>,
    email_addresses: Json<Vec<EmailEntry>>,
    created_at: DateTime<Utc>,
    modified_at: DateTime<Utc>,
    label: Option<String>,
}

impl From<ProjectContactRow> for ProjectContact {
    fn from(row: ProjectContactRow) -> Self {
        Self {
            id: Id(row.id),
            salutation: row.salutation,
            first_name: row.first_name,
            last_name: row.last_name,
            address: row.address.map(|value| value.0),
            phone_numbers: row.phone_numbers.0,
            email_addresses: row.email_addresses.0,
            created_at: row.created_at,
            modified_at: row.modified_at,
            label: row.label,
        }
    }
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct ContactProject {
    id: Id,
    title: String,
    address: Option<Address>,
    customer_id: Option<Id>,
    responsible_project_leader_user_id: Option<Id>,

    #[ts(type = "Date | null")]
    order_received_at: Option<DateTime<Utc>>,

    created_by_user_id: Option<Id>,

    #[ts(type = "Date")]
    created_at: DateTime<Utc>,

    #[ts(type = "Date")]
    modified_at: DateTime<Utc>,

    #[ts(type = "Date | null")]
    finished_at: Option<DateTime<Utc>>,
}

#[derive(FromRow)]
struct ContactProjectRow {
    id: i64,
    title: String,
    address: Option<Json<Address>>,
    customer_id: Option<i64>,
    responsible_project_leader_user_id: Option<i64>,
    order_received_at: Option<DateTime<Utc>>,
    created_by_user_id: Option<i64>,
    created_at: DateTime<Utc>,
    modified_at: DateTime<Utc>,
    finished_at: Option<DateTime<Utc>>,
}

impl From<ContactProjectRow> for ContactProject {
    fn from(row: ContactProjectRow) -> Self {
        Self {
            id: Id(row.id),
            title: row.title,
            address: row.address.map(|value| value.0),
            customer_id: row.customer_id.map(Id),
            responsible_project_leader_user_id: row.responsible_project_leader_user_id.map(Id),
            order_received_at: row.order_received_at,
            created_by_user_id: row.created_by_user_id.map(Id),
            created_at: row.created_at,
            modified_at: row.modified_at,
            finished_at: row.finished_at,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::normalize_label;

    #[test]
    fn normalizes_project_specific_contact_labels() {
        let mut empty = Some("   ".to_owned());
        normalize_label(&mut empty).expect("empty label is allowed");

        assert_eq!(empty, None);

        let mut too_long = Some("x".repeat(128));
        assert!(normalize_label(&mut too_long).is_err());
    }
}
