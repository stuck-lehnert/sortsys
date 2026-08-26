//! Independent DWG reader used by the sortsys browser plan viewer.
//!
//! Parsing is intentionally split into small stages. Each stage owns one part
//! of the file format and returns ordinary Rust values instead of sharing a
//! mutable parser object across the entire pipeline.

pub mod bits;
pub mod dwgfile;
pub mod entities;
pub mod objects;
pub mod projector;
pub mod scene;

#[cfg(target_arch = "wasm32")]
mod wasm;

pub use projector::from_bytes;
