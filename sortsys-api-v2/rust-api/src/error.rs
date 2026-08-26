//! RPC error codes and their wire representation.

use serde_json::{Value, json};

use crate::superjson;

pub type RpcResult<T> = Result<T, RpcError>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCode {
    ParseError,
    BadRequest,
    InternalServerError,
    Unauthorized,
    Forbidden,
    NotFound,
    MethodNotSupported,
    Conflict,
    PreconditionFailed,
    PayloadTooLarge,
    UnprocessableContent,
    TooManyRequests,
}

impl ErrorCode {
    pub const fn name(self) -> &'static str {
        match self {
            Self::ParseError => "PARSE_ERROR",
            Self::BadRequest => "BAD_REQUEST",
            Self::InternalServerError => "INTERNAL_SERVER_ERROR",
            Self::Unauthorized => "UNAUTHORIZED",
            Self::Forbidden => "FORBIDDEN",
            Self::NotFound => "NOT_FOUND",
            Self::MethodNotSupported => "METHOD_NOT_SUPPORTED",
            Self::Conflict => "CONFLICT",
            Self::PreconditionFailed => "PRECONDITION_FAILED",
            Self::PayloadTooLarge => "PAYLOAD_TOO_LARGE",
            Self::UnprocessableContent => "UNPROCESSABLE_CONTENT",
            Self::TooManyRequests => "TOO_MANY_REQUESTS",
        }
    }

    pub const fn number(self) -> i32 {
        match self {
            Self::ParseError => -32700,
            Self::BadRequest => -32600,
            Self::InternalServerError => -32603,
            Self::Unauthorized => -32001,
            Self::Forbidden => -32003,
            Self::NotFound => -32004,
            Self::MethodNotSupported => -32005,
            Self::Conflict => -32009,
            Self::PreconditionFailed => -32012,
            Self::PayloadTooLarge => -32013,
            Self::UnprocessableContent => -32022,
            Self::TooManyRequests => -32029,
        }
    }
}

#[derive(Debug, Clone, thiserror::Error)]
#[error("{message}")]
pub struct RpcError {
    pub code: ErrorCode,
    pub message: String,
    pub path: Option<String>,
    pub http_code: Option<u16>,
    pub validation_errors: Option<Value>,
}

impl RpcError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            path: None,
            http_code: None,
            validation_errors: None,
        }
    }

    pub fn at_path(mut self, path: impl Into<String>) -> Self {
        self.path = Some(path.into());
        self
    }

    pub fn with_http_code(mut self, http_code: u16) -> Self {
        self.http_code = Some(http_code);
        self
    }

    pub fn with_validation_errors(mut self, validation_errors: Value) -> Self {
        self.validation_errors = Some(validation_errors);
        self
    }

    pub fn not_found(path: &str) -> Self {
        Self::new(
            ErrorCode::NotFound,
            format!("No procedure found on path \"{path}\""),
        )
        .at_path(path)
    }

    pub fn bad_input(path: &str, message: impl Into<String>) -> Self {
        let message = message.into();
        Self::new(ErrorCode::BadRequest, message.clone())
            .at_path(path)
            .with_validation_errors(json!([{
                "code": "custom",
                "path": [],
                "message": message,
            }]))
    }

    pub fn internal(path: &str, message: impl Into<String>) -> Self {
        Self::new(ErrorCode::InternalServerError, message).at_path(path)
    }

    pub fn at_path_if_missing(mut self, path: impl Into<String>) -> Self {
        if self.path.is_none() {
            self.path = Some(path.into());
        }
        self
    }

    pub fn into_wire(self) -> Value {
        let mut data = serde_json::Map::new();
        data.insert("code".into(), Value::String(self.code.name().into()));
        if let Some(path) = self.path {
            data.insert("path".into(), Value::String(path));
        }
        if let Some(http_code) = self.http_code {
            data.insert("httpCode".into(), Value::Number(http_code.into()));
        }

        let mut undefined_paths = vec!["data.stack".to_owned()];
        match self.validation_errors {
            Some(errors) => {
                data.insert("validationErrors".into(), errors);
            }
            None => {
                data.insert("validationErrors".into(), Value::Null);
                undefined_paths.push("data.validationErrors".to_owned());
            }
        }
        data.insert("stack".into(), Value::Null);

        let error = json!({
            "message": self.message,
            "code": self.code.number(),
            "data": Value::Object(data),
        });

        json!({
            "error": superjson::encode_with_undefined(error, undefined_paths),
        })
    }
}
