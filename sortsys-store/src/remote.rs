//! DuckDB 2.0 CONNECT routing supports direct queries, but not the prepared
//! statements used internally by duckdb-rs. Keep the small C-API boundary here.
use std::{ffi::CString, ptr};

use duckdb::ffi;

use super::{MAX_CIPHERTEXT_BYTES, QuackConfig, StoreError, VERSION, sql_string};

pub(super) struct Remote {
    database: ffi::duckdb_database,
    connection: ffi::duckdb_connection,
}

// Connections move between blocking workers, with exclusive ownership. Neither
// the handles nor any result/buffer is shared or accessed concurrently.
unsafe impl Send for Remote {}

struct ResultHandle(ffi::duckdb_result);
impl Drop for ResultHandle {
    fn drop(&mut self) {
        // SAFETY: duckdb_query initializes this result, including on error;
        // this guard owns it and destroys it exactly once.
        unsafe { ffi::duckdb_destroy_result(&mut self.0) }
    }
}
struct StringHandle(ffi::duckdb_string);
impl Drop for StringHandle {
    fn drop(&mut self) {
        // SAFETY: duckdb_value_string returns an owned allocation. The result
        // is copied before this guard frees it, and no reference escapes.
        unsafe { ffi::duckdb_free(self.0.data.cast()) }
    }
}

impl Remote {
    pub fn open(config: &QuackConfig) -> Result<Self, StoreError> {
        let mut remote = Self {
            database: ptr::null_mut(),
            connection: ptr::null_mut(),
        };
        // SAFETY: null path opens an in-memory engine; both out-pointers are
        // initialized and owned by remote, whose Drop handles partial startup.
        unsafe {
            if ffi::duckdb_open(ptr::null(), &mut remote.database) != ffi::DuckDBSuccess {
                return Err(StoreError::Unavailable("engine"));
            }
            if ffi::duckdb_connect(remote.database, &mut remote.connection) != ffi::DuckDBSuccess {
                return Err(StoreError::Unavailable("engine-connect"));
            }
        }
        if remote.string("SELECT version()", "version")?.as_deref() != Some(VERSION) {
            return Err(StoreError::Configuration("DuckDB 2.0.0 is required"));
        }
        let extensions = config
            .extensions
            .to_str()
            .ok_or(StoreError::Configuration("extension directory"))?;
        remote.execute(
            &format!(
                "SET threads=1; SET memory_limit='256MB'; SET extension_directory={}; \
                 SET autoinstall_known_extensions=false; SET autoload_known_extensions=false; \
                 LOAD httpfs; LOAD quack; ATTACH {} AS remote(TOKEN {},DISABLE_SSL {}); CONNECT remote;",
                sql_string(extensions), sql_string(&config.uri),
                sql_string(&config.token), config.disable_ssl
            ),
            "remote-connect",
        )?;
        Ok(remote)
    }
    fn query(&mut self, sql: &str, stage: &'static str) -> Result<ResultHandle, StoreError> {
        let sql = CString::new(sql).map_err(|_| StoreError::Integrity)?;
        // SAFETY: duckdb_result is a C POD struct whose initial null/zero fields
        // are valid; duckdb_query initializes it synchronously and materializes
        // results before returning. SQL and the exclusively owned connection
        // stay alive throughout the call. The guard also destroys error results.
        let mut result = ResultHandle(unsafe { std::mem::zeroed() });
        let status = unsafe { ffi::duckdb_query(self.connection, sql.as_ptr(), &mut result.0) };
        if status != ffi::DuckDBSuccess {
            // Native error strings can contain SQL, including the service
            // credential. Never propagate them into responses or logs.
            // SAFETY: the failed, initialized result remains owned here.
            let kind = unsafe { ffi::duckdb_result_error_type(&mut result.0) };
            return Err(match kind {
                ffi::duckdb_error_type_DUCKDB_ERROR_TRANSACTION
                | ffi::duckdb_error_type_DUCKDB_ERROR_CONSTRAINT => StoreError::Conflict,
                _ => {
                    tracing::warn!(stage, error_type = kind, "Ciphertext query failed");
                    StoreError::Unavailable(stage)
                }
            });
        }
        Ok(result)
    }
    pub fn execute(&mut self, sql: &str, stage: &'static str) -> Result<(), StoreError> {
        self.query(sql, stage)?;
        Ok(())
    }
    pub fn string(&mut self, sql: &str, stage: &'static str) -> Result<Option<String>, StoreError> {
        let encoded_limit = MAX_CIPHERTEXT_BYTES.div_ceil(3) * 4;
        Ok(self
            .strings(sql, stage, 1, encoded_limit, encoded_limit)?
            .pop())
    }
    pub fn strings(
        &mut self,
        sql: &str,
        stage: &'static str,
        maximum_rows: usize,
        maximum_value: usize,
        maximum_total: usize,
    ) -> Result<Vec<String>, StoreError> {
        let mut result = self.query(sql, stage)?;
        // SAFETY: all accesses are within the owned, materialized result's
        // lifetime. Check shape/type/null and budgets before copying strings.
        unsafe {
            let rows = ffi::duckdb_row_count(&mut result.0);
            if ffi::duckdb_column_count(&mut result.0) != 1
                || ffi::duckdb_column_type(&mut result.0, 0) != ffi::DUCKDB_TYPE_DUCKDB_TYPE_VARCHAR
                || rows > maximum_rows as u64
            {
                return Err(StoreError::Integrity);
            }
            let mut values = Vec::with_capacity(rows as usize);
            let mut total = 0usize;
            for row in 0..rows {
                if ffi::duckdb_value_is_null(&mut result.0, 0, row) {
                    return Err(StoreError::Integrity);
                }
                let value = StringHandle(ffi::duckdb_value_string(&mut result.0, 0, row));
                if value.0.data.is_null() || value.0.size > maximum_value as u64 {
                    return Err(StoreError::Integrity);
                }
                total = total
                    .checked_add(value.0.size as usize)
                    .ok_or(StoreError::Integrity)?;
                if total > maximum_total {
                    return Err(StoreError::Integrity);
                }
                // Use the explicit byte length, preserving embedded NUL bytes.
                let bytes = std::slice::from_raw_parts(value.0.data.cast(), value.0.size as usize);
                values.push(String::from_utf8(bytes.to_vec()).map_err(|_| StoreError::Integrity)?);
            }
            Ok(values)
        }
    }
}
impl Drop for Remote {
    fn drop(&mut self) {
        // SAFETY: this object uniquely owns both handles; disconnect before
        // closing the engine. Partial initialization leaves null handles.
        unsafe {
            if !self.connection.is_null() {
                ffi::duckdb_disconnect(&mut self.connection);
            }
            if !self.database.is_null() {
                ffi::duckdb_close(&mut self.database);
            }
        }
    }
}
