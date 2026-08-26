//! Contact lifecycle and customer-contact lookup procedures.
//!
//! Shared address and communication-channel validation lives in `common` so
//! contacts and customers enforce the same wire-level rules.

use std::sync::Arc;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgPool, types::Json};
use ts_rs::TS;

use crate::{
    AppState,
    api::Success,
    error::RpcResult,
    ids::Id,
    rpc::{ProcedureRegistryBuilder, RequestContext},
};

use super::common::{
    Address, EmailEntry, Patch, PhoneEntry, authorized_pool, bad_request, internal, not_found,
    trim_nullable, validate_address, validate_channels,
};

pub fn register(
    builder: ProcedureRegistryBuilder,
    state: Arc<AppState>,
) -> ProcedureRegistryBuilder {
    let list_state = Arc::clone(&state);
    let get_state = Arc::clone(&state);
    let create_state = Arc::clone(&state);
    let update_state = Arc::clone(&state);
    let delete_state = Arc::clone(&state);
    let customers_state = state;

    builder
        .query("contacts.list", move |context, input: ContactListInput| {
            let state = Arc::clone(&list_state);

            async move { list(&state, &context, input).await }
        })
        .query("contacts.get", move |context, input: IdentifierInput| {
            let state = Arc::clone(&get_state);

            async move { get(&state, &context, input).await }
        })
        .mutation(
            "contacts.create",
            move |context, input: ContactCreateInput| {
                let state = Arc::clone(&create_state);

                async move { create(&state, &context, input).await }
            },
        )
        .mutation(
            "contacts.update",
            move |context, input: ContactUpdateInput| {
                let state = Arc::clone(&update_state);

                async move { update(&state, &context, input).await }
            },
        )
        .mutation("contacts.delete", move |context, input: IdentifierInput| {
            let state = Arc::clone(&delete_state);

            async move { delete(&state, &context, input).await }
        })
        .query(
            "contacts.customers.list",
            move |context, input: ContactCustomersInput| {
                let state = Arc::clone(&customers_state);

                async move { list_customers(&state, &context, input).await }
            },
        )
}

async fn list(
    state: &AppState,
    context: &RequestContext,
    input: ContactListInput,
) -> RpcResult<Vec<Contact>> {
    let (_, pool) = authorized_pool(state, context, "view:contacts").await?;

    list_contacts(&pool, input.search.as_deref(), None).await
}

async fn get(
    state: &AppState,
    context: &RequestContext,
    input: IdentifierInput,
) -> RpcResult<Contact> {
    let (_, pool) = authorized_pool(state, context, "view:contacts").await?;

    get_contact(&pool, input.id).await
}

