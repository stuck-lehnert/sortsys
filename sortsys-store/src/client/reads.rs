//! Coalesce concurrent metadata reads, never completed results. Each caller
//! retains its own optimistic transaction and must validate that read set.
use std::{collections::HashMap, sync::Arc};

use sortsys_zerotrust::{
    crypto::revision,
    metadata::{MAX_OPERATIONS, MetadataRecord, RecordKey},
};
use tokio::sync::oneshot;

use super::{CipherStore, StoreError};
use crate::metadata::{ReadRequest, Target};

const MAX_READ_CALLS: usize = 32;

type Reply = oneshot::Sender<Result<Vec<MetadataRecord>, StoreError>>;

struct PendingRead {
    records: Vec<RecordKey>,
    reply: Reply,
}

struct ReadBatch {
    target: Target,
    token: Arc<()>,
    calls: Vec<PendingRead>,
    keys: usize,
}

impl ReadBatch {
    fn fits(&self, keys: usize) -> bool {
        self.calls.len() < MAX_READ_CALLS && self.keys + keys <= MAX_OPERATIONS
    }

    fn full(&self) -> bool {
        self.calls.len() == MAX_READ_CALLS || self.keys == MAX_OPERATIONS
    }

    fn prepare(self) -> Option<PreparedRead> {
        let mut positions = HashMap::new();
        let mut records = Vec::new();
        let mut calls = Vec::new();
        for call in self.calls {
            if call.reply.is_closed() {
                continue;
            }
            let mut indices = Vec::with_capacity(call.records.len());
            for record in call.records {
                let index = *positions.entry(record.clone()).or_insert_with(|| {
                    let index = records.len();
                    records.push(record);
                    index
                });
                indices.push(index);
            }
            calls.push((indices, call.reply));
        }
        if calls.is_empty() {
            return None;
        }
        Some(PreparedRead {
            request: ReadRequest {
                target: self.target,
                records,
            },
            calls,
        })
    }
}

struct PreparedRead {
    request: ReadRequest,
    calls: Vec<(Vec<usize>, Reply)>,
}

impl PreparedRead {
    fn verify(&self, records: &[MetadataRecord]) -> Result<(), StoreError> {
        if records.len() != self.request.records.len() {
            return Err(StoreError::Integrity);
        }
        for (record, expected) in records.iter().zip(&self.request.records) {
            if record.record != *expected || record.version.is_some() != record.value.is_some() {
                return Err(StoreError::Integrity);
            }
            if let Some(version) = &record.version {
                revision(version).map_err(|_| StoreError::Integrity)?;
            }
        }
        Ok(())
    }

    fn complete(self, result: Result<Vec<MetadataRecord>, StoreError>) {
        let result = result.and_then(|records| {
            self.verify(&records)?;
            Ok(records)
        });
        for (indices, reply) in self.calls {
            if reply.is_closed() {
                continue;
            }
            let result = match &result {
                Ok(records) => Ok(indices
                    .iter()
                    .map(|index| records[*index].clone())
                    .collect()),
                Err(error) => Err(error.clone()),
            };
            let _ = reply.send(result);
        }
    }
}

#[derive(Default)]
pub(super) struct ReadQueue {
    batches: HashMap<Target, ReadBatch>,
}

struct Enqueued {
    ready: Vec<ReadBatch>,
    deferred: Option<Arc<()>>,
}

impl ReadQueue {
    fn enqueue(&mut self, target: Target, records: Vec<RecordKey>, reply: Reply) -> Enqueued {
        let mut ready = Vec::new();
        if self
            .batches
            .get(&target)
            .is_some_and(|batch| !batch.fits(records.len()))
        {
            ready.push(self.batches.remove(&target).unwrap());
        }
        let new_batch = !self.batches.contains_key(&target);
        let batch = self
            .batches
            .entry(target.clone())
            .or_insert_with(|| ReadBatch {
                target: target.clone(),
                token: Arc::new(()),
                calls: Vec::new(),
                keys: 0,
            });
        batch.keys += records.len();
        batch.calls.push(PendingRead { records, reply });
        let token = batch.token.clone();
        let deferred = if batch.full() {
            ready.push(self.batches.remove(&target).unwrap());
            None
        } else if new_batch {
            Some(token)
        } else {
            None
        };
        Enqueued { ready, deferred }
    }

    fn take(&mut self, target: &Target, token: &Arc<()>) -> Option<ReadBatch> {
        let current = self.batches.get(target)?;
        // A full batch may already have left. Its scheduled flush must not
        // consume a newer batch that happens to have the same tenant.
        if !Arc::ptr_eq(&current.token, token) {
            return None;
        }
        self.batches.remove(target)
    }
}

