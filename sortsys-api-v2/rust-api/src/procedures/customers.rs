//! Customer records and customer-contact relationships.

use std::{collections::HashSet, sync::Arc};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgPool, types::Json};
use ts_rs::TS;

use super::{
    common::{
        Address, EmailEntry, Patch, PhoneEntry, authorized_pool, bad_request, internal, not_found,
        trim_nullable, trim_required, validate_address, validate_channels,
    },
    contacts::list_contacts,
};
use crate::{
    AppState,
    api::Success,
    error::RpcResult,
    ids::Id,
    rpc::{ProcedureRegistryBuilder, RequestContext},
};

pub fn register(
    mut builder: ProcedureRegistryBuilder,
    state: Arc<AppState>,
) -> ProcedureRegistryBuilder {
    let list_state = Arc::clone(&state);
    builder = builder.query(
        "customers.list",
        move |context, input: CustomerListInput| {
            let state = Arc::clone(&list_state);

            async move {
                let (_, pool) = authorized_pool(&state, &context, "view:customers").await?;

                list_customers(&pool, input.search.as_deref(), None).await
            }
        },
    );

    let get_state = Arc::clone(&state);
    builder = builder.query("customers.get", move |context, input: IdentifierInput| {
        let state = Arc::clone(&get_state);

        async move {
            let (_, pool) = authorized_pool(&state, &context, "view:customers").await?;

            get_customer(&pool, input.id).await
        }
    });

    let create_state = Arc::clone(&state);
    builder = builder.mutation(
        "customers.create",
        move |context, input: CustomerCreateInput| {
            let state = Arc::clone(&create_state);

            async move { create_customer(&state, &context, input).await }
        },
    );

    let update_state = Arc::clone(&state);
    builder = builder.mutation(
        "customers.update",
        move |context, input: CustomerUpdateInput| {
            let state = Arc::clone(&update_state);

            async move {
                let (_, pool) = authorized_pool(&state, &context, "manage:customers").await?;

                update_customer(&pool, input).await
            }
        },
    );

    let delete_state = Arc::clone(&state);
    builder = builder.mutation(
        "customers.delete",
        move |context, input: IdentifierInput| {
            let state = Arc::clone(&delete_state);

            async move { delete_customer(&state, &context, input).await }
        },
    );

    let list_contacts_state = Arc::clone(&state);
    builder = builder.query(
        "customers.contacts.list",
        move |context, input: CustomerContactsInput| {
            let state = Arc::clone(&list_contacts_state);

            async move {
                let (_, pool) = authorized_pool(&state, &context, "view:contacts").await?;

                list_contacts(&pool, None, Some(input.customer_id)).await
            }
        },
    );

    let add_contact_state = Arc::clone(&state);
    builder = builder.mutation(
        "customers.contacts.add",
        move |context, input: CustomerContactMutationInput| {
            let state = Arc::clone(&add_contact_state);

            async move { add_contact(&state, &context, input).await }
        },
    );

    let set_contacts_state = Arc::clone(&state);
    builder = builder.mutation(
        "customers.contacts.set",
        move |context, input: CustomerContactsSetInput| {
            let state = Arc::clone(&set_contacts_state);

            async move { set_contacts(&state, &context, input).await }
        },
    );

    builder.mutation(
        "customers.contacts.remove",
        move |context, input: CustomerContactMutationInput| {
            let state = Arc::clone(&state);

            async move { remove_contact(&state, &context, input).await }
        },
    )
}

