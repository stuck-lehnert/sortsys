//! DWG container classification and logical section extraction.

mod compress;
mod r2004;

pub use compress::decompress_r2004_section;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Version {
    pub code: String,
    pub release: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LayoutKind {
    Unknown,
    LegacySections,
    R2004PageMap,
    R2007Pages,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SectionKind {
    Unknown,
    HeaderVariables,
    Classes,
    ObjectMap,
    SpecialTable,
    Template,
    Objects,
    Header,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SectionPageMap {
    pub offset: usize,
    pub compressed_bytes: usize,
    pub sentinel_present: bool,
    pub header_decoded: bool,
    pub page_map_id: i32,
    pub section_map_id: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct SecurityFlags {
    pub raw: u32,
    pub data_encrypted: bool,
    pub properties_encrypted: bool,
    pub signed: bool,
    pub timestamped: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Section {
    pub number: i32,
    pub name: String,
    pub kind: SectionKind,
    pub offset: usize,
    pub size: usize,
    pub compressed: bool,
    pub encrypted: bool,
    pub page_count: usize,
    pub data: Vec<u8>,
}

impl Section {
    fn empty(number: i32, kind: SectionKind, offset: usize, size: usize) -> Self {
        Self {
            number,
            name: String::new(),
            kind,
            offset,
            size,
            compressed: false,
            encrypted: false,
            page_count: 0,
            data: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct File {
    pub data: Vec<u8>,
    pub byte_length: usize,
    pub version: Option<Version>,
    pub layout: LayoutKind,
    pub security: SecurityFlags,
    pub sections: Vec<Section>,
    pub section_page_map: Option<SectionPageMap>,
    pub section_error: Option<String>,
}

const R2004_PAGE_MAP_SENTINEL: [u8; 16] = [
    0x68, 0x40, 0xf8, 0xf7, 0x92, 0x2a, 0xb5, 0xef, 0x18, 0xdd, 0x0b, 0xf1, 0xf1, 0xbb, 0xe9, 0xeb,
];

pub fn read(data: &[u8]) -> File {
    let mut file = File {
        data: data.to_vec(),
        byte_length: data.len(),
        version: None,
        layout: LayoutKind::Unknown,
        security: SecurityFlags::default(),
        sections: Vec::new(),
        section_page_map: None,
        section_error: None,
    };

    let Some(version) = detect_version(data) else {
        return file;
    };

    file.security = read_security_flags(data);
    file.version = Some(version.clone());

    if uses_r2007_pages(&version) {
        file.layout = LayoutKind::R2007Pages;
        file.section_page_map = detect_r2007_page_map(data);
    } else if uses_r2004_page_map(&version) {
        file.layout = LayoutKind::R2004PageMap;
        file.section_page_map = detect_r2004_page_map(data);

        if let Some(page_map) = file
            .section_page_map
            .filter(|page_map| page_map.header_decoded)
        {
            match r2004::reconstruct_sections(data, page_map) {
                Ok(sections) => file.sections = sections,
                Err(error) => file.section_error = Some(error),
            }
        }
    } else {
        file.layout = LayoutKind::LegacySections;
        file.sections = read_legacy_sections(data);
    }

    file
}

pub fn detect_version(data: &[u8]) -> Option<Version> {
    let code = std::str::from_utf8(data.get(..6)?).ok()?;
    if !code.starts_with("AC") {
        return None;
    }

    let release = match code {
        "AC1009" => "R12",
        "AC1012" => "R13",
        "AC1014" => "R14",
        "AC1015" => "R2000",
        "AC1018" => "R2004",
        "AC1021" => "R2007",
        "AC1024" => "R2010",
        "AC1027" => "R2013",
        "AC1032" => "R2018",
        _ => "unknown",
    };

    Some(Version {
        code: code.into(),
        release: release.into(),
    })
}

pub fn is_target_version(version: &Version) -> bool {
    matches!(
        version.code.as_str(),
        "AC1015" | "AC1018" | "AC1021" | "AC1024" | "AC1027" | "AC1032"
    )
}

pub fn uses_r2004_page_map(version: &Version) -> bool {
    matches!(
        version.code.as_str(),
        "AC1018" | "AC1024" | "AC1027" | "AC1032"
    )
}

pub fn uses_r2007_pages(version: &Version) -> bool {
    version.code == "AC1021"
}

pub fn section_by_kind(file: &File, kind: SectionKind) -> Option<&Section> {
    file.sections.iter().find(|section| section.kind == kind)
}

fn read_security_flags(data: &[u8]) -> SecurityFlags {
    let Some(raw) = read_u32_le(data, 0x18) else {
        return SecurityFlags::default();
    };

    SecurityFlags {
        raw,
        data_encrypted: raw & 0x0001 != 0,
        properties_encrypted: raw & 0x0002 != 0,
        signed: raw & 0x0010 != 0,
        timestamped: raw & 0x0020 != 0,
    }
}

fn read_legacy_sections(data: &[u8]) -> Vec<Section> {
    let Some(count) = read_u32_le(data, 0x15).map(|value| value as usize) else {
        return Vec::new();
    };
    if count > 64 {
        return Vec::new();
    }

    let mut sections = Vec::with_capacity(count);
    let mut record_offset = 0x19_usize;

    for _ in 0..count {
        let Some(record) = data.get(record_offset..record_offset + 9) else {
            break;
        };
        record_offset += 9;

        let number = i32::from(record[0]);
        let offset = u32::from_le_bytes(record[1..5].try_into().expect("length checked")) as usize;
        let size = u32::from_le_bytes(record[5..9].try_into().expect("length checked")) as usize;

        let mut section = Section::empty(number, legacy_section_kind(number), offset, size);
        if let Some(end) = offset.checked_add(size).filter(|end| *end <= data.len()) {
            section.data.extend_from_slice(&data[offset..end]);
        }
        sections.push(section);
    }

    sections
}

fn legacy_section_kind(number: i32) -> SectionKind {
    match number {
        0 => SectionKind::HeaderVariables,
        1 => SectionKind::Classes,
        2 => SectionKind::ObjectMap,
        3 => SectionKind::SpecialTable,
        4 => SectionKind::Template,
        _ => SectionKind::Unknown,
    }
}

fn detect_r2004_page_map(data: &[u8]) -> Option<SectionPageMap> {
    let encrypted_header = data.get(0x80..0xec)?;
    let header = decrypt_r2004_header_data(encrypted_header);

    if !header.starts_with(b"AcFssFcAJMB\0") && !header.starts_with(b"AcFssFcAJMB") {
        return legacy_r2004_page_map_probe(data);
    }

    let raw_address = read_u64_le(&header, 0x54)?;
    let offset = usize::try_from(raw_address).ok()?.checked_add(0x100)?;
    if offset == 0 || offset >= data.len() {
        return legacy_r2004_page_map_probe(data);
    }

    Some(SectionPageMap {
        offset,
        compressed_bytes: data.len() - offset,
        sentinel_present: has_sentinel(data, offset),
        header_decoded: true,
        page_map_id: read_u32_le(&header, 0x50)? as i32,
        section_map_id: read_u32_le(&header, 0x5c)? as i32,
    })
}

fn detect_r2007_page_map(data: &[u8]) -> Option<SectionPageMap> {
    if data.len() < 0x480 {
        return legacy_r2004_page_map_probe(data);
    }

    // AC1021 keeps its real pointer in a Reed-Solomon encoded header page.
    // Until that container is decoded, preserve the conservative legacy probe
    // so diagnostics can still describe known files.
    legacy_r2004_page_map_probe(data)
}

fn legacy_r2004_page_map_probe(data: &[u8]) -> Option<SectionPageMap> {
    let offset = read_u32_le(data, 0x28)? as usize;
    let declared_bytes = read_u32_le(data, 0x2c)? as usize;
    if offset == 0 || offset >= data.len() {
        return None;
    }

    let compressed_bytes = offset
        .checked_add(declared_bytes)
        .filter(|end| *end <= data.len())
        .map(|_| declared_bytes)
        .unwrap_or(data.len() - offset);

    Some(SectionPageMap {
        offset,
        compressed_bytes,
        sentinel_present: has_sentinel(data, offset),
        header_decoded: false,
        page_map_id: 0,
        section_map_id: 0,
    })
}

fn decrypt_r2004_header_data(data: &[u8]) -> Vec<u8> {
    let mut seed = 1_u32;

    data.iter()
        .map(|byte| {
            seed = seed.wrapping_mul(0x343fd).wrapping_add(0x269ec3);
            byte ^ (seed >> 16) as u8
        })
        .collect()
}

fn has_sentinel(data: &[u8], offset: usize) -> bool {
    data.get(offset..offset + R2004_PAGE_MAP_SENTINEL.len())
        == Some(R2004_PAGE_MAP_SENTINEL.as_slice())
}

pub(super) fn read_u32_le(data: &[u8], offset: usize) -> Option<u32> {
    Some(u32::from_le_bytes(
        data.get(offset..offset + 4)?.try_into().ok()?,
    ))
}

pub(super) fn read_u64_le(data: &[u8], offset: usize) -> Option<u64> {
    Some(u64::from_le_bytes(
        data.get(offset..offset + 8)?.try_into().ok()?,
    ))
}

#[cfg(test)]
mod tests {
    use super::{
        LayoutKind, SectionKind, detect_version, read, uses_r2004_page_map, uses_r2007_pages,
    };

    #[test]
    fn detects_known_and_future_version_headers() {
        let version = detect_version(b"AC1032rest").unwrap();
        assert_eq!(version.release, "R2018");

        let unknown = detect_version(b"AC9999rest").unwrap();
        assert_eq!(unknown.release, "unknown");
        assert!(detect_version(b"not-dwg").is_none());
    }

    #[test]
    fn classifies_paged_version_families() {
        let r2007 = detect_version(b"AC1021").unwrap();
        let r2018 = detect_version(b"AC1032").unwrap();
        assert!(uses_r2007_pages(&r2007));
        assert!(!uses_r2004_page_map(&r2007));
        assert!(uses_r2004_page_map(&r2018));
    }

    #[test]
    fn reads_legacy_section_directory() {
        let mut data = vec![0_u8; 96];
        data[..6].copy_from_slice(b"AC1015");
        data[0x15..0x19].copy_from_slice(&1_u32.to_le_bytes());
        data[0x19] = 2;
        data[0x1a..0x1e].copy_from_slice(&64_u32.to_le_bytes());
        data[0x1e..0x22].copy_from_slice(&4_u32.to_le_bytes());
        data[64..68].copy_from_slice(b"map!");

        let file = read(&data);
        assert_eq!(file.layout, LayoutKind::LegacySections);
        assert_eq!(file.sections[0].kind, SectionKind::ObjectMap);
        assert_eq!(file.sections[0].data, b"map!");
    }
}