impl CipherStore {
    pub(super) async fn read_batched(
        &self,
        target: Target,
        records: Vec<RecordKey>,
    ) -> Result<Vec<MetadataRecord>, StoreError> {
        target.context()?;
        if records.len() > MAX_OPERATIONS {
            return Err(StoreError::Integrity);
        }
        for record in &records {
            record.validate().map_err(|_| StoreError::Integrity)?;
        }
        if records.is_empty() {
            return Ok(Vec::new());
        }
        let (reply, received) = oneshot::channel();
        let queued = self
            .0
            .reads
            .lock()
            .map_err(|_| StoreError::Unavailable("metadata-read-queue"))?
            .enqueue(target.clone(), records, reply);
        for batch in queued.ready {
            self.dispatch_reads(batch);
        }
        if let Some(token) = queued.deferred {
            let store = self.clone();
            tokio::spawn(async move {
                // Give already-ready peers one scheduler turn to join. A
                // millisecond timer here would delay every dependent read in
                // authentication, verification and commit preparation.
                tokio::task::yield_now().await;
                let batch = match store.0.reads.lock() {
                    Ok(mut queue) => queue.take(&target, &token),
                    Err(poisoned) => {
                        // Wake every waiter on queue failure rather than leave
                        // an authentication read waiting without a deadline.
                        for (_, batch) in poisoned.into_inner().batches.drain() {
                            if let Some(prepared) = batch.prepare() {
                                prepared
                                    .complete(Err(StoreError::Unavailable("metadata-read-queue")));
                            }
                        }
                        return;
                    }
                };
                if let Some(batch) = batch {
                    store.dispatch_reads(batch);
                }
            });
        }
        received
            .await
            .map_err(|_| StoreError::Unavailable("metadata-read-worker"))?
    }