async fn create_customer(
    state: &AppState,
    context: &RequestContext,
    mut input: CustomerCreateInput,
) -> RpcResult<CreatedId> {
    let (auth, pool) = authorized_pool(state, context, "manage:customers").await?;
    input.normalize()?;

    let created_by_user_id = auth.user.id.parse::<i64>().map_err(internal)?;
    let customer_id: i64 = sqlx::query_scalar(
        r#"
        INSERT INTO customers (
            salutation,
            name,
            address,
            phone_numbers,
            email_addresses,
            created_by_user_id
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id
        "#,
    )
    .bind(input.salutation)
    .bind(input.name)
    .bind(input.address.map(Json))
    .bind(Json(input.phone_numbers.unwrap_or_default()))
    .bind(Json(input.email_addresses.unwrap_or_default()))
    .bind(created_by_user_id)
    .fetch_one(&pool)
    .await
    .map_err(internal)?;

    Ok(CreatedId {
        id: Id(customer_id),
    })
}

async fn delete_customer(
    state: &AppState,
    context: &RequestContext,
    input: IdentifierInput,
) -> RpcResult<Success> {
    let (_, pool) = authorized_pool(state, context, "delete:customers").await?;

    let result = sqlx::query("DELETE FROM customers WHERE id = $1")
        .bind(input.id.0)
        .execute(&pool)
        .await
        .map_err(internal)?;

    if result.rows_affected() == 0 {
        return Err(not_found());
    }

    Ok(Success { success: true })
}

async fn add_contact(
    state: &AppState,
    context: &RequestContext,
    input: CustomerContactMutationInput,
) -> RpcResult<Success> {
    let (_, pool) = authorized_pool(state, context, "manage:customers").await?;

    ensure_customer_and_contacts(&pool, input.customer_id, &[input.contact_id]).await?;

    sqlx::query(
        r#"
        INSERT INTO customer_contacts (customer_id, contact_id)
        VALUES ($1, $2)
        ON CONFLICT (customer_id, contact_id) DO NOTHING
        "#,
    )
    .bind(input.customer_id.0)
    .bind(input.contact_id.0)
    .execute(&pool)
    .await
    .map_err(internal)?;

    Ok(Success { success: true })
}

async fn set_contacts(
    state: &AppState,
    context: &RequestContext,
    input: CustomerContactsSetInput,
) -> RpcResult<Success> {
    let (_, pool) = authorized_pool(state, context, "manage:customers").await?;

    // Keep the first occurrence of each ID, matching the legacy Set behavior.
    let mut seen = HashSet::new();
    let contact_ids: Vec<Id> = input
        .contact_ids
        .into_iter()
        .filter(|id| seen.insert(id.0))
        .collect();

    ensure_customer_and_contacts(&pool, input.customer_id, &contact_ids).await?;

    let mut transaction = pool.begin().await.map_err(internal)?;

    sqlx::query("DELETE FROM customer_contacts WHERE customer_id = $1")
        .bind(input.customer_id.0)
        .execute(&mut *transaction)
        .await
        .map_err(internal)?;

    for contact_id in contact_ids {
        sqlx::query(
            r#"
            INSERT INTO customer_contacts (customer_id, contact_id)
            VALUES ($1, $2)
            "#,
        )
        .bind(input.customer_id.0)
        .bind(contact_id.0)
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
    input: CustomerContactMutationInput,
) -> RpcResult<Success> {
    let (_, pool) = authorized_pool(state, context, "manage:customers").await?;

    let result = sqlx::query(
        r#"
        DELETE FROM customer_contacts
        WHERE customer_id = $1
          AND contact_id = $2
        "#,
    )
    .bind(input.customer_id.0)
    .bind(input.contact_id.0)
    .execute(&pool)
    .await
    .map_err(internal)?;

    if result.rows_affected() == 0 {
        return Err(not_found());
    }

    Ok(Success { success: true })
}

pub(crate) async fn list_customers(
    pool: &PgPool,
    search: Option<&str>,
    contact_id: Option<Id>,
) -> RpcResult<Vec<Customer>> {
    let search = search.map(str::trim).filter(|value| !value.is_empty());
    let rows = sqlx::query_as::<_, CustomerRow>(
        "SELECT cu.id, cu.salutation, cu.name, cu.address, cu.phone_numbers, cu.email_addresses, \
                cu.created_by_user_id, cu.created_at, cu.modified_at FROM customers cu \
         WHERE ($1::TEXT IS NULL OR cu._search @@ create_query($1)) \
           AND ($2::BIGINT IS NULL OR EXISTS (SELECT 1 FROM customer_contacts cc \
                WHERE cc.customer_id=cu.id AND cc.contact_id=$2)) ORDER BY LOWER(cu.name)",
    )
    .bind(search)
    .bind(contact_id.map(|id| id.0))
    .fetch_all(pool)
    .await
    .map_err(internal)?;
    Ok(rows.into_iter().map(Customer::from).collect())
}

async fn get_customer(pool: &PgPool, id: Id) -> RpcResult<Customer> {
    sqlx::query_as::<_, CustomerRow>(
        "SELECT id, salutation, name, address, phone_numbers, email_addresses, created_by_user_id, \
                created_at, modified_at FROM customers WHERE id=$1",
    )
    .bind(id.0)
    .fetch_optional(pool)
    .await
    .map_err(internal)?
    .map(Customer::from)
    .ok_or_else(not_found)
}

async fn update_customer(pool: &PgPool, mut input: CustomerUpdateInput) -> RpcResult<Success> {
    if input.data.is_empty() {
        return Err(bad_request("empty update"));
    }
    let existing = sqlx::query_as::<_, CustomerWritable>(
        "SELECT salutation, name, address, phone_numbers, email_addresses FROM customers WHERE id=$1",
    )
    .bind(input.id.0).fetch_optional(pool).await.map_err(internal)?.ok_or_else(not_found)?;

    let mut salutation = input.data.salutation.apply(existing.salutation);
    let mut name = input.data.name.take().unwrap_or(existing.name);
    let mut address = input.data.address.apply(existing.address.map(|v| v.0));
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
    trim_required(&mut name, "name", 127)?;
    validate_address(&mut address)?;
    validate_channels(&mut phones, &mut emails)?;
    sqlx::query(
        "UPDATE customers SET salutation=$2,name=$3,address=$4,phone_numbers=$5,email_addresses=$6 WHERE id=$1",
    )
    .bind(input.id.0).bind(salutation).bind(name).bind(address.map(Json))
    .bind(Json(phones)).bind(Json(emails)).execute(pool).await.map_err(internal)?;
    Ok(Success { success: true })
}

async fn ensure_customer_and_contacts(
    pool: &PgPool,
    customer: Id,
    contacts: &[Id],
) -> RpcResult<()> {
    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM customers WHERE id=$1)")
        .bind(customer.0)
        .fetch_one(pool)
        .await
        .map_err(internal)?;
    if !exists {
        return Err(not_found());
    }
    if !contacts.is_empty() {
        let ids: Vec<i64> = contacts.iter().map(|id| id.0).collect();
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM contacts WHERE id=ANY($1)")
            .bind(ids)
            .fetch_one(pool)
            .await
            .map_err(internal)?;
        if count != contacts.len() as i64 {
            return Err(not_found());
        }
    }
    Ok(())
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CustomerListInput {
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
struct CustomerContactsInput {
    customer_id: Id,
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CustomerContactMutationInput {
    customer_id: Id,
    contact_id: Id,
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CustomerContactsSetInput {
    customer_id: Id,
    contact_ids: Vec<Id>,
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CustomerCreateInput {
    #[serde(default)]
    #[ts(optional = nullable)]
    salutation: Option<String>,
    name: String,
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

impl CustomerCreateInput {
    fn normalize(&mut self) -> RpcResult<()> {
        trim_nullable(&mut self.salutation, "salutation", usize::MAX)?;
        trim_required(&mut self.name, "name", 127)?;
        validate_address(&mut self.address)?;
        validate_channels(
            self.phone_numbers.get_or_insert_default(),
            self.email_addresses.get_or_insert_default(),
        )
    }
}

#[derive(Debug, Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct CustomerUpdateInput {
    id: Id,
    data: CustomerPatch,
}

#[derive(Debug, Default, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CustomerPatch {
    #[serde(default)]
    #[ts(optional, type = "string | null")]
    salutation: Patch<String>,
    #[serde(default)]
    #[ts(optional)]
    name: Option<String>,
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

impl CustomerPatch {
    fn is_empty(&self) -> bool {
        self.salutation.is_missing()
            && self.name.is_none()
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
pub(crate) struct Customer {
    id: Id,
    salutation: Option<String>,
    name: String,
    address: Option<Address>,
    phone_numbers: Vec<PhoneEntry>,
    email_addresses: Vec<EmailEntry>,
    created_by_user_id: Option<Id>,
    #[ts(type = "Date")]
    created_at: DateTime<Utc>,
    #[ts(type = "Date")]
    modified_at: DateTime<Utc>,
}

#[derive(FromRow)]
struct CustomerRow {
    id: i64,
    salutation: Option<String>,
    name: String,
    address: Option<Json<Address>>,
    phone_numbers: Json<Vec<PhoneEntry>>,
    email_addresses: Json<Vec<EmailEntry>>,
    created_by_user_id: Option<i64>,
    created_at: DateTime<Utc>,
    modified_at: DateTime<Utc>,
}

impl From<CustomerRow> for Customer {
    fn from(row: CustomerRow) -> Self {
        Self {
            id: Id(row.id),
            salutation: row.salutation,
            name: row.name,
            address: row.address.map(|v| v.0),
            phone_numbers: row.phone_numbers.0,
            email_addresses: row.email_addresses.0,
            created_by_user_id: row.created_by_user_id.map(Id),
            created_at: row.created_at,
            modified_at: row.modified_at,
        }
    }
}

#[derive(FromRow)]
struct CustomerWritable {
    salutation: Option<String>,
    name: String,
    address: Option<Json<Address>>,
    phone_numbers: Json<Vec<PhoneEntry>>,
    email_addresses: Json<Vec<EmailEntry>>,
}
