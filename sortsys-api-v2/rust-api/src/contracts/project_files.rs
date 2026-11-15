#![doc = " Project files, upload completion, thumbnails, and signed download URLs."]
use crate::{api::Success, ids::Id, rpc::ProcedureRegistryBuilder};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use ts_rs::TS;
pub fn register_contract(builder: ProcedureRegistryBuilder) -> ProcedureRegistryBuilder {
    builder
        .mutation_stub::<RenameFileInput, Success>("projects.files.rename")
        .mutation_stub::<MoveFilesInput, Success>("projects.files.move")
        .query_stub::<ProjectFilesInput, Vec<ProjectFileFolder>>("projects.files.folders.list")
        .mutation_stub::<CreateFolderInput, CreateFolderOutput>("projects.files.folders.create")
        .mutation_stub::<RenameFolderInput, Success>("projects.files.folders.rename")
        .mutation_stub::<MoveFolderInput, Success>("projects.files.folders.move")
        .mutation_stub::<DeleteFolderInput, Success>("projects.files.folders.delete")
        .query_stub::<SearchProjectFilesInput, Vec<ProjectFileSearchResult>>(
            "projects.files.search",
        )
}
#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectFilesInput {
    pub project_id: Id,
}
#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SearchProjectFilesInput {
    pub query: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub project_id: Option<Id>,
    #[serde(default = "default_search_limit")]
    pub limit: i64,
}
fn default_search_limit() -> i64 {
    50
}
#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RenameFileInput {
    pub project_id: Id,
    pub file_id: Id,
    pub file_name: String,
}
#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MoveFilesInput {
    pub project_id: Id,
    pub file_ids: Vec<Id>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub folder_id: Option<Id>,
}
#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateFolderInput {
    pub project_id: Id,
    pub name: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub parent_folder_id: Option<Id>,
}
#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RenameFolderInput {
    pub project_id: Id,
    pub folder_id: Id,
    pub name: String,
}
#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MoveFolderInput {
    pub project_id: Id,
    pub folder_id: Id,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub parent_folder_id: Option<Id>,
}
#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeleteFolderInput {
    pub project_id: Id,
    pub folder_id: Id,
}
#[derive(Debug, Serialize, TS)]
pub struct CreateFolderOutput {
    pub id: Id,
}
pub use crate::transport::ProjectFile;
#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFileSearchResult {
    pub id: Id,
    pub project_id: Id,
    pub project_title: String,
    pub file_name: String,
    pub mime_type: String,
    pub text_extraction_status: String,
    pub excerpt: Option<String>,
    pub rank: f64,
    #[ts(type = "Date")]
    pub modified_at: DateTime<Utc>,
}
#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFileFolder {
    pub id: Id,
    pub project_id: Id,
    pub parent_folder_id: Option<Id>,
    pub name: String,
    pub created_by_user_id: Option<Id>,
    #[ts(type = "Date")]
    pub created_at: DateTime<Utc>,
    #[ts(type = "Date")]
    pub modified_at: DateTime<Utc>,
}
