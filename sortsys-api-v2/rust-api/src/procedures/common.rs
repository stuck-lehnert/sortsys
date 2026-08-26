//! Shared authentication, input parsing, validation, and wire helpers.

use chrono::{DateTime, NaiveDate, NaiveTime};
use chrono_tz::Europe::Berlin;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sqlx::PgPool;
use ts_rs::TS;

use crate::{
    AppState,
    auth::AuthResult,
    error::{ErrorCode, RpcError, RpcResult},
    ids::Id,
    rpc::RequestContext,
};

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Address {
    #[serde(default)]
    #[ts(optional = nullable)]
    pub country: Option<String>,

    #[serde(default)]
    #[ts(optional = nullable)]
    pub zip: Option<String>,

    pub city: String,
    pub street_address: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct PhoneEntry {
    #[serde(default)]
    #[ts(optional = nullable)]
    pub name: Option<String>,

    pub number: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct EmailEntry {
    #[serde(default)]
    #[ts(optional = nullable)]
    pub name: Option<String>,

    pub email: String,
}

/// Represents all three states of a partial-update property.
///
/// An `Option<T>` cannot distinguish an omitted property from an explicit
/// JSON `null`, which is significant for the existing client contract.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum Patch<T> {
    #[default]
    Missing,
    Null,
    Value(T),
}

impl<'de, T: Deserialize<'de>> Deserialize<'de> for Patch<T> {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Option::<T>::deserialize(deserializer).map(|value| match value {
            Some(value) => Self::Value(value),
            None => Self::Null,
        })
    }
}

impl<T> Patch<T> {
    pub fn is_missing(&self) -> bool {
        matches!(self, Self::Missing)
    }

    pub fn apply(self, current: Option<T>) -> Option<T> {
        match self {
            Self::Missing => current,
            Self::Null => None,
            Self::Value(value) => Some(value),
        }
    }
}

pub async fn authenticated_pool(
    state: &AppState,
    context: &RequestContext,
) -> RpcResult<(AuthResult, PgPool)> {
    let auth = state.auth.authenticate(&context.headers).await?;
    let pool = state
        .tenants
        .tenant_pool(&auth.tenant)
        .await
        .map_err(internal)?;

    Ok((auth, pool))
}

pub async fn authorized_pool(
    state: &AppState,
    context: &RequestContext,
    role: &str,
) -> RpcResult<(AuthResult, PgPool)> {
    let (auth, pool) = authenticated_pool(state, context).await?;
    require_role(&auth, role)?;

    Ok((auth, pool))
}

pub fn require_role(auth: &AuthResult, role: &str) -> RpcResult<()> {
    if auth.can_do(role) {
        Ok(())
    } else {
        Err(forbidden())
    }
}

pub fn bad_request(message: impl Into<String>) -> RpcError {
    RpcError::new(ErrorCode::BadRequest, message).with_http_code(400)
}

pub fn forbidden() -> RpcError {
    RpcError::new(ErrorCode::Forbidden, "Forbidden").with_http_code(403)
}

pub fn not_found() -> RpcError {
    RpcError::new(ErrorCode::NotFound, "Not found").with_http_code(404)
}

pub fn conflict() -> RpcError {
    RpcError::new(ErrorCode::Conflict, "Conflict").with_http_code(409)
}

pub fn internal(error: impl std::fmt::Display) -> RpcError {
    RpcError::new(ErrorCode::InternalServerError, error.to_string()).with_http_code(500)
}

pub fn input_object(input: &Value) -> RpcResult<&Map<String, Value>> {
    input
        .as_object()
        .ok_or_else(|| bad_request("object input required"))
}

pub fn input_id(input: &Map<String, Value>, key: &str) -> RpcResult<i64> {
    let encoded = input_string(input, key)?;

    Id::decode(encoded)
        .map(|id| id.0)
        .map_err(|_| bad_request(format!("invalid {key}")))
}

pub fn optional_input_id(input: &Map<String, Value>, key: &str) -> RpcResult<Option<i64>> {
    optional_input_string(input, key)
        .map(|encoded| {
            Id::decode(encoded)
                .map(|id| id.0)
                .map_err(|_| bad_request(format!("invalid {key}")))
        })
        .transpose()
}

pub fn input_string<'a>(input: &'a Map<String, Value>, key: &str) -> RpcResult<&'a str> {
    input
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| bad_request(format!("missing {key}")))
}

pub fn optional_input_string<'a>(input: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    input.get(key).and_then(Value::as_str)
}

pub fn input_date(input: &Map<String, Value>, key: &str) -> RpcResult<NaiveDate> {
    parse_calendar_date(input_string(input, key)?, key)
}

