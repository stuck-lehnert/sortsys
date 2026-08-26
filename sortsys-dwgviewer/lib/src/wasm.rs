//! Minimal allocation-based WebAssembly ABI consumed by the browser worker.

use std::sync::{Mutex, MutexGuard};

static RESULT: Mutex<Vec<u8>> = Mutex::new(Vec::new());

fn result_buffer() -> MutexGuard<'static, Vec<u8>> {
    RESULT
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[unsafe(no_mangle)]
pub extern "C" fn sortsys_dwg_alloc(length: usize) -> *mut u8 {
    let buffer = vec![0_u8; length].into_boxed_slice();

    Box::into_raw(buffer).cast::<u8>()
}

/// # Safety
///
/// `pointer` and `length` must be the unchanged values returned by
/// [`sortsys_dwg_alloc`], and the allocation must not have been freed already.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sortsys_dwg_dealloc(pointer: *mut u8, length: usize) {
    if pointer.is_null() {
        return;
    }

    let slice = std::ptr::slice_from_raw_parts_mut(pointer, length);
    drop(unsafe { Box::from_raw(slice) });
}

/// Parses one DWG byte buffer and stores the JSON result in module-owned memory.
/// A zero status indicates success; non-zero means that serialization failed.
///
/// # Safety
///
/// `pointer..pointer + length` must identify readable WebAssembly linear memory.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sortsys_dwg_parse(pointer: *const u8, length: usize) -> i32 {
    if pointer.is_null() {
        return 1;
    }

    let input = unsafe { std::slice::from_raw_parts(pointer, length) };
    let document = crate::projector::from_bytes(input);
    let Ok(json) = serde_json::to_vec(&document) else {
        result_buffer().clear();
        return 2;
    };

    *result_buffer() = json;
    0
}

#[unsafe(no_mangle)]
pub extern "C" fn sortsys_dwg_result_ptr() -> *const u8 {
    result_buffer().as_ptr()
}

#[unsafe(no_mangle)]
pub extern "C" fn sortsys_dwg_result_len() -> usize {
    result_buffer().len()
}
