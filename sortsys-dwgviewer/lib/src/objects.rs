//! DWG object-map and raw object-record decoding.

use crate::bits::{BitCursor, Cursor, HandleReference, ParseError, ParseResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ObjectType(pub i32);

impl ObjectType {
    pub const TEXT: Self = Self(0x01);
    pub const ATTRIB: Self = Self(0x02);
    pub const ATTDEF: Self = Self(0x03);
    pub const BLOCK: Self = Self(0x04);
    pub const END_BLOCK: Self = Self(0x05);
    pub const SEQ_END: Self = Self(0x06);
    pub const INSERT: Self = Self(0x07);
    pub const M_INSERT: Self = Self(0x08);
    pub const VERTEX_2D: Self = Self(0x0a);
    pub const VERTEX_3D: Self = Self(0x0b);
    pub const POLYLINE_2D: Self = Self(0x0f);
    pub const POLYLINE_3D: Self = Self(0x10);
    pub const ARC: Self = Self(0x11);
    pub const CIRCLE: Self = Self(0x12);
    pub const LINE: Self = Self(0x13);
    pub const POINT: Self = Self(0x1b);
    pub const SOLID: Self = Self(0x1f);
    pub const TRACE: Self = Self(0x20);
    pub const ELLIPSE: Self = Self(0x23);
    pub const SPLINE: Self = Self(0x24);
    pub const REGION: Self = Self(0x25);
    pub const MTEXT: Self = Self(0x2c);
    pub const LEADER: Self = Self(0x2d);
    pub const BLOCK_HEADER: Self = Self(0x31);
    pub const LAYER: Self = Self(0x33);
    pub const LW_POLYLINE: Self = Self(0x4d);
    pub const HATCH: Self = Self(0x4e);
    pub const LAYOUT: Self = Self(0x52);

    pub fn fixed_name(self) -> String {
        match self {
            Self::BLOCK => "BLOCK".into(),
            Self::END_BLOCK => "ENDBLK".into(),
            Self::SEQ_END => "SEQEND".into(),
            Self::TEXT => "TEXT".into(),
            Self::ATTRIB => "ATTRIB".into(),
            Self::ATTDEF => "ATTDEF".into(),
            Self::INSERT => "INSERT".into(),
            Self::M_INSERT => "MINSERT".into(),
            Self::VERTEX_2D => "VERTEX_2D".into(),
            Self::VERTEX_3D => "VERTEX_3D".into(),
            Self::POLYLINE_2D => "POLYLINE_2D".into(),
            Self::POLYLINE_3D => "POLYLINE_3D".into(),
            Self::ARC => "ARC".into(),
            Self::CIRCLE => "CIRCLE".into(),
            Self::LINE => "LINE".into(),
            Self::POINT => "POINT".into(),
            Self::SOLID => "SOLID".into(),
            Self::TRACE => "TRACE".into(),
            Self::ELLIPSE => "ELLIPSE".into(),
            Self::SPLINE => "SPLINE".into(),
            Self::REGION => "REGION".into(),
            Self::MTEXT => "MTEXT".into(),
            Self::LEADER => "LEADER".into(),
            Self::BLOCK_HEADER => "BLOCK_HEADER".into(),
            Self::LAYER => "LAYER".into(),
            Self::LAYOUT => "LAYOUT".into(),
            Self::LW_POLYLINE => "LWPOLYLINE".into(),
            Self::HATCH => "HATCH".into(),
            Self(value) => format!("0x{value:x}"),
        }
    }

    pub fn is_renderable(self) -> bool {
        matches!(
            self,
            Self::TEXT
                | Self::ATTRIB
                | Self::ATTDEF
                | Self::INSERT
                | Self::M_INSERT
                | Self::VERTEX_2D
                | Self::VERTEX_3D
                | Self::POLYLINE_2D
                | Self::POLYLINE_3D
                | Self::ARC
                | Self::CIRCLE
                | Self::LINE
                | Self::POINT
                | Self::SOLID
                | Self::TRACE
                | Self::ELLIPSE
                | Self::SPLINE
                | Self::REGION
                | Self::MTEXT
                | Self::LEADER
                | Self::LW_POLYLINE
                | Self::HATCH
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MapEntry {
    pub handle: u64,
    pub offset: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawObject {
    pub handle: u64,
    pub offset: i64,
    pub data: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawHeader {
    pub object_type: ObjectType,
    pub body: Vec<u8>,
    pub handle_stream_bits: usize,
    pub handle_stream_start_bit: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HandleRef {
    pub code: u8,
    pub count: u8,
    pub raw: u64,
    pub target: u64,
}

pub fn decode_object_map(data: &[u8]) -> ParseResult<Vec<MapEntry>> {
    let mut entries = Vec::new();
    let mut handle = 0_u64;
    let mut cursor = Cursor::new(data);

    while cursor.remaining() > 0 {
        let chunk_size = usize::from(cursor.read_u16_be()?);
        if chunk_size == 2 {
            break;
        }
        if chunk_size < 2 || chunk_size > cursor.remaining() {
            return Err(ParseError::InvalidData(format!(
                "invalid DWG object-map chunk size {chunk_size}"
            )));
        }

        let chunk = cursor.read_bytes(chunk_size)?;
        let mut chunk_cursor = Cursor::new(&chunk[..chunk_size - 2]);

        // Location deltas are local to each object-map chunk. Handles continue
        // across chunks, which is an easy detail to lose in a refactor.
        let mut offset = 0_i64;
        while chunk_cursor.remaining() > 0 {
            let handle_delta = chunk_cursor.read_modular_char_unsigned()?;
            let offset_delta = chunk_cursor.read_modular_char()?;
            if handle_delta == 0 && offset_delta == 0 {
                continue;
            }

            handle = handle.saturating_add(handle_delta);
            offset = offset.saturating_add(offset_delta);
            entries.push(MapEntry { handle, offset });
        }
    }

    Ok(entries)
}

pub fn decode_raw_header(raw: &[u8], version_code: &str) -> ParseResult<RawHeader> {
    let mut cursor = Cursor::new(raw);
    let declared_body_size = usize::try_from(cursor.read_modular_short_unsigned()?)
        .map_err(|_| ParseError::InvalidCode)?;

    let handle_stream_bits = if is_r2010_or_later(version_code) {
        usize::try_from(cursor.read_modular_char_unsigned()?)
            .map_err(|_| ParseError::InvalidCode)?
    } else {
        0
    };

    // Several real drawings contain a conservative size prefix. Keep parsing
    // the available record rather than discarding an otherwise valid object.
    let body_size = if declared_body_size == 0 || declared_body_size > cursor.remaining() {
        cursor.remaining()
    } else {
        declared_body_size
    };
    let body = cursor.read_bytes(body_size)?.to_vec();

    let mut bit_cursor = BitCursor::new(&body);
    let object_type = ObjectType(bit_cursor.read_object_type(is_r2010_or_later(version_code))?);
    let handle_stream_start_bit = body
        .len()
        .checked_mul(8)
        .and_then(|bits| bits.checked_sub(handle_stream_bits))
        .ok_or(ParseError::InvalidCode)?;

    Ok(RawHeader {
        object_type,
        body,
        handle_stream_bits,
        handle_stream_start_bit,
    })
}

pub fn decode_handle_stream(
    raw: &[u8],
    version_code: &str,
    current_handle: u64,
) -> ParseResult<Vec<HandleRef>> {
    let header = decode_raw_header(raw, version_code)?;
    if header.handle_stream_bits == 0 {
        return Ok(Vec::new());
    }

    let mut cursor = BitCursor::new(&header.body);
    cursor.seek_bit(header.handle_stream_start_bit)?;

    let mut references = Vec::new();
    while cursor.remaining_bits() >= 8 {
        let reference = cursor.read_handle_reference()?;
        let target = resolve_handle_reference(current_handle, &reference);
        if target == 0 && reference.code == 0 && reference.count == 0 {
            continue;
        }

        references.push(HandleRef {
            code: reference.code,
            count: reference.count,
            raw: reference.value,
            target,
        });
    }

    Ok(references)
}

pub fn resolve_handle_reference(current_handle: u64, reference: &HandleReference) -> u64 {
    match reference.code {
        2..=5 => reference.value,
        6 => current_handle.saturating_add(1),
        8 => current_handle.saturating_sub(1),
        0x0a => current_handle.saturating_add(reference.value),
        0x0c => current_handle.saturating_sub(reference.value),
        _ => reference.value,
    }
}

pub fn slice_raw_objects(object_data: &[u8], entries: &[MapEntry]) -> Vec<RawObject> {
    let mut ordered = entries.to_vec();
    ordered.sort_by_key(|entry| entry.offset);

    let mut objects = Vec::with_capacity(ordered.len());
    for (index, entry) in ordered.iter().enumerate() {
        let Ok(start) = usize::try_from(entry.offset) else {
            continue;
        };
        if start >= object_data.len() {
            continue;
        }

        let end = ordered
            .get(index + 1)
            .and_then(|next| usize::try_from(next.offset).ok())
            .filter(|end| *end > start && *end <= object_data.len())
            .unwrap_or(object_data.len());

        objects.push(RawObject {
            handle: entry.handle,
            offset: entry.offset,
            data: object_data[start..end].to_vec(),
        });
    }

    objects
}

pub fn is_r2010_or_later(version_code: &str) -> bool {
    matches!(version_code, "AC1024" | "AC1027" | "AC1032")
}

#[cfg(test)]
mod tests {
    use crate::bits::HandleReference;

    use super::{
        MapEntry, ObjectType, decode_handle_stream, decode_object_map, decode_raw_header,
        resolve_handle_reference, slice_raw_objects,
    };

    #[test]
    fn object_map_uses_modular_deltas_and_resets_offsets_per_chunk() {
        // Chunk sizes include the two trailing CRC bytes. Location deltas reset
        // for every chunk, while handle deltas continue across chunks.
        let data = [
            0x00, 0x04, 0x01, 0x05, 0, 0, 0x00, 0x04, 0x01, 0x07, 0, 0, 0x00, 0x02,
        ];

        let entries = decode_object_map(&data).unwrap();
        assert_eq!(
            entries,
            vec![
                MapEntry {
                    handle: 1,
                    offset: 5,
                },
                MapEntry {
                    handle: 2,
                    offset: 7,
                },
            ]
        );
    }

    #[test]
    fn raw_objects_use_ordered_map_offsets() {
        let data = b"abcdefghij";
        let objects = slice_raw_objects(
            data,
            &[
                MapEntry {
                    handle: 2,
                    offset: 6,
                },
                MapEntry {
                    handle: 1,
                    offset: 2,
                },
            ],
        );

        assert_eq!(objects[0].data, b"cdef");
        assert_eq!(objects[1].data, b"ghij");
    }

    #[test]
    fn resolves_relative_handle_modes() {
        let reference = |code, value| HandleReference {
            code,
            count: 1,
            value,
            bytes: vec![value as u8],
        };

        assert_eq!(resolve_handle_reference(100, &reference(6, 0)), 101);
        assert_eq!(resolve_handle_reference(100, &reference(8, 0)), 99);
        assert_eq!(resolve_handle_reference(100, &reference(0x0a, 5)), 105);
        assert_eq!(resolve_handle_reference(100, &reference(0x0c, 5)), 95);
    }
    #[test]
    fn raw_header_separates_entity_data_from_the_handle_stream() {
        let raw = [0x05, 0x00, 0x10, 0x04, 0xc0, 0x00, 0x21, 0x34];

        let header = decode_raw_header(&raw, "AC1024").unwrap();
        assert_eq!(header.object_type, ObjectType::LINE);
        assert_eq!(header.handle_stream_bits, 16);
        assert_eq!(header.handle_stream_start_bit, 24);

        let references = decode_handle_stream(&raw, "AC1024", 0x10).unwrap();
        assert_eq!(references.len(), 1);
        assert_eq!(references[0].code, 2);
        assert_eq!(references[0].raw, 0x34);
        assert_eq!(references[0].target, 0x34);
    }
}
