use std::{
    collections::{BTreeMap, BTreeSet, HashSet},
    sync::{Arc, Mutex},
    time::Duration,
};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use tokio::sync::Semaphore;

use super::{
    MAX_CIPHERTEXT_BYTES, QuackConfig, StoreError, content_id, remote::Remote, tenant_id, valid_id,
};

mod reads;

const MAX_CIPHERTEXT_GROUPS: usize = 16;
const MAX_CIPHERTEXT_GROUP_ITEMS: usize = 64;
const MAX_CIPHERTEXT_READ_BYTES: usize = 2 * MAX_CIPHERTEXT_BYTES;

#[derive(Clone)]
pub struct CipherStore(Arc<Inner>);
struct Inner {
    config: QuackConfig,
    http: reqwest::Client,
    slots: Arc<Semaphore>,
    connections: Mutex<Vec<Remote>>,
    tenants: Mutex<HashSet<String>>,
    reads: Mutex<reads::ReadQueue>,
}
#[derive(Serialize)]
struct TenantRequest<'a> {
    tenant: &'a str,
}
#[derive(Serialize)]
struct SnapshotRequest<'a> {
    tenant: &'a str,
    operation: Option<&'a str>,
}
#[derive(Deserialize)]
struct Provisioned {
    catalog: String,
}
#[derive(Deserialize, Serialize)]
pub struct SnapshotInfo {
    pub id: String,
    pub tenant: String,
    pub bytes: u64,
}

impl CipherStore {
    pub async fn describe_content(
        &self,
        input: &crate::content::DescribeInput,
    ) -> Result<crate::content::Description, StoreError> {
        self.content_request("describe", input).await
    }

    pub async fn prepare_content(
        &self,
        input: &crate::content::PrepareInput,
    ) -> Result<crate::content::Preparation, StoreError> {
        self.content_request("prepare", input).await
    }

    async fn content_request<I: Serialize + ?Sized, O: serde::de::DeserializeOwned>(
        &self,
        action: &str,
        input: &I,
    ) -> Result<O, StoreError> {
        let response = self
            .0
            .http
            .post(format!("{}/content/{action}", self.0.config.control_url))
            .bearer_auth(&*self.0.config.token)
            .timeout(Duration::from_secs(300))
            .json(input)
            .send()
            .await
            .map_err(|_| StoreError::Unavailable("content-transport"))?;
        match response.status() {
            reqwest::StatusCode::CONFLICT => return Err(StoreError::Conflict),
            reqwest::StatusCode::BAD_REQUEST => return Err(StoreError::Integrity),
            reqwest::StatusCode::NOT_FOUND => return Err(StoreError::NotFound),
            status if !status.is_success() => {
                return Err(StoreError::Unavailable("content-response"));
            }
            _ => {}
        }
        response
            .json()
            .await
            .map_err(|_| StoreError::Unavailable("content-decode"))
    }

