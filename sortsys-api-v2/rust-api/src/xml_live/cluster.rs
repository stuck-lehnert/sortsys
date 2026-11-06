//! PostgreSQL is the coordination point, not a periodically polled XML store.
//! Small Yjs deltas travel in NOTIFY; larger deltas use the transaction log.
//! A single LISTEN connection is shared by all local sockets of an active tenant.
use super::*;
use sqlx::{
    PgPool, Row,
    postgres::{PgListener, PgPoolOptions},
};
use std::{sync::Weak, time::Instant};
use yrs::updates::decoder::Decode;
use yrs::{Doc, Map, ReadTxn, StateVector, Text, Transact, Update};

const CHANNEL: &str = "sortsys_xml_live";
const COMPACT_BYTES: i64 = 1024 * 1024;
const MAX_STATE: usize = 32 * 1024 * 1024;

#[derive(Deserialize)]
struct Notice {
    room: String,
    kind: String,
    data: Option<String>,
    seq: Option<i64>,
    epoch: Option<i64>,
    peer: Option<Participant>,
    id: Option<String>,
    version: Option<i64>,
}

pub(super) struct Bus {
    pub pool: PgPool,
    tenant: String,
    instance: String,
    hub: Weak<Hub>,
    local: Mutex<HashMap<String, (Room, i64)>>,
}

pub(super) fn key(room: &Room) -> String {
    format!("{}:{}:{}", room.1, room.2, room.3)
}
fn room(tenant: &str, key: &str) -> Option<Room> {
    let mut parts = key.split(':');
    let scope = parts.next()?;
    if !["project", "commercial"].contains(&scope) {
        return None;
    }
    let owner = parts.next()?.parse().ok()?;
    let file = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some((tenant.into(), scope.into(), owner, file))
}
fn document() -> Doc {
    Doc::with_options(yrs::Options {
        offset_kind: yrs::OffsetKind::Utf16,
        ..Default::default()
    })
}
fn encode(snapshot: Option<Vec<u8>>, updates: Vec<Vec<u8>>) -> RpcResult<Vec<u8>> {
    let doc = document();
    for data in snapshot.into_iter().chain(updates) {
        doc.transact_mut()
            .apply_update(Update::decode_v1(&data).map_err(invalid)?)
            .map_err(invalid)?;
    }
    let bytes = doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    if bytes.len() > MAX_STATE {
        return Err(invalid("Shared document is too large"));
    }
    Ok(bytes)
}

impl Hub {
    pub(super) async fn bus(self: &Arc<Self>, tenant: &str, pool: PgPool) -> RpcResult<Arc<Bus>> {
        let mut buses = self.buses.lock().await;
        if let Some(bus) = buses.get(tenant).and_then(Weak::upgrade) {
            return Ok(bus);
        }
        // LISTEN must not occupy a connection in the business pool. In particular,
        // it must never reserve the master pool's only connection.
        let mut bytes = [0; 16];
        getrandom::fill(&mut bytes).map_err(invalid)?;
        let instance = STANDARD.encode(bytes);
        let listener_pool = PgPoolOptions::new()
            .max_connections(1)
            .min_connections(0)
            .connect_with(
                (*pool.connect_options())
                    .clone()
                    .application_name(&format!("sortsys-xml-live:{instance}")),
            )
            .await
            .map_err(invalid)?;
        let mut listener = PgListener::connect_with(&listener_pool)
            .await
            .map_err(invalid)?;
        listener.listen(CHANNEL).await.map_err(invalid)?;
        let bus = Arc::new(Bus {
            pool,
            tenant: tenant.into(),
            instance,
            hub: Arc::downgrade(self),
            local: Mutex::new(HashMap::new()),
        });
        buses.insert(tenant.into(), Arc::downgrade(&bus));
        tokio::spawn(Arc::clone(&bus).listen(listener, listener_pool));
        Ok(bus)
    }
}

