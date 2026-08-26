//! Top-level DWG-to-scene projection pipeline.

mod blocks;

use crate::{
    dwgfile::{self, LayoutKind, SectionKind},
    scene::Document,
};

pub fn from_bytes(data: &[u8]) -> Document {
    project(dwgfile::read(data))
}

pub fn project(file: dwgfile::File) -> Document {
    let version = file.version.as_ref().map(|version| version.code.clone());
    let mut document = Document::new(version, file.byte_length);
    document.meta.source_stats.section_count = file.sections.len();

    let Some(version) = file.version.as_ref() else {
        document.add_diagnostic(
            "error",
            "unsupported_header",
            "Input does not start with a recognized DWG version header.",
        );
        return document;
    };

    if !dwgfile::is_target_version(version) {
        document.add_diagnostic(
            "warning",
            "unsupported_version",
            format!(
                "DWG version {} is outside the AC1015-AC1032 target range.",
                version.code
            ),
        );
    }

    if file.security.data_encrypted || file.security.properties_encrypted {
        document.add_diagnostic(
            "error",
            "encrypted_dwg",
            "Password-protected or encrypted DWG data is not supported by the Rust parser.",
        );
        return document;
    }

    match file.layout {
        LayoutKind::R2004PageMap | LayoutKind::R2007Pages => {
            project_paged_layout(&mut document, &file);
        }
        LayoutKind::LegacySections => project_legacy_layout(&mut document, &file),
        LayoutKind::Unknown => document.add_diagnostic(
            "error",
            "unknown_dwg_layout",
            "The DWG file layout could not be classified.",
        ),
    }

    document
}

pub fn project_entities(
    version: impl Into<String>,
    byte_length: usize,
    entities: &[crate::entities::Entity],
) -> Document {
    let mut document = Document::new(Some(version.into()), byte_length);
    for entity in entities {
        for item in entity.scene_items() {
            document.add_item("model", item);
        }
    }
    document.meta.source_stats.object_count = entities.len();

    document
}

fn project_paged_layout(document: &mut Document, file: &dwgfile::File) {
    let Some(page_map) = file.section_page_map else {
        document.add_diagnostic(
            "error",
            "section_page_map_missing",
            "DWG header indicates a paged section layout, but the page-map pointer is invalid or undecoded.",
        );
        return;
    };

    let (level, code) = if page_map.header_decoded || page_map.sentinel_present {
        ("info", "section_page_map_detected")
    } else {
        ("warning", "section_page_map_sentinel_missing")
    };
    document.add_diagnostic(
        level,
        code,
        format!(
            "Detected compressed section page map at byte {} with {} candidate bytes.",
            page_map.offset, page_map.compressed_bytes
        ),
    );

    if let Some(error) = &file.section_error {
        document.add_diagnostic(
            "warning",
            "section_reconstruction_failed",
            format!("Compressed section page reconstruction failed: {error}"),
        );
    }

    if file.sections.is_empty() {
        let (code, message) = if file.layout == LayoutKind::R2007Pages {
            (
                "r2007_reed_solomon_missing",
                "AC1021/R2007 section reconstruction still needs Reed-Solomon system/data page decoding before object streams can be reached.",
            )
        } else {
            (
                "section_page_decompressor_missing",
                "Compressed section page reconstruction did not produce DWG sections, so object streams cannot be reached for this DWG version.",
            )
        };
        document.add_diagnostic("warning", code, message);
        return;
    }

    document.add_diagnostic(
        "info",
        "sections_reconstructed",
        format!(
            "Reconstructed {} compressed DWG sections.",
            file.sections.len()
        ),
    );
    project_section_streams(
        document,
        file,
        dwgfile::section_by_kind(file, SectionKind::Objects),
    );
}

fn project_legacy_layout(document: &mut Document, file: &dwgfile::File) {
    if file.sections.is_empty() {
        document.add_diagnostic(
            "warning",
            "legacy_section_directory_missing",
            "Legacy DWG section locator records were not found or were invalid.",
        );
        return;
    }

    // Legacy object data is not a named locator section. It occupies the range
    // immediately before the object map, bounded below by the latest prior
    // locator section.
    let object_data = find_legacy_object_data(file);
    project_section_streams(document, file, object_data.as_ref());
}

