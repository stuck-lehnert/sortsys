//! Resolve logical business records in one content epoch. Accounts, access
//! grants, evidence and immutable file blocks retain their current identities.
use sortsys_zerotrust::{
    anchors::{ANCHOR_COLLECTION, RecordAnchor, RecordBinding, RecordCheckpoint},
    content_epoch::{ContentEpoch, ContentPin, content_pin_key, namespace_record},
    metadata::RecordKey,
};

use super::*;

pub(crate) fn head_key() -> RecordKey {
    sortsys_zerotrust::content_epoch::head_key()
}

/// Deliberate application classification, not an inferred default for future
/// collections. File blocks and invoice/delivery counters are append-only.
pub(crate) fn collection(name: &str) -> bool {
    if let Some(hash) = name.strip_prefix("objects-") {
        return sortsys_zerotrust::crypto::sized::<32>(hash).is_ok();
    }
    if name.starts_with("live-messages-") || name.starts_with("live-presence-") {
        return true;
    }
    matches!(
        name,
        "object-locations"
            | "object-history"
            | "object-changes"
            | "object-deletions"
            | "documents"
            | "document-history"
            | "live-checkpoint-heads"
            | "live-checkpoint-proofs"
            | "live-message-receipts"
            | "live-rooms"
            | "stock-references"
            | "stock-deletions"
            | "delivery-placements"
            | "project-planning-titles"
    )
}

#[derive(Default)]
pub(super) struct ContentState {
    head: SelectedContent,
    resolved: BTreeMap<(String, String), RecordKey>,
    pub(super) versions: BTreeMap<String, String>,
}

#[derive(Default)]
enum SelectedContent {
    #[default]
    Unobserved,
    Original,
    Restored(Box<ContentEpoch>),
}

impl SelectedContent {
    fn number(&self) -> RpcResult<&str> {
        match self {
            Self::Unobserved => Err(unavailable()),
            Self::Original => Ok("0"),
            Self::Restored(head) => Ok(&head.number),
        }
    }
}

enum ContentCandidate {
    Current(Read<serde_json::Value>),
    Pinned(ContentPin),
}

fn check_pin(pin: &ContentPin, logical: &RecordKey, current: &str) -> RpcResult<()> {
    pin.validate()?;
    if pin.record != *logical || content_number(&pin.number)? > content_number(current)? {
        return Err(unavailable());
    }
    Ok(())
}

impl Transaction {
    async fn content_head(&mut self) -> RpcResult<Option<ContentEpoch>> {
        match &self.content.head {
            SelectedContent::Unobserved => {}
            SelectedContent::Original => return Ok(None),
            SelectedContent::Restored(head) => return Ok(Some(head.as_ref().clone())),
        }
        let Target::Tenant { tenant } = &self.repository.target else {
            self.content.head = SelectedContent::Original;
            return Ok(None);
        };
        let tenant = tenant.clone();
        let record = head_key();
        let value = self.encoded_raw(record).await?;
        let head: Option<ContentEpoch> = value.as_deref().map(decode).transpose()?;
        if let Some(head) = &head {
            head.frame()?;
            sortsys_zerotrust::crypto::sized::<64>(&head.signature)?;
            if head.tenant != tenant {
                return Err(unavailable());
            }
        }
        self.content.head = match &head {
            Some(head) => SelectedContent::Restored(Box::new(head.clone())),
            None => SelectedContent::Original,
        };
        Ok(head)
    }

    /// The authorization layer must verify the signature against its pinned
    /// authority history before returning business data or publishing writes.
    pub(crate) async fn content_epoch(&mut self) -> RpcResult<Option<ContentEpoch>> {
        self.content_head().await
    }

    /// Read the prepared namespace through the normal pin resolver. The
    /// compare-and-swap still observes the previous published head and every
    /// record read from either view until the caller commits or discards it.
    pub(crate) async fn select_prepared_content(&mut self, head: &ContentEpoch) -> RpcResult<()> {
        if !matches!(&self.repository.target, Target::Tenant { tenant } if tenant == &head.tenant)
            || !self.changes.is_empty()
        {
            return Err(conflict());
        }
        self.content_head().await?;
        self.content = ContentState {
            head: SelectedContent::Restored(Box::new(head.clone())),
            ..ContentState::default()
        };
        Ok(())
    }

