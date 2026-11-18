//! Typed API control records in the shared DuckDB service. Business plaintext
//! never belongs here. A transaction guards everything it read at publication.
use std::collections::{BTreeMap, HashSet};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};
use sortsys_store::{
    CipherStore, StoreError,
    metadata::{RecordPage, ScanRequest, Target},
};
use sortsys_zerotrust::metadata::{
    CollectionCheck, MetadataBatch, MetadataHint, MetadataReceipt, MetadataRecord, RecordCheck,
    RecordKey, RecordPut,
};

use crate::error::{ErrorCode, RpcError, RpcResult};

pub mod accounts;
pub(crate) mod content;
pub mod tenants;

#[derive(Clone)]
pub struct Repository {
    store: CipherStore,
    target: Target,
}

pub struct Read<T> {
    pub record: RecordKey,
    pub version: Option<String>,
    pub value: Option<T>,
}

pub struct Page<T> {
    pub version: String,
    pub records: Vec<Read<T>>,
    pub after: Option<String>,
}

#[derive(Clone)]
pub(crate) struct ScanRange {
    pub collection: String,
    pub prefix: Option<String>,
    pub after: Option<String>,
    pub limit: usize,
}

pub struct Transaction {
    repository: Repository,
    operation: String,
    read: BTreeMap<(String, String), MetadataRecord>,
    collections: BTreeMap<String, String>,
    changes: BTreeMap<(String, String), Option<String>>,
    hints: Vec<MetadataHint>,
    journal: Vec<sortsys_zerotrust::journal::JournalAppend>,
    content: content::ContentState,
}

#[derive(Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Expiration {
    record: RecordKey,
    fingerprint: String,
    expires_at: DateTime<Utc>,
}

pub(crate) fn fingerprint(value: &str) -> String {
    sortsys_zerotrust::crypto::encode(&Sha256::digest(value.as_bytes()))
}

fn expiry_head(record: &RecordKey) -> RecordKey {
    let identity = fingerprint(&format!("{}\0{}", record.collection, record.key));
    key("control-expiry-heads", &format!("e_{identity}"))
}

fn protection_name(record: &RecordKey) -> String {
    let identity = fingerprint(&format!("{}\0{}", record.collection, record.key));
    format!("record-{identity}")
}

pub fn key(collection: &str, key: &str) -> RecordKey {
    RecordKey {
        collection: collection.into(),
        key: key.into(),
    }
}

pub fn unavailable() -> RpcError {
    RpcError::new(
        ErrorCode::InternalServerError,
        "Control storage unavailable",
    )
    .with_http_code(503)
}

pub fn conflict() -> RpcError {
    RpcError::new(ErrorCode::Conflict, "Control state changed")
        .with_http_code(409)
        .retryable_snapshot()
}

/// Repeat an entire read after an optimistic snapshot race, including its
/// authorization. Callers must not perform writes or external side effects.
pub(crate) async fn read_snapshot<T, Read, Pending>(mut read: Read) -> RpcResult<T>
where
    Read: FnMut() -> Pending,
    Pending: std::future::Future<Output = RpcResult<T>>,
{
    for attempt in 0..4 {
        let result = read().await;
        let raced = result
            .as_ref()
            .err()
            .is_some_and(|error| error.retry_snapshot_query);
        if !raced || attempt == 3 {
            return result;
        }
        tokio::time::sleep(std::time::Duration::from_millis(1 << attempt)).await;
    }
    unreachable!("the last read attempt always returns")
}

fn storage(error: StoreError) -> RpcError {
    match error {
        StoreError::Conflict => conflict(),
        error => {
            // StoreError exposes fixed operation labels, never SQL, tokens,
            // request bodies or decrypted application content.
            tracing::warn!(error = %error, "Shared store operation failed");
            unavailable()
        }
    }
}

fn decode<T: DeserializeOwned>(value: &str) -> RpcResult<T> {
    serde_json::from_str(value).map_err(|_| unavailable())
}

impl Repository {
    pub(crate) fn storage(&self) -> &CipherStore {
        &self.store
    }

    pub fn system(store: CipherStore) -> Self {
        Self {
            store,
            target: Target::System,
        }
    }

