//! Shared wire values and serialization used by contract descriptions.
//! These models do not open a database or grant access to stored contents.
use crate::ids::Id;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

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

/// Parses a business calendar day without consulting the API host timezone.
#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFile {
    pub id: Id,
    pub project_id: Id,
    pub folder_id: Option<Id>,
    pub file_name: String,
    pub mime_type: String,
    pub kind: String,
    pub size_bytes: Option<i64>,
    pub status: String,
    pub thumbnail_status: String,
    pub thumbnail_url: Option<String>,

    #[ts(type = "Date | null")]
    pub thumbnail_expires_at: Option<DateTime<Utc>>,

    pub preview_url: Option<String>,

    #[ts(type = "Date | null")]
    pub preview_expires_at: Option<DateTime<Utc>>,

    pub thumbnail_width: Option<i32>,
    pub thumbnail_height: Option<i32>,
    pub text_extraction_status: String,
    pub created_by_user_id: Option<Id>,

    #[ts(type = "Date")]
    pub created_at: DateTime<Utc>,

    #[ts(type = "Date")]
    pub modified_at: DateTime<Utc>,

    #[ts(type = "Date | null")]
    pub uploaded_at: Option<DateTime<Utc>>,

    pub download_url: Option<String>,

    #[ts(type = "Date | null")]
    pub download_expires_at: Option<DateTime<Utc>>,

    pub download_attachment_url: Option<String>,

    #[ts(type = "Date | null")]
    pub download_attachment_expires_at: Option<DateTime<Utc>>,
}