    pub fn new(config: QuackConfig) -> Result<Self, StoreError> {
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(60))
            .build()
            .map_err(|_| StoreError::Unavailable("http-client"))?;
        Ok(Self(Arc::new(Inner {
            config,
            http,
            slots: Arc::new(Semaphore::new(4)),
            connections: Mutex::new(Vec::new()),
            tenants: Mutex::new(HashSet::new()),
            reads: Mutex::default(),
        })))
    }
    async fn provision(&self, tenant: &str) -> Result<String, StoreError> {
        let id = tenant_id(tenant)?;
        if !self
            .0
            .tenants
            .lock()
            .map_err(|_| StoreError::Unavailable("cache"))?
            .contains(&id)
        {
            let response = self
                .0
                .http
                .post(format!("{}/tenants", self.0.config.control_url))
                .bearer_auth(&*self.0.config.token)
                .json(&TenantRequest { tenant })
                .send()
                .await
                .map_err(|_| StoreError::Unavailable("provision"))?;
            if !response.status().is_success() {
                return Err(StoreError::Unavailable("provision"));
            }
            let response: Provisioned = response
                .json()
                .await
                .map_err(|_| StoreError::Unavailable("provision-reply"))?;
            if response.catalog != format!("t_{id}") {
                return Err(StoreError::Integrity);
            }
            self.0
                .tenants
                .lock()
                .map_err(|_| StoreError::Unavailable("cache"))?
                .insert(id.clone());
        }
        Ok(format!("t_{id}"))
    }
    async fn connection<T: Send + 'static>(
        &self,
        operation: impl FnOnce(&mut Remote) -> Result<T, StoreError> + Send + 'static,
    ) -> Result<T, StoreError> {
        let permit = self
            .0
            .slots
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| StoreError::Unavailable("pool"))?;
        let inner = Arc::clone(&self.0);
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            let cached = inner
                .connections
                .lock()
                .map_err(|_| StoreError::Unavailable("pool"))?
                .pop();
            let mut connection = match cached {
                Some(connection) => connection,
                None => Remote::open(&inner.config)?,
            };
            let result = operation(&mut connection);
            if result.is_ok() {
                inner
                    .connections
                    .lock()
                    .map_err(|_| StoreError::Unavailable("pool"))?
                    .push(connection);
            }
            result
        })
        .await
        .map_err(|_| StoreError::Unavailable("worker"))?
    }
    /// The caller supplies an already authenticated encrypted envelope. The
    /// immutable address hashes ciphertext, never the underlying business text.
    pub async fn put(&self, tenant: &str, data: String) -> Result<String, StoreError> {
        self.put_many(tenant, vec![data])
            .await?
            .pop()
            .ok_or(StoreError::Integrity)
    }
    /// One transaction and one hash check for a bounded group of immutable
    /// ciphertexts. Large imports must not pay four Quack round trips per row.
    pub async fn put_many(
        &self,
        tenant: &str,
        data: Vec<String>,
    ) -> Result<Vec<String>, StoreError> {
        if data.is_empty()
            || data.len() > 64
            || data.iter().map(String::len).sum::<usize>() > MAX_CIPHERTEXT_BYTES
        {
            return Err(StoreError::Integrity);
        }
        let ids = data.iter().map(|item| content_id(item)).collect::<Vec<_>>();
        let unique = ids.iter().cloned().zip(data).collect::<BTreeMap<_, _>>();
        let catalog = self.provision(tenant).await?;
        // CONNECT routing in DuckDB 2.0's v1 C API drops bound parameters.
        // Encode opaque bytes into an alphabet-only literal; identifiers are
        // validated hex. No caller text becomes SQL syntax.
        let values = unique
            .iter()
            .map(|(id, data)| {
                format!(
                    "('{id}',decode(from_base64('{}')))",
                    STANDARD.encode(data.as_bytes())
                )
            })
            .collect::<Vec<_>>()
            .join(",");
        let insert = Arc::new(format!(
            "INSERT INTO {catalog}.ciphertexts(id,content) \
             VALUES{values} \
             ON CONFLICT(id) DO NOTHING"
        ));
        let quoted = unique
            .keys()
            .map(|id| format!("'{id}'"))
            .collect::<Vec<_>>()
            .join(",");
        // Verify every content hash inside the write transaction, returning
        // only ASCII identifiers over the v1 C result interface.
        let read = Arc::new(format!(
            "SELECT string_agg(id,',' ORDER BY id) FROM {catalog}.ciphertexts WHERE id IN ({quoted}) AND sha256(content)=id"
        ));
        let expected = Arc::new(unique.keys().cloned().collect::<Vec<_>>().join(","));
        for attempt in 0..5 {
            let (insert, read, expected) = (insert.clone(), read.clone(), expected.clone());
            let outcome = self
                .connection(move |connection| {
                    connection.execute("BEGIN", "write-begin")?;
                    connection.execute(&insert, "ciphertext-write")?;
                    let stored = connection.string(&read, "write-verify")?;
                    if stored.as_deref() != Some(expected.as_str()) {
                        return Err(StoreError::Integrity);
                    }
                    connection.execute("COMMIT", "write-commit")?;
                    Ok(())
                })
                .await;
            match outcome {
                Ok(()) => return Ok(ids),
                Err(StoreError::Conflict) if attempt < 4 => {
                    // A commit conflict may already roll back the transaction.
                    // The failed connection is dropped, so retry with a fresh
                    // connection rather than assuming rollback is still legal.
                    tokio::time::sleep(Duration::from_millis(5 << attempt)).await;
                }
                Err(error) => return Err(error),
            }
        }
        Err(StoreError::Conflict)
    }

    pub async fn get(&self, tenant: &str, id: &str) -> Result<String, StoreError> {
        if !valid_id(id) {
            return Err(StoreError::Integrity);
        }
        let catalog = self.provision(tenant).await?;
        let id = id.to_owned();
        self.connection(move |connection| {
            let data = connection.string(
                &format!(
                    "SELECT to_base64(encode(content)) FROM {catalog}.ciphertexts WHERE id='{id}'"
                ),
                "ciphertext-read",
            )?;
            let data = decode_content(data)?.ok_or(StoreError::NotFound)?;
            if data.len() > MAX_CIPHERTEXT_BYTES || content_id(&data) != id {
                return Err(StoreError::Integrity);
            }
            Ok(data)
        })
        .await
    }
    /// Preserve caller order and duplicates, verifying every address. Missing
    /// or corrupt objects fail the complete read rather than becoming omissions.
    pub async fn get_many(
        &self,
        tenant: &str,
        ids: Vec<String>,
    ) -> Result<Vec<String>, StoreError> {
        self.get_group(tenant, ids, None).await
    }
    /// A page may include the object that crosses the budget, but never reads
    /// another object after that. Large documents retain bounded allocations.
    pub async fn get_prefix(
        &self,
        tenant: &str,
        ids: Vec<String>,
        budget: usize,
    ) -> Result<Vec<String>, StoreError> {
        if budget == 0 || budget > MAX_CIPHERTEXT_BYTES {
            return Err(StoreError::Integrity);
        }
        self.get_group(tenant, ids, Some(budget)).await
    }

    /// Resolve several independent prefixes with one size lookup and one
    /// ciphertext lookup. Enforce the combined budget before fetching bodies.
    pub async fn get_prefixes(
        &self,
        tenant: &str,
        groups: Vec<Vec<String>>,
        page_budget: usize,
        total_budget: usize,
    ) -> Result<Vec<Vec<String>>, StoreError> {
        if page_budget == 0
            || page_budget > MAX_CIPHERTEXT_BYTES
            || total_budget == 0
            || total_budget > MAX_CIPHERTEXT_READ_BYTES
        {
            return Err(StoreError::Integrity);
        }
        self.get_groups(tenant, groups, Some(page_budget), total_budget)
            .await
    }

    async fn get_group(
        &self,
        tenant: &str,
        ids: Vec<String>,
        budget: Option<usize>,
    ) -> Result<Vec<String>, StoreError> {
        if ids.len() == 1 {
            return self.get(tenant, &ids[0]).await.map(|data| vec![data]);
        }
        self.get_groups(tenant, vec![ids], budget, MAX_CIPHERTEXT_READ_BYTES)
            .await?
            .pop()
            .ok_or(StoreError::Integrity)
    }

    async fn get_groups(
        &self,
        tenant: &str,
        groups: Vec<Vec<String>>,
        page_budget: Option<usize>,
        total_budget: usize,
    ) -> Result<Vec<Vec<String>>, StoreError> {
        if groups.is_empty()
            || groups.len() > MAX_CIPHERTEXT_GROUPS
            || groups.iter().any(|ids| {
                ids.is_empty()
                    || ids.len() > MAX_CIPHERTEXT_GROUP_ITEMS
                    || ids.iter().any(|id| !valid_id(id))
            })
        {
            return Err(StoreError::Integrity);
        }
        let catalog = self.provision(tenant).await?;
        let unique = groups.iter().flatten().cloned().collect::<BTreeSet<_>>();
        self.connection(move |connection| {
            let sizes_sql = format!(
                "SELECT id || ':' || CAST(octet_length(encode(content)) AS VARCHAR) \
                 FROM {catalog}.ciphertexts WHERE id IN ({}) ORDER BY id",
                quoted_ids(&unique)
            );
            let metadata = connection.strings(
                &sizes_sql,
                "ciphertext-sizes",
                unique.len(),
                96,
                unique.len() * 96,
            )?;
            if metadata.len() != unique.len() {
                return Err(StoreError::NotFound);
            }
            let mut sizes = BTreeMap::new();
            for row in metadata {
                let (id, size) = row.split_once(':').ok_or(StoreError::Integrity)?;
                let size: usize = size.parse().map_err(|_| StoreError::Integrity)?;
                if !unique.contains(id) || size > MAX_CIPHERTEXT_BYTES {
                    return Err(StoreError::Integrity);
                }
                if sizes.insert(id.to_owned(), size).is_some() {
                    return Err(StoreError::Integrity);
                }
            }

            let selected = select_ciphertext_prefixes(groups, &sizes, page_budget, total_budget)?;
            let requested = selected.iter().flatten().cloned().collect::<BTreeSet<_>>();
            let encoded_single = MAX_CIPHERTEXT_BYTES.div_ceil(3) * 4 + 65;
            // Each independently encoded value can add up to three padding bytes.
            let encoded_total = total_budget.div_ceil(3) * 4 + requested.len() * (65 + 3);
            let content_sql = format!(
                "SELECT id || ':' || to_base64(encode(content)) \
                 FROM {catalog}.ciphertexts WHERE id IN ({}) ORDER BY id",
                quoted_ids(&requested)
            );
            let rows = connection.strings(
                &content_sql,
                "ciphertexts-read",
                requested.len(),
                encoded_single,
                encoded_total,
            )?;
            if rows.len() != requested.len() {
                return Err(StoreError::NotFound);
            }

            let mut objects = BTreeMap::new();
            for row in rows {
                let (id, encoded) = row.split_once(':').ok_or(StoreError::Integrity)?;
                let data =
                    decode_content(Some(encoded.to_owned()))?.ok_or(StoreError::Integrity)?;
                if !requested.contains(id)
                    || sizes.get(id) != Some(&data.len())
                    || content_id(&data) != id
                {
                    return Err(StoreError::Integrity);
                }
                if objects.insert(id.to_owned(), data).is_some() {
                    return Err(StoreError::Integrity);
                }
            }
            selected
                .into_iter()
                .map(|group| {
                    group
                        .into_iter()
                        .map(|id| objects.get(&id).cloned().ok_or(StoreError::NotFound))
                        .collect()
                })
                .collect()
        })
        .await
    }

    pub async fn snapshot(&self, tenant: &str) -> Result<SnapshotInfo, StoreError> {
        self.create_snapshot(tenant, None).await
    }

    /// Replaying an operation, including through another API replica, returns
    /// the same closed database file instead of copying a newer tenant state.
    pub async fn snapshot_for_operation(
        &self,
        tenant: &str,
        operation: &str,
    ) -> Result<SnapshotInfo, StoreError> {
        super::snapshot_id(tenant, operation)?;
        self.create_snapshot(tenant, Some(operation)).await
    }

    async fn create_snapshot(
        &self,
        tenant: &str,
        operation: Option<&str>,
    ) -> Result<SnapshotInfo, StoreError> {
        self.provision(tenant).await?;
        let response = self
            .0
            .http
            .post(format!("{}/snapshots", self.0.config.control_url))
            .bearer_auth(&*self.0.config.token)
            .json(&SnapshotRequest { tenant, operation })
            .send()
            .await
            .map_err(|_| StoreError::Unavailable("snapshot"))?;
        if !response.status().is_success() {
            return Err(StoreError::Unavailable("snapshot"));
        }
        response
            .json()
            .await
            .map_err(|_| StoreError::Unavailable("snapshot-reply"))
    }

    /// The service credential stays at the API. Callers may stream the body;
    /// it is never encoded into an RPC result or buffered as a complete backup.
    pub async fn download_snapshot(&self, id: &str) -> Result<reqwest::Response, StoreError> {
        if !super::valid_id(id) {
            return Err(StoreError::NotFound);
        }
        let response = self
            .0
            .http
            .get(format!("{}/snapshots/{id}", self.0.config.control_url))
            .bearer_auth(&*self.0.config.token)
            .timeout(Duration::from_secs(600))
            .send()
            .await
            .map_err(|_| StoreError::Unavailable("snapshot-download"))?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Err(StoreError::NotFound);
        }
        if !response.status().is_success() {
            return Err(StoreError::Unavailable("snapshot-download"));
        }
        Ok(response)
    }
}

