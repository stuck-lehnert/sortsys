//! Resolve logical business records in one content epoch. Accounts, access
//! grants, evidence and immutable file blocks retain their current identities.
use sortsys_zerotrust::{
    anchors::{ANCHOR_COLLECTION, RecordAnchor, RecordBinding, RecordCheckpoint},
    content_epoch::{ContentEpoch, ContentPin, content_pin_key, namespace_record},
    metadata::RecordKey,
};

use super::*;

pub(crate) fn head_key() -> RecordKey {
    key("zt-content-epochs", "current")
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
        if matches!(self.repository.target, Target::System) {
            return self.scan_raw(collection, prefix, after, limit).await;
        }
        if self
            .content
            .resolved
            .iter()
            .any(|((logical, _), physical)| {
                logical == collection
                    && self
                        .changes
                        .contains_key(&(physical.collection.clone(), physical.key.clone()))
            })
        {
            return Err(conflict());
        }
        let head = self.content_head().await?;
        let number = head.as_ref().map_or("0", |head| head.number.as_str());
        let sample = key(collection, "sample");
        let physical = namespace_record(&sample, number)?.collection;
        if number == "0" {
            let current = self.scan_raw::<T>(&physical, prefix, after, limit).await?;
            self.content
                .versions
                .insert(collection.into(), current.version.clone());
            return Ok(current);
        }
        let current = self
            .scan_raw::<serde_json::Value>(&physical, prefix, after.clone(), limit)
            .await?;
        let pin_collection = content_pin_key(&sample)?.collection;
        let pins = self
            .scan_raw::<ContentPin>(&pin_collection, prefix, after, limit)
            .await?;
        let has_more = current.after.is_some() || pins.after.is_some();
        let mut selected = BTreeMap::new();
        for row in current.records {
            selected.insert(row.record.key.clone(), ContentCandidate::Current(row));
        }
        for row in pins.records {
            let pin = row.value.ok_or_else(unavailable)?;
            check_pin(&pin, &key(collection, &row.record.key), number)?;
            selected.insert(pin.record.key.clone(), ContentCandidate::Pinned(pin));
        }
        let has_more = has_more || selected.len() > limit;
        let selected = selected.into_iter().take(limit).collect::<Vec<_>>();
        let reads = selected
            .iter()
            .filter_map(|(_, candidate)| match candidate {
                ContentCandidate::Pinned(pin) => Some(pin.physical.clone()),
                ContentCandidate::Current(_) => None,
            })
            .collect();
        self.prefetch_raw(reads).await?;
        let mut records = Vec::new();
        for (id, candidate) in selected {
            let logical = key(collection, &id);
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
                .insert((collection.into(), id), physical);
            records.push(Read {
                record: logical,
                version,
                value: Some(value),
            });
        }
        // Both source collections and the view head are independently guarded.
        // Their greatest global revision is a stable scalar page version.
        let head_record = head_key();
        let head_version = self.read[&(head_record.collection, head_record.key)]
            .version
            .as_deref()
            .unwrap_or("0");
        let version = [
            current.version.as_str(),
            pins.version.as_str(),
            head_version,
        ]
        .into_iter()
        .map(content_number)
        .collect::<RpcResult<Vec<_>>>()?
        .into_iter()
        .max()
        .ok_or_else(unavailable)?
        .to_string();
        self.content
            .versions
            .insert(collection.into(), version.clone());
        let after = if has_more {
            records.last().map(|row| row.record.key.clone())
        } else {
            None
        };
        Ok(Page {
            version,
            records,
            after,
        })
    }
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