fn project_section_streams(
    document: &mut Document,
    file: &dwgfile::File,
    object_data: Option<&dwgfile::Section>,
) {
    let Some(object_map) = dwgfile::section_by_kind(file, SectionKind::ObjectMap)
        .filter(|section| !section.data.is_empty())
    else {
        document.add_diagnostic(
            "warning",
            "object_map_missing",
            "DWG sections were decoded, but the object handle map section is missing.",
        );
        return;
    };

    let entries = match crate::objects::decode_object_map(&object_map.data) {
        Ok(entries) => entries,
        Err(error) => {
            document.add_diagnostic(
                "warning",
                "object_map_decode_failed",
                format!("DWG object map decoding failed: {error}"),
            );
            return;
        }
    };
    document.meta.source_stats.object_count = entries.len();
    document.add_diagnostic(
        "info",
        "object_map_decoded",
        format!("Decoded {} DWG object-map entries.", entries.len()),
    );

    let Some(object_data) = object_data.filter(|section| !section.data.is_empty()) else {
        document.add_diagnostic(
            "warning",
            "object_data_missing",
            "Object map was decoded, but the object data section is not available.",
        );
        return;
    };

    let raw_objects = crate::objects::slice_raw_objects(&object_data.data, &entries);
    if raw_objects.is_empty() {
        document.add_diagnostic(
            "warning",
            "object_records_empty",
            "Object map entries did not point to any object records inside the object data section.",
        );
        return;
    }
    document.meta.source_stats.object_count = raw_objects.len();

    let version_code = file
        .version
        .as_ref()
        .map(|version| version.code.as_str())
        .unwrap_or_default();
    let decoded = crate::entities::decode_raw_objects(&raw_objects, version_code);

    for entity in &decoded.entities {
        for item in entity.scene_items() {
            document.add_item("model", item);
        }
    }

    let graph = blocks::ObjectGraph::build(&raw_objects, version_code);
    let expanded = blocks::project_expanded_inserts(document, &graph, version_code);
    if expanded > 0 {
        document.add_object_diagnostic(
            "info",
            "block_inserts_expanded",
            "Expanded decodable DWG INSERT block instances.",
            expanded,
            "INSERT",
        );
    }

    for (object_type, count) in decoded.unsupported {
        document.add_object_diagnostic(
            "warning",
            "unsupported_entity",
            "Skipped unsupported DWG entity objects.",
            count,
            object_type,
        );
    }
    for (object_type, count) in decoded.failures {
        document.add_object_diagnostic(
            "warning",
            "entity_decode_failed",
            "Failed to decode DWG entity objects.",
            count,
            object_type,
        );
    }
    if decoded.entities.is_empty() {
        document.add_diagnostic(
            "warning",
            "no_supported_entities_decoded",
            format!(
                "Located {} raw DWG object records, but no supported entity bodies were decoded.",
                raw_objects.len()
            ),
        );
    }
}

fn find_legacy_object_data(file: &dwgfile::File) -> Option<dwgfile::Section> {
    let object_map = dwgfile::section_by_kind(file, SectionKind::ObjectMap)?;
    if object_map.offset == 0 {
        return None;
    }

    let start = file
        .sections
        .iter()
        .filter(|section| section.kind != SectionKind::ObjectMap)
        .filter_map(|section| section.offset.checked_add(section.size))
        .filter(|end| *end <= object_map.offset)
        .max()?;
    if start == 0 || start >= object_map.offset || object_map.offset > file.data.len() {
        return None;
    }

    Some(dwgfile::Section {
        number: -1,
        name: "legacy object data".to_owned(),
        kind: SectionKind::Unknown,
        offset: start,
        size: object_map.offset - start,
        compressed: false,
        encrypted: false,
        page_count: 0,
        data: file.data[start..object_map.offset].to_vec(),
    })
}

#[cfg(test)]
mod tests {
    use super::from_bytes;

    #[test]
    fn recognized_headers_return_the_scene_schema() {
        let document = from_bytes(b"AC1032synthetic input");
        assert_eq!(document.schema, "sortsys-dwg-scene@1");
        assert_eq!(document.meta.version.as_deref(), Some("AC1032"));
    }

    #[test]
    fn invalid_headers_have_a_clear_diagnostic() {
        let document = from_bytes(b"not a DWG");
        assert_eq!(document.diagnostics[0].code, "unsupported_header");
    }
}
