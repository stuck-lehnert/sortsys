//! Bounded operator diagnostics. Only technical constants cross this boundary;
//! decrypted error text, arbitrary metadata and stack traces are never stored.
use std::sync::Arc;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{
    api::Success,
    auth::{AuthResult, AuthService},
    control::{Repository, key, unavailable},
    error::{ErrorCode, RpcError, RpcResult},
    ids::Id,
    rpc::ProcedureRegistryBuilder,
};

const CAPACITY: usize = 1024;
const REPORTS_PER_MINUTE: u32 = 20;
const WRITE_ATTEMPTS: usize = 8;
const MESSAGE: &str = "Client operation failed";
const SOURCES: &[&str] = &[
    "client.error",
    "client.query",
    "client.queryDynamic",
    "client.streamQuery",
    "client.mutate",
    "client.mutateDynamic",
    "window.error",
    "window.unhandledrejection",
    "react-router.errorBoundary",
    "react.scopedErrorBoundary",
    "gaeb.autosave",
];
const ROUTES: &[&str] = &[
    "/",
    "/admin",
    "/settings",
    "/projects",
    "/offers",
    "/gaeb",
    "/products",
    "/customers",
    "/contacts",
    "/users",
    "/tools",
    "/documents",
    "/import",
    "/llm",
    "/dashboard",
];

#[derive(Clone, Copy, Default, Deserialize, Serialize, TS)]
#[serde(rename_all = "lowercase")]
enum Level {
    #[default]
    Error,
    Warning,
}

#[derive(Clone, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
struct TechnicalMetadata {
    revision: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    status: Option<u16>,
}

#[derive(Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReportInput {
    source: String,
    message: String,
    #[serde(default)]
    #[ts(optional)]
    level: Option<Level>,
    #[serde(default)]
    #[ts(optional = nullable)]
    stack: Option<String>,
    #[serde(default)]
    #[ts(optional = nullable)]
    path: Option<String>,
    #[serde(default)]
    #[ts(optional = nullable)]
    component_stack: Option<String>,
    metadata: TechnicalMetadata,
}