    pub fn tenant(&self, tenant: &str) -> RpcResult<Self> {
        sortsys_zerotrust::crypto::identifier(tenant)?;
        Ok(Self {
            store: self.store.clone(),
            target: Target::Tenant {
                tenant: tenant.into(),
            },
        })
    }

    pub async fn read<T: DeserializeOwned>(&self, record: RecordKey) -> RpcResult<Read<T>> {
        if record.collection.starts_with("zt-data:") {
            return Err(unavailable());
        }
        if content::collection(&record.collection) {
            let mut transaction = self.transaction()?;
            let physical = transaction.physical_record(&record).await?;
            let value = transaction.read(record.clone()).await?;
            let version = transaction.read[&(physical.collection, physical.key)]
                .version
                .clone();
            transaction.validate().await?;
            return Ok(Read {
                record,
                version,
                value,
            });
        }
        let mut rows = self.read_records(vec![record]).await?;
        let row = rows.remove(0);
        Ok(Read {
            record: row.record,
            version: row.version,
            value: row.value.as_deref().map(decode).transpose()?,
        })
    }

    async fn read_records(&self, keys: Vec<RecordKey>) -> RpcResult<Vec<MetadataRecord>> {
        let records = self
            .store
            .metadata_read(self.target.clone(), keys.clone())
            .await
            .map_err(storage)?;
        if records.len() != keys.len() {
            return Err(unavailable());
        }
        for (record, expected) in records.iter().zip(keys) {
            if record.record != expected || record.version.is_some() != record.value.is_some() {
                return Err(unavailable());
            }
        }
        Ok(records)
    }

    pub async fn scan<T: DeserializeOwned>(
        &self,
        collection: &str,
        after: Option<String>,
        version: Option<String>,
    ) -> RpcResult<Page<T>> {
        self.scan_prefix(collection, None, after, version, 128)
            .await
    }

    pub async fn scan_prefix<T: DeserializeOwned>(
        &self,
        collection: &str,
        prefix: Option<&str>,
        after: Option<String>,
        version: Option<String>,
        limit: usize,
    ) -> RpcResult<Page<T>> {
        if collection.starts_with("zt-data:") {
            return Err(unavailable());
        }
        if content::collection(collection) {
            let mut transaction = self.transaction()?;
            let page = transaction
                .scan_filtered(collection, prefix, after, limit)
                .await?;
            if version.is_some_and(|version| version != page.version) {
                return Err(conflict());
            }
            transaction.validate().await?;
            return Ok(page);
        }
        self.scan_records(collection, prefix, after, version, limit)
            .await
    }

    async fn scan_records<T: DeserializeOwned>(
        &self,
        collection: &str,
        prefix: Option<&str>,
        after: Option<String>,
        version: Option<String>,
        limit: usize,
    ) -> RpcResult<Page<T>> {
        let input = ScanRequest {
            target: self.target.clone(),
            collection: collection.into(),
            after,
            version,
            prefix: prefix.map(str::to_owned),
            limit: Some(limit),
        };
        self.scan_record_page(&input).await
    }

    async fn scan_record_page<T: DeserializeOwned>(
        &self,
        input: &ScanRequest,
    ) -> RpcResult<Page<T>> {
        let page = self.store.metadata_scan(input).await.map_err(storage)?;
        Self::decode_page(page, input)
    }

    async fn scan_record_pages<T: DeserializeOwned>(
        &self,
        inputs: &[ScanRequest],
    ) -> RpcResult<Vec<Page<T>>> {
        match inputs {
            [] => return Ok(Vec::new()),
            [input] => return Ok(vec![self.scan_record_page(input).await?]),
            _ => {}
        }
        let pages = match self.store.metadata_scan_batch(inputs).await {
            Ok(pages) => pages,
            Err(StoreError::BatchTooLarge) => {
                // Decode each bounded page before fetching the next one.
                let mut pages = Vec::with_capacity(inputs.len());
                for input in inputs {
                    pages.push(self.scan_record_page(input).await?);
                }
                return Ok(pages);
            }
            Err(error) => return Err(storage(error)),
        };
        if pages.len() != inputs.len() {
            return Err(unavailable());
        }
        pages
            .into_iter()
            .zip(inputs)
            .map(|(page, input)| Self::decode_page(page, input))
            .collect()
    }

