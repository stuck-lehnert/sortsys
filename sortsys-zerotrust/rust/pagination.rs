//! Transport-neutral snapshot pages. Signatures and snapshot admission belong
//! to the consuming protocol; this type never treats a cursor as authorization.
use crate::{Error, Result};
use serde::{Deserialize, Serialize};
#[cfg(feature = "typescript")]
use ts_rs::TS;

pub fn validate_token(value: &str) -> Result<()> {
    if value.is_empty() || value.len() > 2048 {
        return Err(Error::InvalidProtectedData);
    }
    Ok(())
}

#[derive(Debug, Deserialize, Serialize)]
#[cfg_attr(feature = "typescript", derive(TS))]
#[serde(deny_unknown_fields)]
pub struct SnapshotPage<T> {
    pub snapshot: String,
    pub items: Vec<T>,
    pub after: Option<String>,
}

impl<T> SnapshotPage<T> {
    /// The storage adapter requests at most limit+1 rows in cursor order.
    /// The extra row indicates another page without dropping its predecessor.
    pub fn from_lookahead(
        snapshot: String,
        mut rows: Vec<T>,
        limit: usize,
        cursor: impl FnOnce(&T) -> Result<String>,
    ) -> Result<Self> {
        validate_token(&snapshot)?;
        let maximum = limit.checked_add(1).ok_or(Error::InvalidProtectedData)?;
        if limit == 0 || rows.len() > maximum {
            return Err(Error::InvalidProtectedData);
        }
        let after = if rows.len() > limit {
            rows.pop();
            let last = rows.last().ok_or(Error::InvalidProtectedData)?;
            let value = cursor(last)?;
            validate_token(&value)?;
            Some(value)
        } else {
            None
        };
        Ok(Self {
            snapshot,
            items: rows,
            after,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_tokens_are_opaque_and_bounded_by_utf8_bytes() {
        let page = SnapshotPage::from_lookahead("-etag/\"two\"".into(), vec![1, 2], 1, |_| {
            Ok("+/cursor==".into())
        })
        .unwrap();
        assert_eq!(page.after.as_deref(), Some("+/cursor=="));
        assert!(validate_token(&"ä".repeat(1024)).is_ok());
        assert!(validate_token(&"ä".repeat(1025)).is_err());
    }

    #[test]
    fn lookahead_keeps_the_last_delivered_cursor_and_handles_exact_boundaries() {
        let page = SnapshotPage::from_lookahead("version:1".into(), vec![1, 2, 3], 2, |value| {
            Ok(value.to_string())
        })
        .unwrap();
        assert_eq!(page.items, [1, 2]);
        assert_eq!(page.after.as_deref(), Some("2"));
        let final_page = SnapshotPage::from_lookahead("version:1".into(), vec![3, 4], 2, |_| {
            panic!("a complete page has no continuation cursor")
        })
        .unwrap();
        assert_eq!(final_page.items, [3, 4]);
        assert!(final_page.after.is_none());
        let empty = SnapshotPage::from_lookahead("version:1".into(), Vec::<i32>::new(), 2, |_| {
            panic!("an empty page has no cursor")
        })
        .unwrap();
        assert!(empty.items.is_empty());
    }

    #[test]
    fn invalid_limits_overfull_adapters_and_empty_cursors_are_rejected() {
        assert!(SnapshotPage::from_lookahead("v".into(), vec![1], 0, |_| Ok("a".into())).is_err());
        assert!(
            SnapshotPage::from_lookahead("v".into(), vec![1, 2, 3], 1, |_| Ok("a".into())).is_err()
        );
        assert!(
            SnapshotPage::from_lookahead("v".into(), vec![1, 2], 1, |_| Ok(String::new())).is_err()
        );
    }
}