fn quoted_ids(ids: &BTreeSet<String>) -> String {
    ids.iter()
        .map(|id| format!("'{id}'"))
        .collect::<Vec<_>>()
        .join(",")
}

fn select_ciphertext_prefixes(
    groups: Vec<Vec<String>>,
    sizes: &BTreeMap<String, usize>,
    page_budget: Option<usize>,
    total_budget: usize,
) -> Result<Vec<Vec<String>>, StoreError> {
    let mut total = 0;
    let mut selected = Vec::with_capacity(groups.len());
    for mut group in groups {
        let mut page_bytes = 0;
        let mut count = 0;
        for id in &group {
            if page_budget.is_some_and(|budget| page_bytes >= budget) {
                break;
            }
            let size = sizes.get(id).ok_or(StoreError::NotFound)?;
            page_bytes += size;
            total += size;
            if total > total_budget {
                return Err(StoreError::BatchTooLarge);
            }
            count += 1;
        }
        group.truncate(count);
        selected.push(group);
    }
    Ok(selected)
}

fn decode_content(encoded: Option<String>) -> Result<Option<String>, StoreError> {
    encoded
        .map(|encoded| {
            let bytes = STANDARD
                .decode(encoded)
                .map_err(|_| StoreError::Integrity)?;
            if bytes.len() > MAX_CIPHERTEXT_BYTES {
                return Err(StoreError::Integrity);
            }
            String::from_utf8(bytes).map_err(|_| StoreError::Integrity)
        })
        .transpose()
}

