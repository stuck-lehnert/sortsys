#![doc = " Shared authentication, input parsing, validation, and wire helpers."]
pub use crate::error::{bad_request, conflict, forbidden, internal, not_found};
pub use crate::transport::{Address, EmailEntry, Patch, PhoneEntry};