impl ReportInput {
    fn validate(&self) -> RpcResult<()> {
        let revision = &self.metadata.revision;
        let commit = matches!(revision.len(), 40 | 64)
            && revision.bytes().all(|byte| byte.is_ascii_hexdigit());
        if self.message != MESSAGE
            || !SOURCES.contains(&self.source.as_str())
            || self.stack.is_some()
            || self.component_stack.is_some()
            || !ROUTES.contains(&self.path.as_deref().unwrap_or("/"))
            || !(commit || revision == "development")
            || self
                .metadata
                .status
                .is_some_and(|status| !(100..=599).contains(&status))
        {
            return Err(RpcError::new(
                ErrorCode::BadRequest,
                "Invalid technical error report",
            ));
        }
        Ok(())
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredReport {
    sequence: i64,
    tenant: String,
    author: Id,
    username: String,
    report: ReportInput,
    created_at: DateTime<Utc>,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Admission {
    minute: i64,
    count: u32,
}

impl Admission {
    fn admit(&mut self, minute: i64) -> bool {
        // Replicas may have slightly different clocks. An older clock must
        // never reopen the shared window established by another instance.
        if minute > self.minute {
            self.minute = minute;
            self.count = 0;
        }
        if self.count >= REPORTS_PER_MINUTE {
            return false;
        }
        self.count += 1;
        true
    }
}

#[derive(Default, Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct ListInput {
    #[ts(optional)]
    tenant: Option<String>,
    #[ts(optional)]
    limit: Option<usize>,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct OperatorReport {
    id: Id,
    tenant: String,
    level: Level,
    source: String,
    message: String,
    stack: Option<String>,
    path: Option<String>,
    component_stack: Option<String>,
    metadata: TechnicalMetadata,
    user_agent: Option<String>,
    created_by_user_id: Id,
    username: String,
    #[ts(type = "Date")]
    created_at: DateTime<Utc>,
}

async fn append(repository: &Repository, auth: &AuthResult, input: ReportInput) -> RpcResult<()> {
    input.validate()?;
    let author = Id(auth.user.id.parse().map_err(|_| unavailable())?);
    for attempt in 0..WRITE_ATTEMPTS {
        let now = Utc::now();
        let mut transaction = repository.transaction()?;
        let admission_key = key("diagnostic-admission", &auth.tenant);
        let mut admission: Admission = transaction
            .read(admission_key.clone())
            .await?
            .unwrap_or_default();
        let minute = now.timestamp().div_euclid(60);
        if !admission.admit(minute) {
            // Diagnostics are best effort. Dropping excess reports must not
            // trigger another reporting failure in the caller.
            return Ok(());
        }
        let sequence_key = key("diagnostic-state", "sequence");
        let previous: i64 = transaction.read(sequence_key.clone()).await?.unwrap_or(0);
        let sequence = previous
            .checked_add(1)
            .filter(|value| *value > 0)
            .ok_or_else(unavailable)?;
        let slot = sequence % CAPACITY as i64;
        let report = StoredReport {
            sequence,
            tenant: auth.tenant.clone(),
            author,
            username: auth.user.username.clone(),
            report: input.clone(),
            created_at: now,
        };
        transaction.put(admission_key, &admission).await?;
        transaction.put(sequence_key, &sequence).await?;
        transaction
            .put(key("diagnostic-reports", &slot.to_string()), &report)
            .await?;
        match transaction.commit().await {
            Ok(_) => return Ok(()),
            Err(error) if error.code == ErrorCode::Conflict && attempt + 1 < WRITE_ATTEMPTS => {
                continue;
            }
            Err(error) => return Err(error),
        }
    }
    Err(unavailable())
}

async fn list(repository: &Repository, input: ListInput) -> RpcResult<Vec<OperatorReport>> {
    let mut transaction = repository.transaction()?;
    let mut reports: Vec<StoredReport> = transaction.all("diagnostic-reports", CAPACITY).await?;
    transaction.validate().await?;
    if let Some(tenant) = input.tenant {
        reports.retain(|report| report.tenant == tenant);
    }
    reports.sort_by_key(|report| std::cmp::Reverse(report.sequence));
    reports.truncate(input.limit.unwrap_or(200).clamp(1, 200));
    reports
        .into_iter()
        .map(|stored| {
            stored.report.validate()?;
            Ok(OperatorReport {
                id: Id(stored.sequence),
                tenant: stored.tenant,
                level: stored.report.level.unwrap_or_default(),
                source: stored.report.source,
                message: MESSAGE.into(),
                stack: None,
                path: stored.report.path,
                component_stack: None,
                metadata: stored.report.metadata,
                user_agent: None,
                created_by_user_id: stored.author,
                username: stored.username,
                created_at: stored.created_at,
            })
        })
        .collect()
}

pub(crate) fn register(
    builder: ProcedureRegistryBuilder,
    service: Arc<AuthService>,
) -> ProcedureRegistryBuilder {
    let report_service = Arc::clone(&service);
    builder
        .mutation("errorReports.report", move |context, input: ReportInput| {
            let service = Arc::clone(&report_service);
            async move {
                let auth = service.authenticate(&context.headers).await?;
                append(service.records()?, &auth, input).await?;
                Ok(Success { success: true })
            }
        })
        .query(
            "admin.errors.list",
            move |context, input: Option<ListInput>| {
                let service = Arc::clone(&service);
                async move {
                    service.require_global_operator(&context.headers).await?;
                    list(service.records()?, input.unwrap_or_default()).await
                }
            },
        )
}

pub(crate) fn register_contract(builder: ProcedureRegistryBuilder) -> ProcedureRegistryBuilder {
    builder
        .mutation_stub::<ReportInput, Success>("errorReports.report")
        .query_stub::<Option<ListInput>, Vec<OperatorReport>>("admin.errors.list")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_slow_replica_cannot_reset_an_exhausted_window() {
        let mut admission = Admission::default();
        for _ in 0..REPORTS_PER_MINUTE {
            assert!(admission.admit(100));
        }
        assert!(!admission.admit(99));
        assert!(!admission.admit(100));
        assert!(admission.admit(101));
        assert!(admission.admit(100));
        assert_eq!(admission.minute, 101);
        assert_eq!(admission.count, 2);
    }
    #[test]
    fn technical_report_schema_rejects_content_and_unbounded_metadata() {
        let safe = serde_json::json!({"source":"gaeb.autosave","message":MESSAGE,"path":"/gaeb","metadata":{"revision":"development","status":409}});
        let report: ReportInput = serde_json::from_value(safe.clone()).unwrap();
        assert!(report.validate().is_ok());
        for (field, value) in [
            ("source", serde_json::json!("Private customer")),
            ("message", serde_json::json!("Price 123.45")),
            ("stack", serde_json::json!("secret stack")),
            ("componentStack", serde_json::json!("secret component")),
            (
                "path",
                serde_json::json!("/gaeb/private-document?price=123"),
            ),
            (
                "metadata",
                serde_json::json!({"revision":"private-price-123"}),
            ),
            (
                "metadata",
                serde_json::json!({"revision":"development","status":999}),
            ),
        ] {
            let mut invalid = safe.clone();
            invalid[field] = value;
            assert!(
                serde_json::from_value::<ReportInput>(invalid)
                    .unwrap()
                    .validate()
                    .is_err(),
                "{field}"
            );
        }
        for field in ["extra", "metadata"] {
            let mut invalid = safe.clone();
            if field == "metadata" {
                invalid["metadata"]["secret"] = serde_json::json!("private");
            } else {
                invalid[field] = serde_json::json!("private");
            }
            assert!(serde_json::from_value::<ReportInput>(invalid).is_err());
        }
    }
}