    pub async fn prefetch(&mut self, records: Vec<RecordKey>) -> RpcResult<()> {
        for record in &records {
            record.validate()?;
            if record.collection.starts_with("zt-data:") {
                return Err(unavailable());
            }
        }
        let tenant_content = matches!(self.repository.target, Target::Tenant { .. })
            && records.iter().any(|record| collection(&record.collection));
        if !tenant_content {
            return self.prefetch_raw(records).await;
        }

        // Read the view head with independent control observations. Later calls
        // reuse only this transaction's read set, never a process-wide view cache.
        let mut control = records
            .iter()
            .filter(|record| !collection(&record.collection))
            .cloned()
            .collect::<Vec<_>>();
        control.push(head_key());
        self.prefetch_raw(control).await?;
        let epoch = self.content_head().await?;
        let number = epoch.as_ref().map_or("0", |head| head.number.as_str());
        let business = records
            .into_iter()
            .filter(|record| collection(&record.collection))
            .collect::<Vec<_>>();
        let mut selected = Vec::new();
        for logical in &business {
            let identity = (logical.collection.clone(), logical.key.clone());
            if self.content.resolved.contains_key(&identity) {
                continue;
            }
            selected.push(namespace_record(logical, number)?);
            if number != "0" {
                selected.push(content_pin_key(logical)?);
            }
        }
        self.prefetch_raw(selected).await?;
        let mut pinned = Vec::new();
        for logical in business {
            let identity = (logical.collection.clone(), logical.key.clone());
            if self.content.resolved.contains_key(&identity) {
                continue;
            }
            let mut physical = namespace_record(&logical, number)?;
            if number != "0"
                && let Some(pin) = self.read_pin(&logical).await?
            {
                physical = pin.physical;
                pinned.push(physical.clone());
            }
            self.content.resolved.insert(identity, physical);
        }
        self.prefetch_raw(pinned).await
    }

    pub(super) async fn physical_record(&mut self, record: &RecordKey) -> RpcResult<RecordKey> {
        record.validate()?;
        if record.collection.starts_with("zt-data:") {
            return Err(unavailable());
        }
        if !collection(&record.collection) || matches!(self.repository.target, Target::System) {
            return Ok(record.clone());
        }
        self.prefetch(vec![record.clone()]).await?;
        self.content
            .resolved
            .get(&(record.collection.clone(), record.key.clone()))
            .cloned()
            .ok_or_else(unavailable)
    }

    async fn read_pin(&mut self, logical: &RecordKey) -> RpcResult<Option<ContentPin>> {
        let encoded = self.encoded_raw(content_pin_key(logical)?).await?;
        let pin: Option<ContentPin> = encoded.as_deref().map(decode).transpose()?;
        if let Some(pin) = &pin {
            check_pin(pin, logical, self.content.head.number()?)?;
        }
        Ok(pin)
    }

    /// Read dependencies of an immutable record from the epoch where it was
    /// retained. The caller identifies the witness and validates the dependency
    /// against it. All physical reads still participate in the transaction.
    pub(crate) async fn many_at_retained_epoch<T: serde::de::DeserializeOwned>(
        &mut self,
        witness: &RecordKey,
        records: Vec<RecordKey>,
    ) -> RpcResult<Vec<Option<T>>> {
        self.content_head().await?;
        let pin = self.read_pin(witness).await?.ok_or_else(unavailable)?;
        self.many_in_content_epoch(&pin.number, records).await
    }

    pub(crate) async fn read_in_selected_epoch<T: serde::de::DeserializeOwned>(
        &mut self,
        record: RecordKey,
    ) -> RpcResult<Option<T>> {
        self.content_head().await?;
        let number = self.content.head.number()?.to_owned();
        Ok(self
            .many_in_content_epoch(&number, vec![record])
            .await?
            .pop()
            .flatten())
    }

    async fn many_in_content_epoch<T: serde::de::DeserializeOwned>(
        &mut self,
        number: &str,
        records: Vec<RecordKey>,
    ) -> RpcResult<Vec<Option<T>>> {
        let physical = records
            .iter()
            .map(|record| {
                if !collection(&record.collection) {
                    return Err(unavailable());
                }
                Ok(namespace_record(record, number)?)
            })
            .collect::<RpcResult<Vec<_>>>()?;
        self.prefetch_raw(physical.clone()).await?;
        let mut values = Vec::with_capacity(physical.len());
        for record in physical {
            values.push(
                self.encoded_raw(record)
                    .await?
                    .as_deref()
                    .map(decode)
                    .transpose()?,
            );
        }
        Ok(values)
    }

