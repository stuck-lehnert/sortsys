//! R2004-family system-page and data-page reconstruction.

use std::collections::BTreeMap;

use super::{
    Section, SectionKind, SectionPageMap, decompress_r2004_section, read_u32_le, read_u64_le,
};

const SYSTEM_PAGE_MAP_TYPE: u32 = 0x4163_0e3b;
const SYSTEM_SECTION_TYPE: u32 = 0x4163_003b;
const DATA_PAGE_TYPE: u32 = 0x4163_043b;
const MAX_LOGICAL_SECTION_BYTES: i64 = 512 * 1024 * 1024;
const ERROR_PREFIX: &str = "R2004 section reconstruction failed";

#[derive(Clone)]
struct GlobalPage {
    offset: usize,
}

#[derive(Clone)]
struct LocalPage {
    page_number: i32,
    data_size: usize,
    start: i64,
}

#[derive(Clone)]
struct SectionDescription {
    size: i64,
    page_count: usize,
    max_page_size: usize,
    compressed: bool,
    section_id: i32,
    encrypted: bool,
    name: String,
    pages: Vec<LocalPage>,
}

#[derive(Clone)]
struct ScannedDataPage {
    offset: usize,
    compressed_size: usize,
    start_offset: i64,
}

pub(super) fn reconstruct_sections(
    data: &[u8],
    page_map: SectionPageMap,
) -> Result<Vec<Section>, String> {
    let map_data = read_system_page(data, page_map.offset, SYSTEM_PAGE_MAP_TYPE)?;
    let global_pages = parse_global_page_map(&map_data)?;

    let section_map_offset = global_pages
        .get(&page_map.section_map_id)
        .map(|page| page.offset)
        .filter(|offset| *offset > 0)
        .map_or_else(|| find_system_page(data, SYSTEM_SECTION_TYPE), Ok)?;

    let section_map_data = read_system_page(data, section_map_offset, SYSTEM_SECTION_TYPE)?;
    let descriptions = parse_section_map(&section_map_data)?;
    let scanned_pages = scan_data_pages(data);

    let mut sections = Vec::with_capacity(descriptions.len());
    for description in descriptions {
        let mut section = Section {
            number: description.section_id,
            name: description.name.clone(),
            kind: section_kind_from_name(&description.name),
            offset: 0,
            size: usize::try_from(description.size).unwrap_or(0),
            compressed: description.compressed,
            encrypted: description.encrypted,
            page_count: description.page_count,
            data: Vec::new(),
        };

        if description.encrypted || !(0..=MAX_LOGICAL_SECTION_BYTES).contains(&description.size) {
            sections.push(section);
            continue;
        }

        let mut pages = resolve_section_pages(&description, &global_pages);
        if pages.is_empty() {
            let candidates = scanned_pages
                .get(&description.section_id)
                .map(Vec::as_slice)
                .unwrap_or_default();
            pages = match_section_pages(&description, candidates);
        }
        if pages.is_empty() {
            sections.push(section);
            continue;
        }

        pages.sort_by_key(|page| (page.start_offset, page.offset));
        let mut buffer = vec![0_u8; description.size as usize];

        for page in pages {
            let mut expected_size = expected_page_size(&description, page.start_offset);
            if description.compressed && description.max_page_size > 0 {
                expected_size = description.max_page_size;
            }

            let (mut page_data, physical_start) = read_data_page(
                data,
                page.offset,
                page.compressed_size,
                description.compressed,
                expected_size,
            )?;
            let page_start = if page.start_offset >= 0 {
                page.start_offset
            } else {
                physical_start
            };
            let start = usize::try_from(page_start).map_err(|_| {
                format!(
                    "{ERROR_PREFIX}: page at {} has negative start {page_start}",
                    page.offset
                )
            })?;
            if start > buffer.len() {
                return Err(format!(
                    "{ERROR_PREFIX}: page at {} start {page_start} is outside section {}",
                    page.offset, description.name
                ));
            }

            page_data.truncate(buffer.len() - start);
            buffer[start..start + page_data.len()].copy_from_slice(&page_data);
        }

        section.data = buffer;
        sections.push(section);
    }

    Ok(sections)
}

fn find_system_page(data: &[u8], expected_type: u32) -> Result<usize, String> {
    for offset in (0x100..data.len().saturating_sub(0x13)).step_by(0x20) {
        if read_u32_le(data, offset) == Some(expected_type) {
            return Ok(offset);
        }
    }

    Err(format!(
        "{ERROR_PREFIX}: system page type {expected_type:#x} was not found"
    ))
}