    fn decode_page<T: DeserializeOwned>(
        page: RecordPage,
        input: &ScanRequest,
    ) -> RpcResult<Page<T>> {
        let limit = input.limit.unwrap_or(128);
        if page.records.len() > limit
            || page
                .records
                .windows(2)
                .any(|rows| rows[0].record.key >= rows[1].record.key)
            || page.after.as_deref().is_some_and(|after| {
                page.records.len() != limit
                    || page.records.last().map(|row| row.record.key.as_str()) != Some(after)
            })
        {
            return Err(unavailable());
        }
        let mut records = Vec::with_capacity(page.records.len());
        let prefix = input.prefix.as_deref().unwrap_or("");
        let lower = input.after.as_deref().unwrap_or("");
        for row in page.records {
            if row.record.collection != input.collection
                || !row.record.key.starts_with(prefix)
                || row.record.key.as_str() <= lower
                || row.version.is_none()
                || row.value.is_none()
            {
                return Err(unavailable());
            }
            let value = row.value.as_deref().map(decode).transpose()?;
            records.push(Read {
                record: row.record,
                version: row.version,
                value,
            });
        }
        Ok(Page {
            version: page.version,
            records,
            after: page.after,
        })
    }

    fn ciphertext_tenant(&self) -> RpcResult<&str> {
        match &self.target {
            Target::Tenant { tenant } => Ok(tenant),
            Target::System => Err(unavailable()),
        }
    }
    pub async fn put_ciphertext(&self, data: String) -> RpcResult<String> {
        self.store
            .put(self.ciphertext_tenant()?, data)
            .await
            .map_err(storage)
    }

    pub async fn put_ciphertexts(&self, data: Vec<String>) -> RpcResult<Vec<String>> {
        self.store
            .put_many(self.ciphertext_tenant()?, data)
            .await
            .map_err(storage)
    }
    pub async fn ciphertext(&self, reference: &str) -> RpcResult<String> {
        self.store
            .get(self.ciphertext_tenant()?, reference)
            .await
            .map_err(storage)
    }
    pub async fn ciphertext_prefix(
        &self,
        references: Vec<String>,
        maximum: usize,
    ) -> RpcResult<Vec<String>> {
        self.store
            .get_prefix(self.ciphertext_tenant()?, references, maximum)
            .await
            .map_err(storage)
    }

    pub async fn ciphertext_prefixes(
        &self,
        references: Vec<Vec<String>>,
        page_budget: usize,
        total_budget: usize,
    ) -> RpcResult<Vec<Vec<String>>> {
        self.store
            .get_prefixes(
                self.ciphertext_tenant()?,
                references,
                page_budget,
                total_budget,
            )
            .await
            .map_err(|error| match error {
                StoreError::BatchTooLarge => RpcError::new(
                    ErrorCode::BadRequest,
                    "Ciphertext batch exceeds the response limit",
                )
                .with_http_code(413),
                error => storage(error),
            })
    }

    pub fn transaction(&self) -> RpcResult<Transaction> {
        Ok(Transaction {
            repository: self.clone(),
            operation: sortsys_zerotrust::crypto::random_id()?,
            read: BTreeMap::new(),
            collections: BTreeMap::new(),
            changes: BTreeMap::new(),
            hints: vec![],
            journal: vec![],
            content: content::ContentState::default(),
        })
    }

    pub async fn journal_get(
        &self,
        stream: &str,
        id: &str,
    ) -> RpcResult<Option<sortsys_zerotrust::journal::JournalEntry>> {
        self.store
            .journal_get(self.target.clone(), stream.into(), id.into())
            .await
            .map_err(storage)
    }
    pub async fn journal_origins(
        &self,
        objects: Vec<RecordKey>,
    ) -> RpcResult<Vec<Option<sortsys_zerotrust::journal::JournalEntry>>> {
        self.store
            .journal_origins(self.target.clone(), objects)
            .await
            .map_err(storage)
    }