    pub(super) async fn pin_content_record(
        &mut self,
        logical: &RecordKey,
        physical: &RecordKey,
    ) -> RpcResult<()> {
        if !collection(&logical.collection) || matches!(self.repository.target, Target::System) {
            return Ok(());
        }
        if let Some(pin) = self.read_pin(logical).await? {
            if pin.physical != *physical {
                return Err(unavailable());
            }
            return Ok(());
        }
        let head = self.content_head().await?;
        let number = head.as_ref().map_or("0", |head| head.number.as_str());
        let pin = ContentPin {
            format: "zt-content-pin-v1".into(),
            record: logical.clone(),
            number: number.into(),
            physical: physical.clone(),
        };
        pin.validate()?;
        let record = content_pin_key(logical)?;
        self.put_raw(record.clone(), &pin).await?;
        let encoded = self
            .encoded_raw(record.clone())
            .await?
            .ok_or_else(unavailable)?;
        let binding = RecordBinding::bind(record.clone(), &encoded)?;
        let checkpoint = RecordCheckpoint::new(vec![binding])?;
        let name = protection_name(&record);
        let previous = self.encoded_raw(key(ANCHOR_COLLECTION, &name)).await?;
        let previous: Option<RecordAnchor> = previous.as_deref().map(decode).transpose()?;
        let previous = previous
            .as_ref()
            .map(|anchor| {
                anchor.validate()?;
                RecordCheckpoint::from_payload(&anchor.payload)?.ok_or_else(unavailable)
            })
            .transpose()?;
        checkpoint.follows(previous.as_ref())?;
        self.anchor(&name, &checkpoint).await
    }

    pub(super) async fn scan_content<T: DeserializeOwned>(
        &mut self,
        collection: &str,
        prefix: Option<&str>,
        after: Option<String>,
        limit: usize,
    ) -> RpcResult<Page<T>> {
        self.scan_content_pages(vec![ScanRange {
            collection: collection.into(),
            prefix: prefix.map(str::to_owned),
            after,
            limit,
        }])
        .await?
        .pop()
        .ok_or_else(unavailable)
    }

    pub(crate) async fn scan_content_pages<T: DeserializeOwned>(
        &mut self,
        ranges: Vec<ScanRange>,
    ) -> RpcResult<Vec<Page<T>>> {
        if ranges.is_empty() {
            return Ok(Vec::new());
        }
        for range in &ranges {
            if !collection(&range.collection) {
                return Err(unavailable());
            }
            if self.content.resolved.iter().any(|((name, _), physical)| {
                name == &range.collection
                    && self
                        .changes
                        .contains_key(&(physical.collection.clone(), physical.key.clone()))
            }) {
                return Err(conflict());
            }
        }
        if matches!(self.repository.target, Target::System) {
            return self.scan_raw_pages(ranges).await;
        }
        let head = self.content_head().await?;
        let Some(head) = head else {
            let names = ranges
                .iter()
                .map(|range| range.collection.clone())
                .collect::<Vec<_>>();
            let pages = self.scan_raw_pages(ranges).await?;
            for (name, page) in names.into_iter().zip(&pages) {
                self.content.versions.insert(name, page.version.clone());
            }
            return Ok(pages);
        };

        let mut physical = Vec::with_capacity(ranges.len() * 2);
        for range in &ranges {
            let sample = key(&range.collection, "sample");
            physical.push(ScanRange {
                collection: namespace_record(&sample, &head.number)?.collection,
                ..range.clone()
            });
            physical.push(ScanRange {
                collection: content_pin_key(&sample)?.collection,
                ..range.clone()
            });
        }
        let mut pages = self
            .scan_raw_pages::<serde_json::Value>(physical)
            .await?
            .into_iter();
        let mut merged = Vec::with_capacity(ranges.len());
        let head_record = head_key();
        let head_version = self.read[&(head_record.collection, head_record.key)]
            .version
            .as_deref()
            .unwrap_or("0");
        for range in ranges {
            let current = pages.next().ok_or_else(unavailable)?;
            let pins = pages.next().ok_or_else(unavailable)?;
            merged.push(merge_content_pages(
                range,
                current,
                pins,
                &head.number,
                head_version,
            )?);
        }
        let retained = merged
            .iter()
            .flat_map(|page| {
                page.rows.values().filter_map(|candidate| match candidate {
                    ContentCandidate::Pinned(pin) => Some(pin.physical.clone()),
                    ContentCandidate::Current(_) => None,
                })
            })
            .collect();
        self.prefetch_raw(retained).await?;
        let mut results = Vec::with_capacity(merged.len());
        for page in merged {
            results.push(self.resolve_merged_content(page).await?);
        }
        Ok(results)
    }