fn scan_data_pages(data: &[u8]) -> BTreeMap<i32, Vec<ScannedDataPage>> {
    let mut pages: BTreeMap<i32, Vec<ScannedDataPage>> = BTreeMap::new();

    for offset in (0x100..data.len().saturating_sub(0x1f)).step_by(0x20) {
        let header = decrypt_data_page_header(&data[offset..offset + 0x20], offset);
        if read_u32_le(&header, 0) != Some(DATA_PAGE_TYPE) {
            continue;
        }

        let section_id = read_u32_le(&header, 4).unwrap_or_default() as i32;
        let compressed_size = read_u32_le(&header, 8).unwrap_or_default() as usize;
        let physical_size = read_u32_le(&header, 12).unwrap_or_default() as usize;
        let start_offset = read_u32_le(&header, 16).unwrap_or_default() as i32 as i64;
        let payload_fits = offset
            .checked_add(0x20 + compressed_size)
            .is_some_and(|end| end <= data.len());

        if section_id < 0 || compressed_size == 0 || physical_size > 0x20_000 || !payload_fits {
            continue;
        }

        pages.entry(section_id).or_default().push(ScannedDataPage {
            offset,
            compressed_size,
            start_offset,
        });
    }

    pages
}

fn resolve_section_pages(
    description: &SectionDescription,
    global_pages: &BTreeMap<i32, GlobalPage>,
) -> Vec<ScannedDataPage> {
    if description.pages.is_empty() || global_pages.is_empty() {
        return Vec::new();
    }

    let mut pages = Vec::with_capacity(description.pages.len());
    for local in &description.pages {
        let Some(global) = global_pages
            .get(&local.page_number)
            .filter(|global| global.offset > 0)
        else {
            return Vec::new();
        };

        pages.push(ScannedDataPage {
            offset: global.offset,
            compressed_size: local.data_size,
            start_offset: local.start,
        });
    }

    pages
}

fn match_section_pages(
    description: &SectionDescription,
    candidates: &[ScannedDataPage],
) -> Vec<ScannedDataPage> {
    if candidates.is_empty() || description.pages.is_empty() {
        return Vec::new();
    }

    let mut used = vec![false; candidates.len()];
    let mut matches = Vec::with_capacity(description.pages.len());

    for local in &description.pages {
        let wanted_start = local.start.saturating_mul(0x100);
        let mut best = None;

        for (index, candidate) in candidates.iter().enumerate() {
            if used[index] || candidate.compressed_size != local.data_size {
                continue;
            }

            if candidate.start_offset == wanted_start {
                best = Some(index);
                break;
            }
            best.get_or_insert(index);
        }

        if let Some(index) = best {
            used[index] = true;
            matches.push(candidates[index].clone());
        }
    }

    matches
}

fn read_system_page(data: &[u8], offset: usize, expected_type: u32) -> Result<Vec<u8>, String> {
    let header = data
        .get(offset..offset + 0x14)
        .ok_or_else(|| format!("{ERROR_PREFIX}: system page offset {offset} is outside file"))?;

    let page_type = read_u32_le(header, 0).expect("header length checked");
    if page_type != expected_type {
        return Err(format!(
            "{ERROR_PREFIX}: system page at {offset} has type {page_type:#x}, expected {expected_type:#x}"
        ));
    }

    let decompressed_size = read_u32_le(header, 4).unwrap() as usize;
    let compressed_size = read_u32_le(header, 8).unwrap() as usize;
    let compression_type = read_u32_le(header, 12).unwrap();
    let payload_start = offset + 0x14;
    let payload_end = payload_start
        .checked_add(compressed_size)
        .filter(|end| *end <= data.len())
        .ok_or_else(|| format!("{ERROR_PREFIX}: invalid system page sizes at {offset}"))?;
    let payload = &data[payload_start..payload_end];

    if compression_type == 2 {
        return decompress_r2004_section(payload, decompressed_size);
    }
    if decompressed_size > 0 && compressed_size > decompressed_size {
        return Err(format!(
            "{ERROR_PREFIX}: uncompressed system page size mismatch at {offset}"
        ));
    }

    let mut output = vec![0_u8; decompressed_size];
    let count = payload.len().min(output.len());
    output[..count].copy_from_slice(&payload[..count]);
    Ok(output)
}

fn parse_global_page_map(data: &[u8]) -> Result<BTreeMap<i32, GlobalPage>, String> {
    let mut pages = BTreeMap::new();
    let mut offset = 0_usize;
    let mut page_address = 0x100_usize;

    while offset + 8 <= data.len() {
        let id = read_u32_le(data, offset).unwrap() as i32;
        let size = read_u32_le(data, offset + 4).unwrap() as usize;
        offset += 8;

        if id < 0 {
            if offset + 16 > data.len() {
                return Err(format!("{ERROR_PREFIX}: truncated gap record"));
            }
            offset += 16;
        } else if id > 0 {
            pages.insert(
                id,
                GlobalPage {
                    offset: page_address,
                },
            );
        }

        page_address = page_address
            .checked_add(size)
            .ok_or_else(|| format!("{ERROR_PREFIX}: page address overflow"))?;
    }

    Ok(pages)
}