    pub async fn journal_list(
        &self,
        query: sortsys_zerotrust::journal::JournalQuery,
    ) -> RpcResult<sortsys_zerotrust::journal::JournalPage> {
        self.store
            .journal_list(self.target.clone(), query)
            .await
            .map_err(storage)
    }
    pub async fn changes(
        &self,
        after: Option<String>,
        wait_ms: u32,
    ) -> RpcResult<sortsys_store::metadata::ChangesPage> {
        self.store
            .metadata_changes(self.target.clone(), after, wait_ms)
            .await
            .map_err(storage)
    }
    pub async fn cleanup_expired(&self) -> RpcResult<()> {
        let page = self
            .scan::<Expiration>("control-expiries", None, None)
            .await?;
        for entry in page.records {
            let scanned = entry.value.ok_or_else(unavailable)?;
            if scanned.expires_at > Utc::now() {
                break;
            }
            let mut transaction = self.transaction()?;
            let Some(expiration) = transaction.read::<Expiration>(entry.record.clone()).await?
            else {
                continue;
            };
            if expiration.expires_at > Utc::now() {
                continue;
            }
            let head_key = expiry_head(&expiration.record);
            let head: Option<Expiration> = transaction.read(head_key.clone()).await?;
            if head.as_ref() == Some(&expiration) {
                let current = transaction.encoded(expiration.record.clone()).await?;
                if current
                    .as_deref()
                    .is_some_and(|value| fingerprint(value) == expiration.fingerprint)
                {
                    transaction.delete(expiration.record).await?;
                }
                transaction.delete(head_key).await?;
            }
            transaction.delete(entry.record).await?;
            match transaction.commit().await {
                Ok(_) => {}
                Err(error) if error.code == ErrorCode::Conflict => continue,
                Err(error) => return Err(error),
            }
        }
        Ok(())
    }
}

impl Transaction {
    pub fn append<T: Serialize>(
        &mut self,
        stream: &str,
        id: &str,
        object: &str,
        occurred_micros: &str,
        order: Option<String>,
        value: &T,
    ) -> RpcResult<()> {
        let entry = sortsys_zerotrust::journal::JournalAppend {
            stream: stream.into(),
            id: id.into(),
            object: object.into(),
            occurred_micros: occurred_micros.into(),
            order,
            value: serde_json::to_string(value).map_err(|_| unavailable())?,
        };
        entry.validate()?;
        self.journal.push(entry);
        Ok(())
    }
    pub fn notify(&mut self, channel: &str, value: &serde_json::Value) -> RpcResult<()> {
        self.hints.push(MetadataHint {
            channel: channel.into(),
            value: serde_json::to_string(value).map_err(|_| unavailable())?,
        });
        Ok(())
    }

    pub async fn all<T: DeserializeOwned>(
        &mut self,
        collection: &str,
        maximum: usize,
    ) -> RpcResult<Vec<T>> {
        let mut after = None;
        let mut result = Vec::new();
        loop {
            let page = self.scan(collection, after).await?;
            for row in page.records {
                result.push(row.value.ok_or_else(unavailable)?);
            }
            if result.len() > maximum {
                return Err(unavailable());
            }
            after = page.after;
            if after.is_none() {
                return Ok(result);
            }
        }
    }

    /// Finish a read only if every observed record and collection still belongs
    /// to the same snapshot. This creates no write receipt or change event.
    pub async fn validate(self) -> RpcResult<()> {
        if !self.changes.is_empty() || !self.hints.is_empty() || !self.journal.is_empty() {
            return Err(unavailable());
        }
        let checks = self
            .read
            .into_values()
            .map(|row| RecordCheck {
                record: row.record,
                version: row.version,
            })
            .collect();
        let collections = self
            .collections
            .into_iter()
            .map(|(collection, version)| CollectionCheck {
                collection,
                version,
            })
            .collect();
        self.repository
            .store
            .metadata_validate(
                self.repository.target,
                MetadataBatch {
                    operation: self.operation,
                    checks,
                    collections,
                    puts: vec![],
                    deletes: vec![],
                    hints: vec![],
                    journal: vec![],
                },
            )
            .await
            .map_err(storage)
    }