async fn create(
    state: &AppState,
    context: &RequestContext,
    mut input: ContactCreateInput,
) -> RpcResult<CreatedId> {
    let (_, pool) = authorized_pool(state, context, "manage:contacts").await?;
    input.normalize()?;

    let contact_id: i64 = sqlx::query_scalar(
        r#"
        INSERT INTO contacts (
            salutation,
            first_name,
            last_name,
            address,
            phone_numbers,
            email_addresses
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id
        "#,
    )
    .bind(input.salutation)
    .bind(input.first_name)
    .bind(input.last_name)
    .bind(input.address.map(Json))
    .bind(Json(input.phone_numbers.unwrap_or_default()))
    .bind(Json(input.email_addresses.unwrap_or_default()))
    .fetch_one(&pool)
    .await
    .map_err(internal)?;

    Ok(CreatedId { id: Id(contact_id) })
}

async fn update(
    state: &AppState,
    context: &RequestContext,
    input: ContactUpdateInput,
) -> RpcResult<Success> {
    let (_, pool) = authorized_pool(state, context, "manage:contacts").await?;

    update_contact(&pool, input).await
}

async fn delete(
    state: &AppState,
    context: &RequestContext,
    input: IdentifierInput,
) -> RpcResult<Success> {
    let (_, pool) = authorized_pool(state, context, "delete:contacts").await?;

    let result = sqlx::query("DELETE FROM contacts WHERE id = $1")
        .bind(input.id.0)
        .execute(&pool)
        .await
        .map_err(internal)?;

    if result.rows_affected() == 0 {
        return Err(not_found());
    }

    Ok(Success { success: true })
}

async fn list_customers(
    state: &AppState,
    context: &RequestContext,
    input: ContactCustomersInput,
) -> RpcResult<Vec<super::customers::Customer>> {
    let (_, pool) = authorized_pool(state, context, "view:customers").await?;

    super::customers::list_customers(&pool, None, Some(input.contact_id)).await
}

pub(crate) async fn list_contacts(
    pool: &PgPool,
    search: Option<&str>,
    customer_id: Option<Id>,
) -> RpcResult<Vec<Contact>> {
    let search = search.map(str::trim).filter(|value| !value.is_empty());

    let rows = sqlx::query_as::<_, ContactRow>(
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
            contact.modified_at
        FROM contacts AS contact
        WHERE (
            $1::text IS NULL
            OR contact._search @@ create_query($1)
        )
          AND (
              $2::bigint IS NULL
              OR EXISTS (
                  SELECT 1
                  FROM customer_contacts AS relation
                  WHERE relation.contact_id = contact.id
                    AND relation.customer_id = $2
              )
          )
        ORDER BY
            LOWER(contact.last_name),
            LOWER(contact.first_name)
        "#,
    )
    .bind(search)
    .bind(customer_id.map(|id| id.0))
    .fetch_all(pool)
    .await
    .map_err(internal)?;

    Ok(rows.into_iter().map(Contact::from).collect())
}

async fn get_contact(pool: &PgPool, id: Id) -> RpcResult<Contact> {
    sqlx::query_as::<_, ContactRow>(
        "SELECT id, salutation, first_name, last_name, address, phone_numbers, email_addresses, \
                created_at, modified_at FROM contacts WHERE id = $1",
    )
    .bind(id.0)
    .fetch_optional(pool)
    .await
    .map_err(internal)?
    .map(Contact::from)
    .ok_or_else(not_found)
}

async fn update_contact(pool: &PgPool, mut input: ContactUpdateInput) -> RpcResult<Success> {
    if input.data.is_empty() {
        return Err(bad_request("empty update"));
    }

    let existing = sqlx::query_as::<_, ContactWritable>(
        "SELECT salutation, first_name, last_name, address, phone_numbers, email_addresses \
         FROM contacts WHERE id = $1",
    )
    .bind(input.id.0)
    .fetch_optional(pool)
    .await
    .map_err(internal)?
    .ok_or_else(not_found)?;

    let mut salutation = input.data.salutation.apply(existing.salutation);
    let mut first_name = input.data.first_name.apply(existing.first_name);
    let mut last_name = input.data.last_name.apply(existing.last_name);
    let mut address = input
        .data
        .address
        .apply(existing.address.map(|address| address.0));
    let mut phones = input
        .data
        .phone_numbers
        .take()
        .unwrap_or(existing.phone_numbers.0);
    let mut emails = input
        .data
        .email_addresses
        .take()
        .unwrap_or(existing.email_addresses.0);

    trim_nullable(&mut salutation, "salutation", usize::MAX)?;
    trim_nullable(&mut first_name, "firstName", 127)?;
    trim_nullable(&mut last_name, "lastName", 127)?;
    validate_address(&mut address)?;
    validate_channels(&mut phones, &mut emails)?;

    if first_name.is_none() && last_name.is_none() {
        return Err(bad_request("First name or last name is required."));
    }

    sqlx::query(
        r#"
        UPDATE contacts
        SET
            salutation = $2,
            first_name = $3,
            last_name = $4,
            address = $5,
            phone_numbers = $6,
            email_addresses = $7
        WHERE id = $1
        "#,
    )
    .bind(input.id.0)
    .bind(salutation)
    .bind(first_name)
    .bind(last_name)
    .bind(address.map(Json))
    .bind(Json(phones))
    .bind(Json(emails))
    .execute(pool)
    .await
    .map_err(internal)?;

    Ok(Success { success: true })
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ContactListInput {
    #[serde(default)]
    #[ts(optional = nullable)]
    search: Option<String>,
}

#[derive(Debug, Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct IdentifierInput {
    id: Id,
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ContactCustomersInput {
    contact_id: Id,
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ContactCreateInput {
    #[serde(default)]
    #[ts(optional = nullable)]
    salutation: Option<String>,
    #[serde(default)]
    #[ts(optional = nullable)]
    first_name: Option<String>,
    #[serde(default)]
    #[ts(optional = nullable)]
    last_name: Option<String>,
    #[serde(default)]
    #[ts(optional = nullable)]
    address: Option<Address>,
    #[serde(default)]
    #[ts(optional)]
    phone_numbers: Option<Vec<PhoneEntry>>,
    #[serde(default)]
    #[ts(optional)]
    email_addresses: Option<Vec<EmailEntry>>,
}

impl ContactCreateInput {
    fn normalize(&mut self) -> RpcResult<()> {
        trim_nullable(&mut self.salutation, "salutation", usize::MAX)?;
        trim_nullable(&mut self.first_name, "firstName", 127)?;
        trim_nullable(&mut self.last_name, "lastName", 127)?;
        validate_address(&mut self.address)?;
        validate_channels(
            self.phone_numbers.get_or_insert_default(),
            self.email_addresses.get_or_insert_default(),
        )?;

        if self.first_name.is_none() && self.last_name.is_none() {
            return Err(bad_request("First name or last name is required."));
        }

        Ok(())
    }
}

#[derive(Debug, Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct ContactUpdateInput {
    id: Id,
    data: ContactPatch,
}

#[derive(Debug, Default, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ContactPatch {
    #[serde(default)]
    #[ts(optional, type = "string | null")]
    salutation: Patch<String>,
    #[serde(default)]
    #[ts(optional, type = "string | null")]
    first_name: Patch<String>,
    #[serde(default)]
    #[ts(optional, type = "string | null")]
    last_name: Patch<String>,
    #[serde(default)]
    #[ts(optional, type = "Address | null")]
    address: Patch<Address>,
    #[serde(default)]
    #[ts(optional)]
    phone_numbers: Option<Vec<PhoneEntry>>,
    #[serde(default)]
    #[ts(optional)]
    email_addresses: Option<Vec<EmailEntry>>,
}

impl ContactPatch {
    fn is_empty(&self) -> bool {
        self.salutation.is_missing()
            && self.first_name.is_missing()
            && self.last_name.is_missing()
            && self.address.is_missing()
            && self.phone_numbers.is_none()
            && self.email_addresses.is_none()
    }
}

#[derive(Debug, Serialize, TS)]
struct CreatedId {
    id: Id,
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Contact {
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
}

#[derive(FromRow)]
struct ContactRow {
    id: i64,
    salutation: Option<String>,
    first_name: Option<String>,
    last_name: Option<String>,
    address: Option<Json<Address>>,
    phone_numbers: Json<Vec<PhoneEntry>>,
    email_addresses: Json<Vec<EmailEntry>>,
    created_at: DateTime<Utc>,
    modified_at: DateTime<Utc>,
}

impl From<ContactRow> for Contact {
    fn from(row: ContactRow) -> Self {
        Self {
            id: Id(row.id),
            salutation: row.salutation,
            first_name: row.first_name,
            last_name: row.last_name,
            address: row.address.map(|address| address.0),
            phone_numbers: row.phone_numbers.0,
            email_addresses: row.email_addresses.0,
            created_at: row.created_at,
            modified_at: row.modified_at,
        }
    }
}

#[derive(FromRow)]
struct ContactWritable {
    salutation: Option<String>,
    first_name: Option<String>,
    last_name: Option<String>,
    address: Option<Json<Address>>,
    phone_numbers: Json<Vec<PhoneEntry>>,
    email_addresses: Json<Vec<EmailEntry>>,
}
