//! Environment and Docker-secret configuration loading.
use std::{env, fs};

pub(crate) fn optional(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .or_else(|| fs::read_to_string(format!("/run/secrets/SORTSYS_API_V2_{name}")).ok())
        .map(|value| value.trim().to_owned())
}