    fn dispatch_reads(&self, batch: ReadBatch) {
        let Some(prepared) = batch.prepare() else {
            return;
        };
        let store = self.clone();
        tokio::spawn(async move {
            let result = store.metadata_request("read", &prepared.request).await;
            prepared.complete(result);
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tenant(name: &str) -> Target {
        Target::Tenant {
            tenant: name.into(),
        }
    }

    fn key(name: &str) -> RecordKey {
        RecordKey {
            collection: "records".into(),
            key: name.into(),
        }
    }

    fn value(record: &RecordKey, version: Option<&str>) -> MetadataRecord {
        MetadataRecord {
            record: record.clone(),
            version: version.map(str::to_owned),
            value: version.map(|version| format!("opaque-{version}")),
        }
    }

    #[test]
    fn overlapping_reads_keep_order_missing_values_and_tenant_boundaries() {
        let mut queue = ReadQueue::default();
        let (first, mut first_result) = oneshot::channel();
        let start = queue.enqueue(tenant("alpha"), vec![key("b"), key("a"), key("b")], first);
        let (second, mut second_result) = oneshot::channel();
        let next = queue.enqueue(tenant("alpha"), vec![key("missing"), key("a")], second);
        assert!(next.deferred.is_none());
        let (other, mut other_result) = oneshot::channel();
        let other_start = queue.enqueue(tenant("beta"), vec![key("a")], other);
        let (system, mut system_result) = oneshot::channel();
        let system_start = queue.enqueue(Target::System, vec![key("a")], system);

        let prepared = queue
            .take(&tenant("alpha"), &start.deferred.unwrap())
            .unwrap()
            .prepare()
            .unwrap();
        assert_eq!(
            prepared.request.records,
            vec![key("b"), key("a"), key("missing")]
        );
        prepared.complete(Ok(vec![
            value(&key("b"), Some("9007199254740993")),
            value(&key("a"), Some("2")),
            value(&key("missing"), None),
        ]));
        let first = first_result.try_recv().unwrap().unwrap();
        assert_eq!(
            first
                .iter()
                .map(|row| row.record.clone())
                .collect::<Vec<_>>(),
            vec![key("b"), key("a"), key("b")]
        );
        assert_eq!(first[0].version.as_deref(), Some("9007199254740993"));
        assert_eq!(first[2].version, first[0].version);
        let second = second_result.try_recv().unwrap().unwrap();
        assert!(second[0].value.is_none());
        assert_eq!(second[1].version.as_deref(), Some("2"));
        assert!(other_result.try_recv().is_err());
        assert!(system_result.try_recv().is_err());
        assert!(
            queue
                .take(&tenant("beta"), &other_start.deferred.unwrap())
                .is_some()
        );
        assert!(
            queue
                .take(&Target::System, &system_start.deferred.unwrap())
                .is_some()
        );
    }

    #[test]
    fn full_batches_leave_immediately_and_old_flush_tasks_cannot_consume_their_successors() {
        let mut queue = ReadQueue::default();
        let mut receivers = Vec::new();
        let mut original_token = None;
        for index in 0..MAX_READ_CALLS {
            let (reply, received) = oneshot::channel();
            receivers.push(received);
            let enqueued = queue.enqueue(tenant("alpha"), vec![key(&format!("r-{index}"))], reply);
            if index == 0 {
                original_token = enqueued.deferred.clone();
            }
            if index + 1 < MAX_READ_CALLS {
                assert!(enqueued.ready.is_empty());
            } else {
                assert_eq!(enqueued.ready.len(), 1);
                assert_eq!(enqueued.ready[0].calls.len(), MAX_READ_CALLS);
                assert!(enqueued.deferred.is_none());
            }
        }
        let (reply, received) = oneshot::channel();
        receivers.push(received);
        let next = queue.enqueue(tenant("alpha"), vec![key("next")], reply);
        assert!(
            queue
                .take(&tenant("alpha"), &original_token.unwrap())
                .is_none()
        );
        let next = queue
            .take(&tenant("alpha"), &next.deferred.unwrap())
            .unwrap();
        assert_eq!(next.calls.len(), 1);
    }

    #[test]
    fn request_limits_never_split_one_call_across_different_snapshots() {
        let mut queue = ReadQueue::default();
        let mut receivers = Vec::new();
        for count in [700, 400, MAX_OPERATIONS] {
            let (reply, received) = oneshot::channel();
            receivers.push(received);
            let records = (0..count).map(|index| key(&format!("r-{index}"))).collect();
            let enqueued = queue.enqueue(tenant("alpha"), records, reply);
            match count {
                700 => assert!(enqueued.ready.is_empty()),
                400 => {
                    assert_eq!(enqueued.ready.len(), 1);
                    assert_eq!(enqueued.ready[0].keys, 700);
                }
                MAX_OPERATIONS => {
                    assert_eq!(enqueued.ready.len(), 2);
                    assert_eq!(enqueued.ready[0].keys, 400);
                    assert_eq!(enqueued.ready[1].keys, MAX_OPERATIONS);
                    assert!(enqueued.deferred.is_none());
                }
                _ => unreachable!(),
            }
        }
    }

    #[test]
    fn cancelled_reads_drop_their_keys_without_cancelling_peers() {
        let mut queue = ReadQueue::default();
        let (reply, received) = oneshot::channel();
        let first = queue.enqueue(tenant("alpha"), vec![key("cancelled")], reply);
        drop(received);
        let (reply, mut received) = oneshot::channel();
        queue.enqueue(tenant("alpha"), vec![key("active")], reply);
        let prepared = queue
            .take(&tenant("alpha"), &first.deferred.unwrap())
            .unwrap()
            .prepare()
            .unwrap();
        assert_eq!(prepared.request.records, vec![key("active")]);
        prepared.complete(Ok(vec![value(&key("active"), Some("3"))]));
        assert_eq!(
            received.try_recv().unwrap().unwrap()[0].version.as_deref(),
            Some("3")
        );

        let (reply, received) = oneshot::channel();
        let next = queue.enqueue(tenant("alpha"), vec![key("all-cancelled")], reply);
        drop(received);
        assert!(
            queue
                .take(&tenant("alpha"), &next.deferred.unwrap())
                .unwrap()
                .prepare()
                .is_none()
        );
    }

    #[test]
    fn malformed_replies_and_transport_errors_fail_closed_without_caching_results() {
        for reply in [
            Ok(Vec::new()),
            Ok(vec![value(&key("substituted"), Some("1"))]),
            Ok(vec![value(&key("a"), Some("01"))]),
            Ok(vec![MetadataRecord {
                record: key("a"),
                version: None,
                value: Some("unexpected".into()),
            }]),
            Err(StoreError::Unavailable("test-transport")),
        ] {
            let mut queue = ReadQueue::default();
            let (first, mut first_result) = oneshot::channel();
            let start = queue.enqueue(tenant("alpha"), vec![key("a")], first);
            let (second, mut second_result) = oneshot::channel();
            queue.enqueue(tenant("alpha"), vec![key("a")], second);
            let prepared = queue
                .take(&tenant("alpha"), &start.deferred.unwrap())
                .unwrap()
                .prepare()
                .unwrap();
            prepared.complete(reply);
            assert!(first_result.try_recv().unwrap().is_err());
            assert!(second_result.try_recv().unwrap().is_err());

            let (reply, mut received) = oneshot::channel();
            let retry = queue.enqueue(tenant("alpha"), vec![key("a")], reply);
            let prepared = queue
                .take(&tenant("alpha"), &retry.deferred.unwrap())
                .unwrap()
                .prepare()
                .unwrap();
            prepared.complete(Ok(vec![value(&key("a"), Some("2"))]));
            assert_eq!(
                received.try_recv().unwrap().unwrap()[0].version.as_deref(),
                Some("2")
            );
        }
    }
}
