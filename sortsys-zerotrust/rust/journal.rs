//! Append-only technical events committed with metadata, without business types.
use crate::{
    Result,
    crypto::{identifier, invalid, revision},
    metadata::{MAX_RECORD_BYTES, RecordKey},
};
use serde::{Deserialize, Serialize};
#[cfg(feature = "typescript")]
use ts_rs::TS;

pub const MAX_STREAMS: usize = 2000;
pub const MAX_PREFIXES: usize = 32;
pub const MAX_PAGE_SIZE: usize = 128;

pub fn instant(value: &str) -> Result<i64> {
    let micros = value.parse::<i64>().map_err(|_| invalid())?;
    if micros.to_string() != value
        || !(-62_135_596_800_000_000..=253_402_300_799_999_999).contains(&micros)
    {
        return Err(invalid());
    }
    Ok(micros)
}
pub fn cursor(value: &str) -> Result<i64> {
    if value == "0" {
        return Ok(0);
    }
    revision(value)
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[cfg_attr(feature = "typescript", derive(TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JournalAppend {
    pub stream: String,
    pub id: String,
    pub object: String,
    pub occurred_micros: String,
    pub order: Option<String>,
    pub value: String,
}
impl JournalAppend {
    pub fn validate(&self) -> Result<()> {
        identifier(&self.stream)?;
        identifier(&self.id)?;
        RecordKey {
            collection: self.stream.clone(),
            key: self.object.clone(),
        }
        .validate()?;
        instant(&self.occurred_micros)?;
        if let Some(order) = &self.order {
            revision(order)?;
        }
        if self.value.len() > MAX_RECORD_BYTES {
            return Err(invalid());
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[cfg_attr(feature = "typescript", derive(TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JournalEntry {
    pub sequence: String,
    pub order: String,
    pub entry: JournalAppend,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[cfg_attr(feature = "typescript", derive(TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JournalQuery {
    pub streams: Vec<String>,
    pub prefixes: Vec<String>,
    pub before: Option<String>,
    pub snapshot: Option<String>,
    pub known: Option<String>,
    pub known_total: Option<String>,
    pub limit: usize,
}
impl JournalQuery {
    pub fn validate(&self) -> Result<()> {
        if self.streams.len() > MAX_STREAMS
            || self.prefixes.is_empty()
            || self.prefixes.len() > MAX_PREFIXES
            || self.limit == 0
            || self.limit > MAX_PAGE_SIZE
        {
            return Err(invalid());
        }
        let mut streams = std::collections::HashSet::new();
        for stream in &self.streams {
            identifier(stream)?;
            if !streams.insert(stream) {
                return Err(invalid());
            }
        }
        let mut prefixes = std::collections::HashSet::new();
        for prefix in &self.prefixes {
            RecordKey {
                collection: "prefix".into(),
                key: prefix.clone(),
            }
            .validate()?;
            if !prefixes.insert(prefix) {
                return Err(invalid());
            }
        }
        for value in [&self.before, &self.snapshot, &self.known, &self.known_total]
            .into_iter()
            .flatten()
        {
            cursor(value)?;
        }
        if self.known.is_some() != self.known_total.is_some()
            || self.known.is_some() && (self.before.is_some() || self.snapshot.is_some())
        {
            return Err(invalid());
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[cfg_attr(feature = "typescript", derive(TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JournalPage {
    pub current: String,
    pub total: String,
    pub snapshot: String,
    pub after: Option<String>,
    pub after_micros: Option<String>,
    pub after_order: Option<String>,
    pub unchanged: bool,
    pub entries: Vec<JournalEntry>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    #[test]
    fn the_shared_browser_vectors_preserve_exact_times_and_reject_noncanonical_entries() {
        let source: Value =
            serde_json::from_str(include_str!("../test/fixtures/journal.json")).unwrap();
        for value in source["valid"].as_array().unwrap() {
            let entry: JournalAppend = serde_json::from_value(value.clone()).unwrap();
            entry.validate().unwrap();
            assert_eq!(serde_json::to_value(entry).unwrap(), *value);
        }
        for patch in source["invalid"].as_array().unwrap() {
            let mut value = source["valid"][0].clone();
            value[patch["field"].as_str().unwrap()] = patch["value"].clone();
            if let Ok(entry) = serde_json::from_value::<JournalAppend>(value) {
                assert!(entry.validate().is_err(), "{patch}");
            }
        }
    }
}