fn parse_section_map(data: &[u8]) -> Result<Vec<SectionDescription>, String> {
    if data.len() < 0x74 {
        return Err(format!("{ERROR_PREFIX}: truncated section map"));
    }

    let count = read_u32_le(data, 0).unwrap() as usize;
    if count > 4096 {
        return Err(format!("{ERROR_PREFIX}: invalid section count {count}"));
    }

    let mut offset = 0x74_usize;
    let mut descriptions = Vec::with_capacity(count);
    for _ in 0..count {
        let Some(header) = data.get(offset..offset + 0x60) else {
            break;
        };
        offset += 0x60;

        let page_count = read_u32_le(header, 8).unwrap() as usize;
        let name = trim_section_name(&header[32..96]);
        if page_count > 1_000_000 {
            return Err(format!("{ERROR_PREFIX}: invalid page count for {name}"));
        }

        let mut description = SectionDescription {
            size: read_u64_le(header, 0).unwrap() as i64,
            page_count,
            max_page_size: read_u32_le(header, 12).unwrap() as usize,
            compressed: read_u32_le(header, 20) == Some(2),
            section_id: read_u32_le(header, 24).unwrap() as i32,
            encrypted: read_u32_le(header, 28) == Some(1),
            name,
            pages: Vec::with_capacity(page_count),
        };

        for _ in 0..page_count {
            let page = data.get(offset..offset + 16).ok_or_else(|| {
                format!(
                    "{ERROR_PREFIX}: truncated local page map for {}",
                    description.name
                )
            })?;
            offset += 16;

            description.pages.push(LocalPage {
                page_number: read_u32_le(page, 0).unwrap() as i32,
                data_size: read_u32_le(page, 4).unwrap() as usize,
                start: read_u64_le(page, 8).unwrap() as i64,
            });
        }

        descriptions.push(description);
    }

    Ok(descriptions)
}

fn expected_page_size(description: &SectionDescription, start: i64) -> usize {
    if start < 0 || start >= description.size {
        return 0;
    }

    let mut end = description.size;
    for local in &description.pages {
        if local.start > start && local.start < end {
            end = local.start;
        }
    }

    let mut length = end.saturating_sub(start);
    if end < description.size
        && description.max_page_size > 0
        && length > description.max_page_size as i64
    {
        length = description.max_page_size as i64;
    }

    usize::try_from(length).unwrap_or(0)
}

fn read_data_page(
    data: &[u8],
    offset: usize,
    local_data_size: usize,
    compressed: bool,
    mut expected_size: usize,
) -> Result<(Vec<u8>, i64), String> {
    let encrypted_header = data
        .get(offset..offset + 0x20)
        .ok_or_else(|| format!("{ERROR_PREFIX}: data page offset {offset} is outside file"))?;
    let header = decrypt_data_page_header(encrypted_header, offset);

    let page_type = read_u32_le(&header, 0).unwrap();
    if page_type != DATA_PAGE_TYPE {
        return Err(format!(
            "{ERROR_PREFIX}: data page at {offset} has type {page_type:#x}"
        ));
    }

    let mut compressed_size = read_u32_le(&header, 8).unwrap() as usize;
    let page_start = read_u32_le(&header, 16).unwrap() as i32 as i64;
    if local_data_size > 0 && local_data_size < compressed_size {
        compressed_size = local_data_size;
    }

    let payload_start = offset + 0x20;
    let payload_end = payload_start
        .checked_add(compressed_size)
        .filter(|end| *end <= data.len())
        .ok_or_else(|| format!("{ERROR_PREFIX}: invalid data page sizes at {offset}"))?;
    let payload = &data[payload_start..payload_end];

    if expected_size == 0 {
        expected_size = compressed_size;
    }
    if compressed {
        return decompress_r2004_section(payload, expected_size).map(|output| (output, page_start));
    }

    let mut output = vec![0_u8; expected_size];
    let count = payload.len().min(output.len());
    output[..count].copy_from_slice(&payload[..count]);
    Ok((output, page_start))
}

fn decrypt_data_page_header(data: &[u8], offset: usize) -> Vec<u8> {
    let mut output = data.to_vec();
    let mask = 0x4164_536b_u32 ^ offset as u32;

    for chunk in output.chunks_exact_mut(4) {
        let value = u32::from_le_bytes(chunk.try_into().expect("chunk length")) ^ mask;
        chunk.copy_from_slice(&value.to_le_bytes());
    }

    output
}

fn trim_section_name(data: &[u8]) -> String {
    let end = data
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(data.len());
    String::from_utf8_lossy(&data[..end]).trim().into()
}

fn section_kind_from_name(name: &str) -> SectionKind {
    match name {
        "AcDb:AcDbObjects" => SectionKind::Objects,
        "AcDb:Handles" => SectionKind::ObjectMap,
        "AcDb:Classes" => SectionKind::Classes,
        "AcDb:Header" | "AcDb:AuxHeader" => SectionKind::Header,
        "AcDb:Template" => SectionKind::Template,
        _ => SectionKind::Unknown,
    }
}