pub fn optional_input_date(input: &Map<String, Value>, key: &str) -> RpcResult<Option<NaiveDate>> {
    optional_input_string(input, key)
        .map(|value| parse_calendar_date(value, key))
        .transpose()
}

pub(super) fn parse_calendar_date(value: &str, key: &str) -> RpcResult<NaiveDate> {
    parse_calendar_date_text(value).ok_or_else(|| bad_request(format!("invalid {key}")))
}

/// Parses a business calendar day without consulting the API host timezone.
pub(super) fn parse_calendar_date_text(value: &str) -> Option<NaiveDate> {
    if let Ok(calendar_date) = NaiveDate::parse_from_str(value, "%Y-%m-%d") {
        return Some(calendar_date);
    }

    let instant = DateTime::parse_from_rfc3339(value).ok()?;

    // Offset-bearing inputs retain the calendar date selected by the client,
    // independently of the timezone configured on the API host.
    if instant.offset().local_minus_utc() != 0 {
        return Some(instant.date_naive());
    }

    // Compatibility for older SuperJSON Date values: the original offset was
    // lost during UTC serialization. Only reinterpret the instant when it is
    // exactly midnight in the application's Europe/Berlin timezone.
    let berlin_instant = instant.with_timezone(&Berlin);
    if berlin_instant.time() == NaiveTime::MIN {
        Some(berlin_instant.date_naive())
    } else {
        Some(instant.date_naive())
    }
}

pub fn wire_date(value: NaiveDate) -> String {
    // The shared SuperJSON encoder recognizes this shape and marks it as Date.
    format!("{}T00:00:00.000Z", value.format("%Y-%m-%d"))
}

pub fn trim_required(value: &mut String, field: &str, max: usize) -> RpcResult<()> {
    *value = value.trim().to_owned();

    if value.is_empty() || value.len() > max {
        return Err(bad_request(format!(
            "{field} must contain between 1 and {max} characters"
        )));
    }

    Ok(())
}

pub fn trim_nullable(value: &mut Option<String>, field: &str, max: usize) -> RpcResult<()> {
    if let Some(inner) = value {
        *inner = inner.trim().to_owned();

        if inner.is_empty() {
            *value = None;
        } else if inner.len() > max {
            return Err(bad_request(format!(
                "{field} must not exceed {max} characters"
            )));
        }
    }

    Ok(())
}

pub fn validate_address(address: &mut Option<Address>) -> RpcResult<()> {
    let Some(address) = address else {
        return Ok(());
    };

    trim_required(&mut address.city, "city", usize::MAX)?;
    trim_required(&mut address.street_address, "streetAddress", usize::MAX)?;
    trim_nullable(&mut address.country, "country", usize::MAX)?;
    trim_nullable(&mut address.zip, "zip", usize::MAX)
}

pub fn validate_channels(phones: &mut [PhoneEntry], emails: &mut [EmailEntry]) -> RpcResult<()> {
    for phone in phones {
        trim_nullable(&mut phone.name, "phone name", usize::MAX)?;
        trim_required(&mut phone.number, "phone number", usize::MAX)?;
    }

    for email in emails {
        trim_nullable(&mut email.name, "email name", usize::MAX)?;
        email.email = email.email.trim().to_owned();

        if !email_address::EmailAddress::is_valid(&email.email) {
            return Err(bad_request("invalid email address"));
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use chrono::NaiveDate;

    use super::parse_calendar_date;

    #[test]
    fn parses_date_only_values_without_a_timezone() {
        assert_eq!(
            parse_calendar_date("2026-08-17", "day").unwrap(),
            NaiveDate::from_ymd_opt(2026, 8, 17).unwrap(),
        );
    }

    #[test]
    fn recovers_berlin_calendar_days_from_legacy_superjson_dates() {
        assert_eq!(
            parse_calendar_date("2026-08-16T22:00:00.000Z", "day").unwrap(),
            NaiveDate::from_ymd_opt(2026, 8, 17).unwrap(),
        );
        assert_eq!(
            parse_calendar_date("2026-12-31T23:00:00.000Z", "day").unwrap(),
            NaiveDate::from_ymd_opt(2027, 1, 1).unwrap(),
        );
    }

    #[test]
    fn honors_calendar_dates_encoded_with_explicit_offsets() {
        assert_eq!(
            parse_calendar_date("2026-08-17T00:00:00.000+02:00", "day").unwrap(),
            NaiveDate::from_ymd_opt(2026, 8, 17).unwrap(),
        );
        assert_eq!(
            parse_calendar_date("2026-08-17T00:00:00.000-07:00", "day").unwrap(),
            NaiveDate::from_ymd_opt(2026, 8, 17).unwrap(),
        );
    }
}