impl CipherStore {
    async fn metadata_request<I: Serialize + ?Sized, O: serde::de::DeserializeOwned>(
        &self,
        action: &str,
        input: &I,
    ) -> Result<O, StoreError> {
        self.metadata_request_with_timeout(action, input, Duration::from_secs(60))
            .await
    }

    async fn metadata_request_with_timeout<
        I: Serialize + ?Sized,
        O: serde::de::DeserializeOwned,
    >(
        &self,
        action: &str,
        input: &I,
        timeout: Duration,
    ) -> Result<O, StoreError> {
        let response = self
            .0
            .http
            .post(format!("{}/metadata/{action}", self.0.config.control_url))
            .bearer_auth(&*self.0.config.token)
            .timeout(timeout)
            .json(input)
            .send()
            .await
            .map_err(|_| StoreError::Unavailable("metadata-transport"))?;
        if response.status() == reqwest::StatusCode::CONFLICT {
            return Err(StoreError::Conflict);
        }
        if response.status() == reqwest::StatusCode::BAD_REQUEST {
            return Err(StoreError::Integrity);
        }
        if !response.status().is_success() {
            return Err(StoreError::Unavailable("metadata-response"));
        }
        response
            .json()
            .await
            .map_err(|_| StoreError::Unavailable("metadata-decode"))
    }
    pub async fn metadata_read(
        &self,
        target: super::metadata::Target,
        records: Vec<sortsys_zerotrust::metadata::RecordKey>,
    ) -> Result<Vec<sortsys_zerotrust::metadata::MetadataRecord>, StoreError> {
        self.read_batched(target, records).await
    }
    pub async fn metadata_transact(
        &self,
        target: super::metadata::Target,
        batch: sortsys_zerotrust::metadata::MetadataBatch,
    ) -> Result<sortsys_zerotrust::metadata::MetadataReceipt, StoreError> {
        self.metadata_transact_ref(target, &batch).await
    }