    /// Enumerate before changing this collection. The collection version guards
    /// the entire result, including absent records, at commit. Following pages
    /// must use the same version, even if another API instance is writing.
    pub async fn scan<T: DeserializeOwned>(
        &mut self,
        collection: &str,
        after: Option<String>,
    ) -> RpcResult<Page<T>> {
        self.scan_with_limit(collection, after, 128).await
    }

    pub async fn scan_with_limit<T: DeserializeOwned>(
        &mut self,
        collection: &str,
        after: Option<String>,
        limit: usize,
    ) -> RpcResult<Page<T>> {
        self.scan_filtered(collection, None, after, limit).await
    }

    /// Observe a collection's version without enumerating its full inventory.
    /// The observation participates in this transaction's CAS validation.
    pub async fn collection_version(&mut self, collection: &str) -> RpcResult<String> {
        if let Some(version) = self.content.versions.get(collection) {
            return Ok(version.clone());
        }
        if let Some(version) = self.collections.get(collection) {
            return Ok(version.clone());
        }
        Ok(self
            .scan_with_limit::<serde_json::Value>(collection, None, 1)
            .await?
            .version)
    }

    pub async fn scan_prefix<T: DeserializeOwned>(
        &mut self,
        collection: &str,
        prefix: &str,
        after: Option<String>,
        limit: usize,
    ) -> RpcResult<Page<T>> {
        self.scan_filtered(collection, Some(prefix), after, limit)
            .await
    }

    async fn scan_filtered<T: DeserializeOwned>(
        &mut self,
        collection: &str,
        prefix: Option<&str>,
        after: Option<String>,
        limit: usize,
    ) -> RpcResult<Page<T>> {
        if collection.starts_with("zt-data:") {
            return Err(unavailable());
        }
        if content::collection(collection) {
            return self.scan_content(collection, prefix, after, limit).await;
        }
        self.scan_raw(collection, prefix, after, limit).await
    }

    async fn scan_raw<T: DeserializeOwned>(
        &mut self,
        collection: &str,
        prefix: Option<&str>,
        after: Option<String>,
        limit: usize,
    ) -> RpcResult<Page<T>> {
        self.scan_raw_pages(vec![ScanRange {
            collection: collection.into(),
            prefix: prefix.map(str::to_owned),
            after,
            limit,
        }])
        .await?
        .pop()
        .ok_or_else(unavailable)
    }

    async fn scan_raw_pages<T: DeserializeOwned>(
        &mut self,
        ranges: Vec<ScanRange>,
    ) -> RpcResult<Vec<Page<T>>> {
        let mut inputs = Vec::with_capacity(ranges.len());
        for range in ranges {
            if self
                .changes
                .keys()
                .any(|(changed, _)| *changed == range.collection)
            {
                return Err(conflict());
            }
            inputs.push(ScanRequest {
                target: self.repository.target.clone(),
                version: self.collections.get(&range.collection).cloned(),
                collection: range.collection,
                prefix: range.prefix,
                after: range.after,
                limit: Some(range.limit),
            });
        }
        let pages = self.repository.scan_record_pages(&inputs).await?;
        for (input, page) in inputs.into_iter().zip(&pages) {
            if self
                .collections
                .get(&input.collection)
                .is_some_and(|version| version != &page.version)
            {
                return Err(conflict());
            }
            self.collections
                .insert(input.collection, page.version.clone());
        }
        Ok(pages)
    }

    async fn observe(&mut self, record: RecordKey) -> RpcResult<()> {
        let identity = (record.collection.clone(), record.key.clone());
        if !self.read.contains_key(&identity) {
            let mut rows = self.repository.read_records(vec![record]).await?;
            self.read.insert(identity, rows.remove(0));
        }
        Ok(())
    }

    pub async fn read<T: DeserializeOwned>(&mut self, record: RecordKey) -> RpcResult<Option<T>> {
        self.encoded(record)
            .await?
            .as_deref()
            .map(decode)
            .transpose()
    }

    pub async fn many<T: DeserializeOwned>(
        &mut self,
        keys: Vec<RecordKey>,
    ) -> RpcResult<Vec<Option<T>>> {
        self.prefetch(keys.clone()).await?;
        let mut values = Vec::with_capacity(keys.len());
        for key in keys {
            values.push(self.read(key).await?);
        }
        Ok(values)
    }