impl Bus {
    async fn listen(self: Arc<Self>, mut listener: PgListener, listener_pool: PgPool) {
        let mut maintenance = tokio::time::interval(Duration::from_secs(10));
        maintenance.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut used = Instant::now();
        let mut reconnect = false;
        loop {
            tokio::select! {
                result = listener.try_recv() => {
                    match result {
                        Ok(Some(notice)) => {
                            if reconnect { self.recover().await; reconnect = false; }
                            if let Ok(notice) = serde_json::from_str::<Notice>(notice.payload())
                                && let Err(error) = self.notice(notice).await {
                                tracing::warn!(%error, "Document notification recovery required");
                                self.recover().await;
                            }
                        }
                        // sqlx reestablishes LISTEN before returning None. Recover
                        // after subscribing, so no write can fall in between.
                        Ok(None) => { self.recover().await; reconnect = false; },
                        Err(error) => {
                            reconnect = true;
                            tracing::warn!(%error, "Document listener reconnecting");
                            tokio::time::sleep(Duration::from_millis(500)).await;
                        }
                    }
                }
                _ = maintenance.tick() => {
                    if self.hub.upgrade().is_none() || self.pool.is_closed() { break; }
                    if !self.local.lock().await.is_empty() { used = Instant::now(); }
                    // The task itself owns one Arc; an in-progress join owns another.
                    if used.elapsed() > Duration::from_secs(60)
                        && let Some(hub) = self.hub.upgrade() {
                        let mut buses = hub.buses.lock().await;
                        if Arc::strong_count(&self) == 1 { buses.remove(&self.tenant); break; }
                    }
                    if let Err(error) = self.maintain().await { tracing::warn!(%error, "Document peer lease refresh failed"); }
                }
            }
        }
        drop(listener);
        listener_pool.close().await;
    }
    async fn notice(&self, notice: Notice) -> RpcResult<()> {
        let Some(room) = room(&self.tenant, &notice.room) else {
            return Ok(());
        };
        let Some(hub) = self.hub.upgrade() else {
            return Ok(());
        };
        // Document changes also refresh other open documents of the same case.
        if !self.local.lock().await.values().any(|(local, epoch)| {
            (local == &room && notice.epoch.is_none_or(|value| value == *epoch))
                || (notice.kind == "changed"
                    && room.1 == "commercial"
                    && local.1 == room.1
                    && local.2 == room.2)
        }) {
            return Ok(());
        }
        match notice.kind.as_str() {
            "peer" | "leave" => {
                let mut peers = hub.peers.lock().await;
                let peers = peers.entry(room.clone()).or_default();
                if let Some(peer) = notice.peer {
                    peers.insert(peer.id.clone(), peer);
                }
                if let Some(id) = notice.id {
                    peers.remove(&id);
                }
                hub.notify_presence(&room);
            }
            "update" => {
                let data = if let Some(data) = notice.data {
                    STANDARD.decode(data).map_err(invalid)?
                } else {
                    let data: Option<Vec<u8>> = sqlx::query_scalar(
                        "SELECT data FROM __xml_live_updates WHERE room=$1 AND seq=$2",
                    )
                    .bind(&notice.room)
                    .bind(notice.seq)
                    .fetch_optional(&self.pool)
                    .await
                    .map_err(invalid)?;
                    match data {
                        Some(data) => data,
                        None => self.state(&room).await?,
                    }
                };
                let _ = hub.events.send(Event {
                    room,
                    version: None,
                    update: Some(Arc::new(data)),
                    resync: false,
                });
            }
            "changed" => {
                let _ = hub.events.send(Event {
                    room,
                    version: notice.version,
                    update: None,
                    resync: false,
                });
            }
            _ => {}
        }
        Ok(())
    }
    async fn recover(&self) {
        let rooms: std::collections::HashSet<_> = self
            .local
            .lock()
            .await
            .values()
            .map(|(room, _)| room.clone())
            .collect();
        for room in rooms {
            if let Some(hub) = self.hub.upgrade() {
                // The socket reads a consistent snapshot and checks its durable
                // revision/access again, including any missed business notices.
                let _ = hub.events.send(Event {
                    room,
                    version: None,
                    update: None,
                    resync: true,
                });
            }
        }
    }
    async fn maintain(&self) -> RpcResult<()> {
        let ids: Vec<_> = self.local.lock().await.keys().cloned().collect();
        sqlx::query("UPDATE __xml_live_peers SET expires_at=clock_timestamp()+interval '45 seconds' WHERE instance=$1 AND id=ANY($2) AND expires_at>clock_timestamp()")
            .bind(&self.instance).bind(ids).execute(&self.pool).await.map_err(invalid)?;
        sqlx::query("DELETE FROM __xml_live_peers WHERE expires_at<clock_timestamp()")
            .execute(&self.pool)
            .await
            .map_err(invalid)?;
        sqlx::query("DELETE FROM __xml_live_rooms r WHERE touched_at<clock_timestamp()-interval '1 day' AND NOT EXISTS(SELECT 1 FROM __xml_live_peers p WHERE p.room=r.room)")
            .execute(&self.pool).await.map_err(invalid)?;
        Ok(())
    }
    pub async fn join(&self, room: &Room, peer: Participant) -> RpcResult<i64> {
        let name = key(room);
        let mut tx = self.pool.begin().await.map_err(invalid)?;
        sqlx::query("INSERT INTO __xml_live_rooms(room) VALUES($1) ON CONFLICT DO NOTHING")
            .bind(&name)
            .execute(&mut *tx)
            .await
            .map_err(invalid)?;
        let mut epoch: i64 =
            sqlx::query_scalar("SELECT epoch FROM __xml_live_rooms WHERE room=$1 FOR UPDATE")
                .bind(&name)
                .fetch_one(&mut *tx)
                .await
                .map_err(invalid)?;
        sqlx::query("DELETE FROM __xml_live_peers WHERE room=$1 AND expires_at<clock_timestamp()")
            .bind(&name)
            .execute(&mut *tx)
            .await
            .map_err(invalid)?;
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM __xml_live_peers WHERE room=$1")
            .bind(&name)
            .fetch_one(&mut *tx)
            .await
            .map_err(invalid)?;
        if count >= 32 {
            return Err(invalid("Document session is full"));
        }
        if count == 0 {
            // A new editing session starts from the current native XML. Old CRDT
            // identifiers must not overwrite a later external file replacement.
            sqlx::query("DELETE FROM __xml_live_updates WHERE room=$1")
                .bind(&name)
                .execute(&mut *tx)
                .await
                .map_err(invalid)?;
            sqlx::query("DELETE FROM __xml_live_fields WHERE room=$1")
                .bind(&name)
                .execute(&mut *tx)
                .await
                .map_err(invalid)?;
            epoch = sqlx::query_scalar("UPDATE __xml_live_rooms SET epoch=epoch+1,seq=0,checkpoint=0,snapshot=NULL,log_bytes=0 WHERE room=$1 RETURNING epoch").bind(&name).fetch_one(&mut *tx).await.map_err(invalid)?;
        }
        sqlx::query("INSERT INTO __xml_live_peers(id,room,instance,data,epoch,expires_at) VALUES($1,$2,$3,$4,$5,clock_timestamp()+interval '45 seconds')")
            .bind(&peer.id).bind(&name).bind(&self.instance).bind(json!(peer)).bind(epoch).execute(&mut *tx).await.map_err(invalid)?;
        sqlx::query("UPDATE __xml_live_rooms SET touched_at=clock_timestamp() WHERE room=$1")
            .bind(&name)
            .execute(&mut *tx)
            .await
            .map_err(invalid)?;
        // Register local interest before commit, otherwise its notification could
        // be discarded before the socket has read its initial snapshot.
        self.local
            .lock()
            .await
            .insert(peer.id.clone(), (room.clone(), epoch));
        if let Err(error) = tx.commit().await {
            self.local.lock().await.remove(&peer.id);
            return Err(invalid(error));
        }
        if let Err(error) = self.refresh_presence(room).await {
            self.leave(room, &peer.id).await;
            return Err(error);
        }
        Ok(epoch)
    }
    pub async fn leave(&self, room: &Room, id: &str) {
        if let Err(error) = sqlx::query("DELETE FROM __xml_live_peers WHERE id=$1 AND instance=$2")
            .bind(id)
            .bind(&self.instance)
            .execute(&self.pool)
            .await
        {
            tracing::warn!(%error, "Document peer cleanup deferred to lease expiry");
        }
        let mut local = self.local.lock().await;
        local.remove(id);
        if !local.values().any(|(value, _)| value == room)
            && let Some(hub) = self.hub.upgrade()
        {
            hub.peers.lock().await.remove(room);
        }
    }
    pub async fn refresh_presence(&self, room: &Room) -> RpcResult<()> {
        if let Some(hub) = self.hub.upgrade() {
            let mut peers = hub.peers.lock().await;
            let data: Vec<serde_json::Value> = sqlx::query_scalar(
                "SELECT data FROM __xml_live_peers WHERE room=$1 AND expires_at>clock_timestamp()",
            )
            .bind(key(room))
            .fetch_all(&self.pool)
            .await
            .map_err(invalid)?;
            let participants: Vec<Participant> = data
                .into_iter()
                .map(serde_json::from_value)
                .collect::<Result<_, _>>()
                .map_err(invalid)?;
            peers.insert(
                room.clone(),
                participants
                    .into_iter()
                    .map(|p| (p.id.clone(), p))
                    .collect(),
            );
        }
        Ok(())
    }
    pub async fn cursor(&self, room: &Room, id: &str, peer: &Participant) -> RpcResult<()> {
        let changed = sqlx::query("UPDATE __xml_live_peers SET data=$3,expires_at=clock_timestamp()+interval '45 seconds' WHERE id=$1 AND instance=$2 AND expires_at>clock_timestamp() AND room=$4")
            .bind(id).bind(&self.instance).bind(json!(peer)).bind(key(room)).execute(&self.pool).await.map_err(invalid)?;
        if changed.rows_affected() == 0 {
            return Err(invalid("Document session expired"));
        }
        Ok(())
    }
    pub async fn active(&self, room: &Room, id: &str, epoch: i64) -> RpcResult<bool> {
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM __xml_live_peers p JOIN __xml_live_rooms r USING(room) WHERE p.room=$1 AND p.id=$2 AND r.epoch=$3 AND p.expires_at>clock_timestamp())")
            .bind(key(room)).bind(id).bind(epoch).fetch_one(&self.pool).await.map_err(invalid)
    }
    pub async fn state(&self, room: &Room) -> RpcResult<Vec<u8>> {
        let mut tx = self.pool.begin().await.map_err(invalid)?;
        let snapshot: Option<Vec<u8>> =
            sqlx::query_scalar("SELECT snapshot FROM __xml_live_rooms WHERE room=$1 FOR SHARE")
                .bind(key(room))
                .fetch_one(&mut *tx)
                .await
                .map_err(invalid)?;
        let updates: Vec<Vec<u8>> =
            sqlx::query_scalar("SELECT data FROM __xml_live_updates WHERE room=$1 ORDER BY seq")
                .bind(key(room))
                .fetch_all(&mut *tx)
                .await
                .map_err(invalid)?;
        tx.commit().await.map_err(invalid)?;
        tokio::task::spawn_blocking(move || encode(snapshot, updates))
            .await
            .map_err(invalid)?
    }
    pub async fn append(
        &self,
        room: &Room,
        id: &str,
        epoch: i64,
        update: &[u8],
        initialize: Option<&str>,
    ) -> RpcResult<()> {
        Update::decode_v1(update).map_err(invalid)?;
        if update.len() > MAX_STATE {
            return Err(invalid("Shared update is too large"));
        }
        let name = key(room);
        let mut tx = self.pool.begin().await.map_err(invalid)?;
        let row = sqlx::query(
            "SELECT epoch,seq,log_bytes FROM __xml_live_rooms WHERE room=$1 FOR UPDATE",
        )
        .bind(&name)
        .fetch_one(&mut *tx)
        .await
        .map_err(invalid)?;
        let valid: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM __xml_live_peers WHERE room=$1 AND id=$2 AND instance=$3 AND expires_at>clock_timestamp())")
            .bind(&name).bind(id).bind(&self.instance).fetch_one(&mut *tx).await.map_err(invalid)?;
        if row.get::<i64, _>("epoch") != epoch || !valid {
            return Err(invalid("Document session expired"));
        }
        if let Some(key) = initialize {
            let inserted = sqlx::query(
                "INSERT INTO __xml_live_fields(room,key) VALUES($1,$2) ON CONFLICT DO NOTHING",
            )
            .bind(&name)
            .bind(key)
            .execute(&mut *tx)
            .await
            .map_err(invalid)?;
            if inserted.rows_affected() == 0 {
                return Ok(());
            }
        }
        let seq: i64 = row.get::<i64, _>("seq") + 1;
        let bytes: i64 = row.get::<i64, _>("log_bytes") + update.len() as i64;
        sqlx::query("INSERT INTO __xml_live_updates(room,seq,data) VALUES($1,$2,$3)")
            .bind(&name)
            .bind(seq)
            .bind(update)
            .execute(&mut *tx)
            .await
            .map_err(invalid)?;
        sqlx::query("UPDATE __xml_live_rooms SET seq=$2,log_bytes=$3,touched_at=clock_timestamp() WHERE room=$1").bind(&name).bind(seq).bind(bytes).execute(&mut *tx).await.map_err(invalid)?;
        if bytes >= COMPACT_BYTES {
            let snapshot: Option<Vec<u8>> =
                sqlx::query_scalar("SELECT snapshot FROM __xml_live_rooms WHERE room=$1")
                    .bind(&name)
                    .fetch_one(&mut *tx)
                    .await
                    .map_err(invalid)?;
            let updates: Vec<Vec<u8>> = sqlx::query_scalar(
                "SELECT data FROM __xml_live_updates WHERE room=$1 ORDER BY seq",
            )
            .bind(&name)
            .fetch_all(&mut *tx)
            .await
            .map_err(invalid)?;
            let snapshot = tokio::task::spawn_blocking(move || encode(snapshot, updates))
                .await
                .map_err(invalid)??;
            sqlx::query(
                "UPDATE __xml_live_rooms SET snapshot=$2,checkpoint=$3,log_bytes=0 WHERE room=$1",
            )
            .bind(&name)
            .bind(snapshot)
            .bind(seq)
            .execute(&mut *tx)
            .await
            .map_err(invalid)?;
            sqlx::query("DELETE FROM __xml_live_updates WHERE room=$1 AND seq<=$2")
                .bind(&name)
                .bind(seq)
                .execute(&mut *tx)
                .await
                .map_err(invalid)?;
        }
        let notice = if update.len() <= 3000 {
            json!({"room":name,"kind":"update","epoch":epoch,"seq":seq,"data":STANDARD.encode(update)})
        } else {
            json!({"room":name,"kind":"update","epoch":epoch,"seq":seq})
        };
        sqlx::query("SELECT pg_notify($1,$2)")
            .bind(CHANNEL)
            .bind(notice.to_string())
            .execute(&mut *tx)
            .await
            .map_err(invalid)?;
        tx.commit().await.map_err(invalid)
    }
    pub async fn initialize(
        &self,
        room: &Room,
        id: &str,
        epoch: i64,
        key: &str,
        value: &str,
    ) -> RpcResult<()> {
        // Generate the initial IDs independently, but only merge the winner of
        // the database lock. Two replicas must never merge both initial texts.
        let update = initial_update(key, value);
        self.append(room, id, epoch, &update, Some(key)).await
    }
}