    async fn resolve_merged_content<T: DeserializeOwned>(
        &mut self,
        page: ContentScan,
    ) -> RpcResult<Page<T>> {
        let mut records = Vec::with_capacity(page.rows.len());
        for (id, candidate) in page.rows {
            let logical = key(&page.collection, &id);
            let (physical, value, version) = match candidate {
                ContentCandidate::Pinned(pin) => {
                    let value = self
                        .encoded_raw(pin.physical.clone())
                        .await?
                        .ok_or_else(unavailable)?;
                    let version = self.read
                        [&(pin.physical.collection.clone(), pin.physical.key.clone())]
                        .version
                        .clone();
                    (pin.physical, decode(&value)?, version)
                }
                ContentCandidate::Current(row) => {
                    let value = serde_json::from_value(row.value.ok_or_else(unavailable)?)
                        .map_err(|_| unavailable())?;
                    (row.record, value, row.version)
                }
            };
            self.content
                .resolved
                .insert((page.collection.clone(), id), physical);
            records.push(Read {
                record: logical,
                version,
                value: Some(value),
            });
        }
        self.content
            .versions
            .insert(page.collection, page.version.clone());
        let after = if page.has_more {
            records.last().map(|row| row.record.key.clone())
        } else {
            None
        };
        Ok(Page {
            version: page.version,
            records,
            after,
        })
    }
}

struct ContentScan {
    collection: String,
    rows: BTreeMap<String, ContentCandidate>,
    has_more: bool,
    version: String,
}

fn merge_content_pages(
    range: ScanRange,
    current: Page<serde_json::Value>,
    pins: Page<serde_json::Value>,
    number: &str,
    head_version: &str,
) -> RpcResult<ContentScan> {
    let has_more = current.after.is_some() || pins.after.is_some();
    let mut rows = BTreeMap::new();
    for row in current.records {
        rows.insert(row.record.key.clone(), ContentCandidate::Current(row));
    }
    for row in pins.records {
        let pin: ContentPin = serde_json::from_value(row.value.ok_or_else(unavailable)?)
            .map_err(|_| unavailable())?;
        check_pin(&pin, &key(&range.collection, &row.record.key), number)?;
        rows.insert(pin.record.key.clone(), ContentCandidate::Pinned(pin));
    }
    let has_more = has_more || rows.len() > range.limit;
    // Both source collections and the view head are independently guarded.
    // Their greatest global revision is a stable scalar page version.
    let version = content_number(&current.version)?
        .max(content_number(&pins.version)?)
        .max(content_number(head_version)?)
        .to_string();
    Ok(ContentScan {
        collection: range.collection,
        rows: rows.into_iter().take(range.limit).collect(),
        has_more,
        version,
    })
}

fn content_number(number: &str) -> RpcResult<i64> {
    if number == "0" {
        return Ok(0);
    }
    Ok(sortsys_zerotrust::crypto::revision(number)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn application_content_classification_keeps_security_and_append_only_records_current() {
        let hash = sortsys_zerotrust::crypto::encode(&[7; 32]);
        assert!(collection(&format!("objects-{hash}")));
        assert!(!collection(&format!("objects-{}", "a".repeat(64))));
        for name in [
            "documents",
            "object-locations",
            "object-history",
            "live-messages-room",
            "stock-references",
            "delivery-placements",
        ] {
            assert!(collection(name), "{name}");
        }
        for name in [
            "accounts",
            "policies",
            "domain-access",
            "domains",
            "key-envelopes",
            "file-chunks",
            "delivery-state",
            "timestamp-targets",
            "tool-booking-command-bindings",
            "tool-booking-commands",
            "zt-content-epochs",
            "unknown-future-collection",
        ] {
            assert!(!collection(name), "{name}");
        }
    }

    #[test]
    fn pins_require_the_exact_logical_identity_and_an_existing_content_epoch() {
        let record = key("documents", "first");
        let pin = ContentPin {
            format: "zt-content-pin-v1".into(),
            record: record.clone(),
            number: "2".into(),
            physical: namespace_record(&record, "2").unwrap(),
        };
        check_pin(&pin, &record, "2").unwrap();
        check_pin(&pin, &record, "3").unwrap();
        assert!(check_pin(&pin, &record, "1").is_err());
        assert!(check_pin(&pin, &key("documents", "other"), "2").is_err());
        let mut wrong_namespace = pin;
        wrong_namespace.physical.collection = "documents".into();
        assert!(check_pin(&wrong_namespace, &record, "2").is_err());
    }
}