    async fn prefetch_raw(&mut self, keys: Vec<RecordKey>) -> RpcResult<()> {
        let mut selected = HashSet::new();
        let missing = keys
            .into_iter()
            .filter(|key| {
                let identity = (key.collection.clone(), key.key.clone());
                !self.read.contains_key(&identity) && selected.insert(identity)
            })
            .collect::<Vec<_>>();
        for group in missing.chunks(sortsys_zerotrust::metadata::MAX_OPERATIONS) {
            for row in self.repository.read_records(group.to_vec()).await? {
                self.read
                    .insert((row.record.collection.clone(), row.record.key.clone()), row);
            }
        }
        Ok(())
    }

    /// Observe planned writes and their durable checkpoints in bounded reads.
    /// Missing records remain part of the commit's compare-and-swap checks.
    pub async fn prefetch_protected(&mut self, records: Vec<RecordKey>) -> RpcResult<()> {
        use sortsys_zerotrust::anchors::ANCHOR_COLLECTION;

        let mut keys = Vec::with_capacity(records.len().saturating_mul(2));
        for record in records {
            keys.push(key(ANCHOR_COLLECTION, &protection_name(&record)));
            if content::collection(&record.collection) {
                let pin = sortsys_zerotrust::content_epoch::content_pin_key(&record)?;
                keys.push(key(ANCHOR_COLLECTION, &protection_name(&pin)));
                keys.push(pin);
            }
            keys.push(record);
        }
        self.prefetch(keys).await
    }

    async fn encoded(&mut self, record: RecordKey) -> RpcResult<Option<String>> {
        let record = self.physical_record(&record).await?;
        self.encoded_raw(record).await
    }

    async fn encoded_raw(&mut self, record: RecordKey) -> RpcResult<Option<String>> {
        self.observe(record.clone()).await?;
        let identity = (record.collection, record.key);
        let value = match self.changes.get(&identity) {
            Some(value) => value,
            None => &self.read[&identity].value,
        };
        Ok(value.clone())
    }

    pub async fn put<T: Serialize + ?Sized>(
        &mut self,
        record: RecordKey,
        value: &T,
    ) -> RpcResult<()> {
        let record = self.physical_record(&record).await?;
        self.put_raw(record, value).await
    }

    async fn put_raw<T: Serialize + ?Sized>(
        &mut self,
        record: RecordKey,
        value: &T,
    ) -> RpcResult<()> {
        self.observe(record.clone()).await?;
        let encoded = serde_json::to_string(value).map_err(|_| unavailable())?;
        self.changes
            .insert((record.collection, record.key), Some(encoded));
        Ok(())
    }

    /// Advance a public record whose durable witness survives a tenant restore.
    /// The application still owns authorization and payload signature checks.
    pub async fn anchor<T: Serialize + ?Sized>(
        &mut self,
        name: &str,
        payload: &T,
    ) -> RpcResult<()> {
        use sortsys_zerotrust::anchors::{ANCHOR_COLLECTION, RecordAnchor};
        let record = key(ANCHOR_COLLECTION, name);
        self.observe(record.clone()).await?;
        // Several commands may update one head inside a transaction. All of
        // them replace its pending payload but advance the committed head once.
        let observed = &self.read[&(record.collection.clone(), record.key.clone())];
        let previous: Option<RecordAnchor> = observed.value.as_deref().map(decode).transpose()?;
        let payload = serde_json::to_string(payload).map_err(|_| unavailable())?;
        let next = match previous {
            Some(previous) => previous.next(payload)?,
            None => RecordAnchor::initial(payload)?,
        };
        self.put_raw(record, &next).await
    }

