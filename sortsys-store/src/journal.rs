//! Indexed immutable technical events. Payloads remain opaque to the store.
use crate::StoreError;
use duckdb::{Connection, OptionalExt, Row, params, params_from_iter, types::Value};
use sortsys_zerotrust::journal::{
    JournalAppend, JournalEntry, JournalPage, JournalQuery, cursor, instant,
};

fn database(_: duckdb::Error) -> StoreError {
    StoreError::Unavailable("journal-database")
}
const COLUMNS: &str = "sequence,stream,entry_id,object_id,occurred_micros,sort_order,entry";
pub(crate) fn initialize(connection: &Connection, catalog: &str) -> Result<(), StoreError> {
    connection.execute_batch(&format!(
        "CREATE TABLE IF NOT EXISTS {catalog}.journal_state(singleton BOOLEAN PRIMARY KEY CHECK(singleton),sequence BIGINT NOT NULL CHECK(sequence>=0)); \
         INSERT INTO {catalog}.journal_state VALUES(TRUE,0) ON CONFLICT DO NOTHING; \
         CREATE TABLE IF NOT EXISTS {catalog}.journal_entries(sequence BIGINT PRIMARY KEY CHECK(sequence>0),stream VARCHAR NOT NULL,entry_id VARCHAR NOT NULL,object_id VARCHAR NOT NULL,occurred_micros BIGINT NOT NULL,sort_order BIGINT NOT NULL,entry VARCHAR NOT NULL,UNIQUE(stream,entry_id)); \
         CREATE INDEX IF NOT EXISTS journal_objects ON {catalog}.journal_entries(stream,object_id);"
    )).map_err(database)
}
pub(crate) fn append(
    connection: &Connection,
    catalog: &str,
    entries: &[JournalAppend],
) -> Result<(), StoreError> {
    if entries.is_empty() {
        return Ok(());
    }
    let current: i64 = connection
        .query_row(
            &format!("SELECT sequence FROM {catalog}.journal_state WHERE singleton=TRUE"),
            [],
            |row| row.get(0),
        )
        .map_err(database)?;
    let end = current
        .checked_add(i64::try_from(entries.len()).map_err(|_| StoreError::Integrity)?)
        .ok_or(StoreError::Integrity)?;
    for (index, entry) in entries.iter().enumerate() {
        let exists: bool = connection.query_row(&format!("SELECT EXISTS(SELECT 1 FROM {catalog}.journal_entries WHERE stream=? AND entry_id=?)"), params![entry.stream,entry.id], |row| row.get(0)).map_err(database)?;
        if exists {
            return Err(StoreError::Conflict);
        }
        let sequence = current + i64::try_from(index).map_err(|_| StoreError::Integrity)? + 1;
        let order = match &entry.order {
            Some(order) => cursor(order).map_err(|_| StoreError::Integrity)?,
            None => sequence,
        };
        connection
            .execute(
                &format!("INSERT INTO {catalog}.journal_entries VALUES(?,?,?,?,?,?,?)"),
                params![
                    sequence,
                    entry.stream,
                    entry.id,
                    entry.object,
                    instant(&entry.occurred_micros).map_err(|_| StoreError::Integrity)?,
                    order,
                    serde_json::to_string(entry).map_err(|_| StoreError::Integrity)?
                ],
            )
            .map_err(database)?;
    }
    connection
        .execute(
            &format!("UPDATE {catalog}.journal_state SET sequence=? WHERE singleton=TRUE"),
            [end],
        )
        .map_err(database)?;
    Ok(())
}
struct RawEntry {
    sequence: i64,
    stream: String,
    id: String,
    object: String,
    micros: i64,
    order: i64,
    value: String,
}
impl RawEntry {
    fn row(row: &Row<'_>) -> duckdb::Result<Self> {
        Ok(Self {
            sequence: row.get(0)?,
            stream: row.get(1)?,
            id: row.get(2)?,
            object: row.get(3)?,
            micros: row.get(4)?,
            order: row.get(5)?,
            value: row.get(6)?,
        })
    }
    fn checked(self) -> Result<JournalEntry, StoreError> {
        let entry: JournalAppend =
            serde_json::from_str(&self.value).map_err(|_| StoreError::Integrity)?;
        entry.validate().map_err(|_| StoreError::Integrity)?;
        let order = match &entry.order {
            Some(order) => cursor(order).map_err(|_| StoreError::Integrity)?,
            None => self.sequence,
        };
        if self.sequence <= 0
            || entry.stream != self.stream
            || entry.id != self.id
            || entry.object != self.object
            || instant(&entry.occurred_micros).map_err(|_| StoreError::Integrity)? != self.micros
            || order != self.order
        {
            return Err(StoreError::Integrity);
        }
        Ok(JournalEntry {
            sequence: self.sequence.to_string(),
            order: self.order.to_string(),
            entry,
        })
    }
}
pub(crate) fn get(
    connection: &Connection,
    catalog: &str,
    stream: &str,
    id: &str,
) -> Result<Option<JournalEntry>, StoreError> {
    sortsys_zerotrust::crypto::identifier(stream).map_err(|_| StoreError::Integrity)?;
    sortsys_zerotrust::crypto::identifier(id).map_err(|_| StoreError::Integrity)?;
    connection
        .query_row(
            &format!(
                "SELECT {COLUMNS} FROM {catalog}.journal_entries WHERE stream=? AND entry_id=?"
            ),
            params![stream, id],
            RawEntry::row,
        )
        .optional()
        .map_err(database)?
        .map(RawEntry::checked)
        .transpose()
}
struct Filter {
    sql: String,
    parameters: Vec<Value>,
}
impl Filter {
    fn for_query(query: &JournalQuery) -> Self {
        if query.streams.is_empty() {
            return Self {
                sql: "FALSE".into(),
                parameters: vec![],
            };
        }
        let streams = vec!["?"; query.streams.len()].join(",");
        let prefixes = vec!["starts_with(object_id,?)"; query.prefixes.len()].join(" OR ");
        let parameters = query
            .streams
            .iter()
            .chain(&query.prefixes)
            .cloned()
            .map(Value::Text)
            .collect();
        Self {
            sql: format!("stream IN ({streams}) AND ({prefixes})"),
            parameters,
        }
    }
}
pub(crate) fn query(
    connection: &Connection,
    catalog: &str,
    input: &JournalQuery,
) -> Result<JournalPage, StoreError> {
    input.validate().map_err(|_| StoreError::Integrity)?;
    crate::metadata::read_transaction(connection, || read_page(connection, catalog, input))
}
fn read_page(
    connection: &Connection,
    catalog: &str,
    input: &JournalQuery,
) -> Result<JournalPage, StoreError> {
    let filter = Filter::for_query(input);
    let (current, total): (i64, i64) = connection
        .query_row(
            &format!(
                "SELECT COALESCE(max(sequence),0),count(*) FROM {catalog}.journal_entries WHERE {}",
                filter.sql
            ),
            params_from_iter(filter.parameters.iter()),
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(database)?;
    let snapshot = match &input.snapshot {
        Some(snapshot) => cursor(snapshot).map_err(|_| StoreError::Integrity)?,
        None => current,
    };
    if snapshot > current {
        return Err(StoreError::Integrity);
    }
    let unchanged = input.known.as_deref() == Some(current.to_string().as_str())
        && input.known_total.as_deref() == Some(total.to_string().as_str());
    let mut result = JournalPage {
        current: current.to_string(),
        total: total.to_string(),
        snapshot: snapshot.to_string(),
        after: None,
        after_micros: None,
        after_order: None,
        unchanged,
        entries: vec![],
    };
    if unchanged {
        return Ok(result);
    }
    let mut predicate = format!("{} AND sequence<=?", filter.sql);
    let mut parameters = filter.parameters.clone();
    parameters.push(Value::BigInt(snapshot));
    if let Some(before) = &input.before {
        let before = cursor(before).map_err(|_| StoreError::Integrity)?;
        let mut anchor_parameters = filter.parameters.clone();
        anchor_parameters.push(Value::BigInt(before));
        anchor_parameters.push(Value::BigInt(snapshot));
        let anchor: Option<(i64,i64,i64)> = connection.query_row(&format!("SELECT occurred_micros,sort_order,sequence FROM {catalog}.journal_entries WHERE {} AND sequence=? AND sequence<=?", filter.sql), params_from_iter(anchor_parameters.iter()), |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?))).optional().map_err(database)?;
        let (micros, order, sequence) = anchor.ok_or(StoreError::Integrity)?;
        predicate.push_str(" AND (occurred_micros,sort_order,sequence)<(?,?,?)");
        parameters.extend([
            Value::BigInt(micros),
            Value::BigInt(order),
            Value::BigInt(sequence),
        ]);
    }
    parameters.push(Value::BigInt(
        i64::try_from(input.limit + 1).map_err(|_| StoreError::Integrity)?,
    ));
    let mut statement = connection.prepare(&format!("SELECT {COLUMNS} FROM {catalog}.journal_entries WHERE {predicate} ORDER BY occurred_micros DESC,sort_order DESC,sequence DESC LIMIT ?")).map_err(database)?;
    let rows = statement
        .query_map(params_from_iter(parameters.iter()), RawEntry::row)
        .map_err(database)?;
    let mut entries = rows
        .map(|row| row.map_err(database).and_then(RawEntry::checked))
        .collect::<Result<Vec<_>, _>>()?;
    if entries.len() > input.limit {
        entries.pop();
        if let Some(last) = entries.last() {
            result.after = Some(last.sequence.clone());
            result.after_micros = Some(last.entry.occurred_micros.clone());
            result.after_order = Some(last.order.clone());
        }
    }
    result.entries = entries;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sortsys_zerotrust::metadata::{MetadataBatch, RecordCheck, RecordKey, RecordPut};

    fn append(id: &str, object: &str, time: &str) -> JournalAppend {
        JournalAppend {
            stream: "project:one:master-data".into(),
            id: id.into(),
            object: object.into(),
            occurred_micros: time.into(),
            order: None,
            value: "opaque-reference".into(),
        }
    }
    fn batch(operation: &str, entries: Vec<JournalAppend>) -> MetadataBatch {
        MetadataBatch {
            operation: operation.into(),
            checks: vec![],
            collections: vec![],
            puts: vec![],
            deletes: vec![],
            hints: vec![],
            journal: entries,
        }
    }
    fn query_all() -> JournalQuery {
        JournalQuery {
            streams: vec!["project:one:master-data".into()],
            prefixes: vec!["note:".into()],
            before: None,
            snapshot: None,
            known: None,
            known_total: None,
            limit: 2,
        }
    }
    fn memory() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        crate::metadata::initialize(&connection, "memory").unwrap();
        connection
    }
    #[test]
    fn immutable_entries_keep_chronological_pages_stable_across_late_backdated_commits() {
        let connection = memory();
        let initial = batch(
            "initial",
            vec![
                append("one", "note:one", "1000000"),
                append("two", "note:two", "2000000"),
                append("three", "note:three", "2000000"),
            ],
        );
        crate::metadata::transact(&connection, "memory", &initial).unwrap();
        crate::metadata::transact(&connection, "memory", &initial).unwrap();
        let mut request = query_all();
        let first = query(&connection, "memory", &request).unwrap();
        assert_eq!(first.current, "3");
        assert_eq!(first.total, "3");
        assert_eq!(
            first
                .entries
                .iter()
                .map(|entry| entry.sequence.as_str())
                .collect::<Vec<_>>(),
            ["3", "2"]
        );
        assert_eq!(first.after.as_deref(), Some("2"));
        assert_eq!(first.after_micros.as_deref(), Some("2000000"));
        crate::metadata::transact(
            &connection,
            "memory",
            &batch("backdated", vec![append("four", "note:four", "500000")]),
        )
        .unwrap();
        request.before = first.after;
        request.snapshot = Some(first.snapshot);
        let next = query(&connection, "memory", &request).unwrap();
        assert_eq!(next.current, "4");
        assert_eq!(next.total, "4");
        assert_eq!(next.entries.len(), 1);
        assert_eq!(next.entries[0].sequence, "1");
        assert!(next.after.is_none());
        let mut known = query_all();
        known.known = Some("3".into());
        known.known_total = Some("3".into());
        assert!(!query(&connection, "memory", &known).unwrap().unchanged);
        known.known = Some("4".into());
        known.known_total = Some("4".into());
        let unchanged = query(&connection, "memory", &known).unwrap();
        assert!(unchanged.unchanged);
        assert!(unchanged.entries.is_empty());
        let mut absent = query_all();
        absent.streams = vec!["project:other:master-data".into()];
        assert_eq!(query(&connection, "memory", &absent).unwrap().total, "0");
        absent.streams.clear();
        assert_eq!(query(&connection, "memory", &absent).unwrap().current, "0");
    }
    #[test]
    fn a_duplicate_entry_rolls_back_metadata_counters_receipts_and_the_whole_append_batch() {
        let connection = memory();
        crate::metadata::transact(
            &connection,
            "memory",
            &batch("first", vec![append("one", "note:one", "0")]),
        )
        .unwrap();
        let key = RecordKey {
            collection: "controls".into(),
            key: "unpublished".into(),
        };
        let mut invalid = batch(
            "invalid",
            vec![
                append("two", "note:two", "1"),
                append("one", "note:one", "2"),
            ],
        );
        invalid.checks.push(RecordCheck {
            record: key.clone(),
            version: None,
        });
        invalid.puts.push(RecordPut {
            record: key.clone(),
            value: "must roll back".into(),
        });
        assert!(matches!(
            crate::metadata::transact(&connection, "memory", &invalid),
            Err(StoreError::Conflict)
        ));
        assert!(
            crate::metadata::read(&connection, "memory", &[key]).unwrap()[0]
                .value
                .is_none()
        );
        assert!(
            get(&connection, "memory", "project:one:master-data", "two")
                .unwrap()
                .is_none()
        );
        assert_eq!(
            crate::metadata::events(&connection, "memory", "0")
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            connection
                .query_row("SELECT count(*) FROM metadata_operations", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        let next = batch("next", vec![append("two", "note:two", "3")]);
        assert!(matches!(
            crate::metadata::validate_snapshot(&connection, "memory", &next),
            Err(StoreError::Integrity)
        ));
        crate::metadata::transact(&connection, "memory", &next).unwrap();
        assert_eq!(
            get(&connection, "memory", "project:one:master-data", "two")
                .unwrap()
                .unwrap()
                .sequence,
            "2"
        );
    }
    #[test]
    fn filters_are_literal_and_a_cursor_cannot_select_another_streams_anchor() {
        let connection = memory();
        let mut private = append("private", "note_hidden", "1");
        private.stream = "project:secret:master-data".into();
        crate::metadata::transact(
            &connection,
            "memory",
            &batch(
                "initial",
                vec![append("public", "note_public", "2"), private],
            ),
        )
        .unwrap();
        let mut input = query_all();
        input.prefixes = vec!["note_".into()];
        let selected = query(&connection, "memory", &input).unwrap();
        assert_eq!(selected.total, "1");
        input.before = Some("2".into());
        assert!(matches!(
            query(&connection, "memory", &input),
            Err(StoreError::Integrity)
        ));
        input.before = None;
        input.prefixes = vec!["note%".into()];
        assert!(matches!(
            query(&connection, "memory", &input),
            Err(StoreError::Integrity)
        ));
    }
}