fn initial_update(key: &str, value: &str) -> Vec<u8> {
    let doc = document();
    let fields = doc.get_or_insert_map("__fields");
    let text = doc.get_or_insert_text(key);
    let mut tx = doc.transact_mut();
    fields.insert(&mut tx, key, true);
    text.insert(&mut tx, 0, value);
    tx.encode_update_v1()
}
#[cfg(test)]
mod tests {
    use super::*;
    use yrs::GetString;
    #[test]
    fn checkpoints_preserve_utf16_edits_and_reject_invalid_updates() {
        let initial = initial_update("text", "Hallo 👋 Welt");
        let doc = document();
        doc.transact_mut()
            .apply_update(Update::decode_v1(&initial).unwrap())
            .unwrap();
        let delta = {
            let text = doc.get_or_insert_text("text");
            let mut tx = doc.transact_mut();
            text.insert(&mut tx, 9, "schöne ");
            tx.encode_update_v1()
        };
        let checkpoint = encode(Some(initial), vec![delta.clone()]).unwrap();
        // Replay a duplicated delta after compaction is harmless.
        let again = encode(Some(checkpoint), vec![delta]).unwrap();
        let copy = document();
        copy.transact_mut()
            .apply_update(Update::decode_v1(&again).unwrap())
            .unwrap();
        assert_eq!(
            copy.get_or_insert_text("text").get_string(&copy.transact()),
            "Hallo 👋 schöne Welt"
        );
        assert!(encode(None, vec![vec![255]]).is_err());
    }
}