    /// Bind opaque values to an independent checkpoint in the same publication.
    /// A checkpoint keeps its prior record identities when the owning object
    /// advances; older evidence cannot disappear during a later update.
    pub async fn protect_records(&mut self, name: &str, records: &[RecordKey]) -> RpcResult<()> {
        use sortsys_zerotrust::anchors::{
            ANCHOR_COLLECTION, RecordAnchor, RecordBinding, RecordCheckpoint,
        };

        self.prefetch_protected(records.to_vec()).await?;
        let anchor_key = key(ANCHOR_COLLECTION, name);
        let previous = self.read::<RecordAnchor>(anchor_key).await?;
        let previous = previous
            .as_ref()
            .map(|anchor| {
                anchor.validate()?;
                RecordCheckpoint::from_payload(&anchor.payload)?.ok_or_else(unavailable)
            })
            .transpose()?;
        let mut bindings = BTreeMap::new();
        if let Some(previous) = &previous {
            for binding in &previous.records {
                bindings.insert(
                    (
                        binding.record.collection.clone(),
                        binding.record.key.clone(),
                    ),
                    binding.clone(),
                );
            }
        }
        for record in records {
            let physical = self.physical_record(record).await?;
            let value = self
                .encoded_raw(physical.clone())
                .await?
                .ok_or_else(unavailable)?;
            let binding = RecordBinding::bind(physical.clone(), &value)?;
            bindings.insert((physical.collection.clone(), physical.key.clone()), binding);
            self.pin_content_record(record, &physical).await?;
        }
        let checkpoint = RecordCheckpoint::new(bindings.into_values().collect())?;
        checkpoint.follows(previous.as_ref())?;
        self.anchor(name, &checkpoint).await
    }

    /// Give one opaque control record a stable checkpoint of its own.
    pub async fn protect_record(&mut self, record: RecordKey) -> RpcResult<()> {
        self.protect_records(&protection_name(&record), &[record])
            .await
    }

    pub async fn put_protected<T: Serialize + ?Sized>(
        &mut self,
        record: RecordKey,
        value: &T,
    ) -> RpcResult<()> {
        self.put(record.clone(), value).await?;
        self.protect_record(record).await
    }

    pub async fn put_expiring<T: Serialize + ?Sized>(
        &mut self,
        record: RecordKey,
        value: &T,
        expires_at: DateTime<Utc>,
    ) -> RpcResult<()> {
        if expires_at.timestamp_micros() < 0 || record.collection == "control-expiries" {
            return Err(unavailable());
        }
        self.put(record.clone(), value).await?;
        let encoded = self
            .encoded(record.clone())
            .await?
            .ok_or_else(unavailable)?;
        let identity = fingerprint(&format!("{}\0{}", record.collection, record.key));
        let expiry_key = format!("{:020}:{identity}", expires_at.timestamp_micros());
        let expiration = Expiration {
            record,
            fingerprint: fingerprint(&encoded),
            expires_at,
        };
        self.put(expiry_head(&expiration.record), &expiration)
            .await?;
        self.put(key("control-expiries", &expiry_key), &expiration)
            .await
    }

    pub async fn delete(&mut self, record: RecordKey) -> RpcResult<()> {
        let record = self.physical_record(&record).await?;
        self.observe(record.clone()).await?;
        self.changes.insert((record.collection, record.key), None);
        Ok(())
    }

    pub async fn commit(self) -> RpcResult<MetadataReceipt> {
        let checks = self
            .read
            .into_values()
            .map(|row| RecordCheck {
                record: row.record,
                version: row.version,
            })
            .collect();
        let mut puts = Vec::new();
        let mut deletes = Vec::new();
        for ((collection, key), value) in self.changes {
            let record = RecordKey { collection, key };
            match value {
                Some(value) => puts.push(RecordPut { record, value }),
                None => deletes.push(record),
            }
        }
        let batch = MetadataBatch {
            operation: self.operation,
            checks,
            collections: self
                .collections
                .into_iter()
                .map(|(collection, version)| CollectionCheck {
                    collection,
                    version,
                })
                .collect(),
            puts,
            deletes,
            hints: self.hints,
            journal: self.journal,
        };
        // A response can be lost after commit. Retry the identical operation,
        // never rerun an account mutation against a different starting state.
        for attempt in 0..2 {
            match self
                .repository
                .store
                .metadata_transact_ref(self.repository.target.clone(), &batch)
                .await
            {
                Ok(receipt) => return Ok(receipt),
                Err(StoreError::Unavailable(_)) if attempt == 0 => continue,
                Err(error) => return Err(storage(error)),
            }
        }
        Err(unavailable())
    }
}
