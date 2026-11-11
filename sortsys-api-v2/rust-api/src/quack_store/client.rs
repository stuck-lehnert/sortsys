use std::{
    collections::{BTreeMap, HashSet},
    sync::{Arc, Mutex},
    time::Duration,
};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use tokio::sync::Semaphore;

use super::{
    MAX_CIPHERTEXT_BYTES, QuackConfig, StoreError, content_id, remote::Remote, tenant_id, valid_id,
};

#[derive(Clone)]
pub struct CipherStore(Arc<Inner>);
struct Inner {
    config: QuackConfig,
    http: reqwest::Client,
    slots: Arc<Semaphore>,
    connections: Mutex<Vec<Remote>>,
    tenants: Mutex<HashSet<String>>,
}
#[derive(Serialize)]
struct TenantRequest<'a> {
    tenant: &'a str,
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
    async fn get_group(
        &self,
        tenant: &str,
        ids: Vec<String>,
        budget: Option<usize>,
    ) -> Result<Vec<String>, StoreError> {
        if ids.is_empty() || ids.len() > 64 || ids.iter().any(|id| !valid_id(id)) {
            return Err(StoreError::Integrity);
        }
        if ids.len() == 1 {
            return self.get(tenant, &ids[0]).await.map(|data| vec![data]);
        }
        let catalog = self.provision(tenant).await?;
        let unique = ids
            .iter()
            .cloned()
            .collect::<std::collections::BTreeSet<_>>();
        let quoted = unique
            .iter()
            .map(|id| format!("'{id}'"))
            .collect::<Vec<_>>()
            .join(",");
        self.connection(move |connection| {
            let metadata = connection.strings(&format!("SELECT id||':'||CAST(octet_length(encode(content)) AS VARCHAR) FROM {catalog}.ciphertexts WHERE id IN ({quoted}) ORDER BY id"), "ciphertext-sizes", 64, 96, 64 * 96)?;
            if metadata.len() != unique.len() { return Err(StoreError::NotFound); }
            let mut sizes = BTreeMap::new();
            for row in metadata {
                let (id, size) = row.split_once(':').ok_or(StoreError::Integrity)?;
                let size: usize = size.parse().map_err(|_| StoreError::Integrity)?;
                if !unique.contains(id) || size > MAX_CIPHERTEXT_BYTES || sizes.insert(id.to_owned(), size).is_some() { return Err(StoreError::Integrity); }
            }
            let mut selected = Vec::new(); let mut total = 0usize;
            for id in ids {
                if budget.is_some_and(|budget| total >= budget) { break; }
                total += sizes[&id];
                if total > 2 * MAX_CIPHERTEXT_BYTES { return Err(StoreError::BatchTooLarge); }
                selected.push(id);
            }
            let requested = selected.iter().cloned().collect::<std::collections::BTreeSet<_>>();
            let quoted = requested.iter().map(|id| format!("'{id}'")).collect::<Vec<_>>().join(",");
            let encoded_single = MAX_CIPHERTEXT_BYTES.div_ceil(3) * 4 + 65;
            let encoded_total = (2 * MAX_CIPHERTEXT_BYTES).div_ceil(3) * 4 + 64 * 65;
            let rows = connection.strings(&format!("SELECT id||':'||to_base64(encode(content)) FROM {catalog}.ciphertexts WHERE id IN ({quoted}) ORDER BY id"), "ciphertexts-read", 64, encoded_single, encoded_total)?;
            if rows.len() != requested.len() { return Err(StoreError::NotFound); }
            let mut objects = BTreeMap::new(); let mut actual = 0usize;
            for row in rows {
                let (id, encoded) = row.split_once(':').ok_or(StoreError::Integrity)?;
                let data = decode_content(Some(encoded.to_owned()))?.ok_or(StoreError::Integrity)?;
                actual += data.len();
                if !requested.contains(id) || data.len() > MAX_CIPHERTEXT_BYTES || actual > 2 * MAX_CIPHERTEXT_BYTES || content_id(&data) != id
                    || objects.insert(id.to_owned(), data).is_some() { return Err(StoreError::Integrity); }
            }
            selected.into_iter().map(|id| objects.get(&id).cloned().ok_or(StoreError::NotFound)).collect()
        }).await
    }
    pub async fn snapshot(&self, tenant: &str) -> Result<SnapshotInfo, StoreError> {
        self.provision(tenant).await?;
        let response = self
            .0
            .http
            .post(format!("{}/snapshots", self.0.config.control_url))
            .bearer_auth(&*self.0.config.token)
            .json(&TenantRequest { tenant })
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