    pub async fn metadata_transact_ref(
        &self,
        target: super::metadata::Target,
        batch: &sortsys_zerotrust::metadata::MetadataBatch,
    ) -> Result<sortsys_zerotrust::metadata::MetadataReceipt, StoreError> {
        if batch.validate().is_ok() {
            #[derive(Serialize)]
            struct Request<'a> {
                target: super::metadata::Target,
                batch: &'a sortsys_zerotrust::metadata::MetadataBatch,
            }
            return self
                .metadata_request("batch", &Request { target, batch })
                .await;
        }
        let input = self.prepare_metadata(target, batch).await?;
        self.metadata_request_with_timeout("prepared/commit", &input, Duration::from_secs(300))
            .await
    }

    async fn prepare_metadata(
        &self,
        target: super::metadata::Target,
        batch: &sortsys_zerotrust::metadata::MetadataBatch,
    ) -> Result<super::prepared::CommitRequest, StoreError> {
        use sortsys_zerotrust::metadata::{
            MAX_PREPARED_BYTES, MAX_PREPARED_PART_BYTES, PreparedMetadataManifest,
        };
        batch
            .validate_prepared()
            .map_err(|_| StoreError::Integrity)?;
        let encoded = serde_json::to_string(batch).map_err(|_| StoreError::Integrity)?;
        if encoded.len() > MAX_PREPARED_BYTES {
            return Err(StoreError::Integrity);
        }
        let mut parts = Vec::new();
        let mut start = 0;
        while start < encoded.len() {
            let mut end = (start + MAX_PREPARED_PART_BYTES).min(encoded.len());
            while !encoded.is_char_boundary(end) {
                end -= 1;
            }
            let content = &encoded[start..end];
            let expected = content_id(content);
            #[derive(Serialize)]
            struct Part<'a> {
                target: &'a super::metadata::Target,
                content: &'a str,
            }
            let receipt: super::prepared::PartReceipt = self
                .metadata_request(
                    "prepared/part",
                    &Part {
                        target: &target,
                        content,
                    },
                )
                .await?;
            if receipt.id != expected {
                return Err(StoreError::Integrity);
            }
            parts.push(receipt.id);
            start = end;
        }
        let manifest = PreparedMetadataManifest {
            context: target.context()?,
            operation: batch.operation.clone(),
            fingerprint: batch.fingerprint(),
            parts,
        };
        manifest.validate().map_err(|_| StoreError::Integrity)?;
        Ok(super::prepared::CommitRequest { target, manifest })
    }
    pub async fn metadata_scan(
        &self,
        input: &super::metadata::ScanRequest,
    ) -> Result<super::metadata::RecordPage, StoreError> {
        self.metadata_request("scan", input).await
    }
    pub async fn metadata_validate(
        &self,
        target: super::metadata::Target,
        batch: sortsys_zerotrust::metadata::MetadataBatch,
    ) -> Result<(), StoreError> {
        let valid: bool = if batch.validate().is_ok() {
            self.metadata_request("validate", &super::metadata::BatchRequest { target, batch })
                .await?
        } else {
            if !batch.puts.is_empty()
                || !batch.deletes.is_empty()
                || !batch.journal.is_empty()
                || !batch.hints.is_empty()
            {
                return Err(StoreError::Integrity);
            }
            let input = self.prepare_metadata(target, &batch).await?;
            self.metadata_request_with_timeout(
                "prepared/validate",
                &input,
                Duration::from_secs(300),
            )
            .await?
        };
        if !valid {
            return Err(StoreError::Integrity);
        }
        Ok(())
    }
    pub async fn journal_get(
        &self,
        target: super::metadata::Target,
        stream: String,
        id: String,
    ) -> Result<Option<sortsys_zerotrust::journal::JournalEntry>, StoreError> {
        self.metadata_request(
            "journal/read",
            &super::metadata::JournalRead { target, stream, id },
        )
        .await
    }
    pub async fn journal_origins(
        &self,
        target: super::metadata::Target,
        objects: Vec<sortsys_zerotrust::metadata::RecordKey>,
    ) -> Result<Vec<Option<sortsys_zerotrust::journal::JournalEntry>>, StoreError> {
        self.metadata_request(
            "journal/origins",
            &super::metadata::JournalOrigins { target, objects },
        )
        .await
    }

    pub async fn journal_list(
        &self,
        target: super::metadata::Target,
        query: sortsys_zerotrust::journal::JournalQuery,
    ) -> Result<sortsys_zerotrust::journal::JournalPage, StoreError> {
        self.metadata_request(
            "journal/list",
            &super::metadata::JournalList { target, query },
        )
        .await
    }
    pub async fn metadata_changes(
        &self,
        target: super::metadata::Target,
        after: Option<String>,
        wait_ms: u32,
    ) -> Result<super::metadata::ChangesPage, StoreError> {
        self.metadata_request(
            "changes",
            &super::metadata::ChangesRequest {
                target,
                after,
                wait_ms,
            },
        )
        .await
    }
    pub async fn metadata_events(
        &self,
        target: super::metadata::Target,
        after: String,
    ) -> Result<Vec<super::metadata::MetadataEvent>, StoreError> {
        self.metadata_request("events", &super::metadata::EventsRequest { target, after })
            .await
    }
}
