//! Shared object-envelope, display, color, and text-stream decoding.

use crate::{
    bits::{BitCursor, ParseError, ParseResult},
    objects::ObjectType,
};

use super::{Common, common_from_handle};

pub(super) const MAX_TEXT_CHARS: usize = 1 << 20;

pub(super) fn read_common_entity_data(
    cursor: &mut BitCursor<'_>,
    version_code: &str,
    object_type: ObjectType,
    fallback_handle: u64,
) -> ParseResult<Common> {
    let common = read_common_entity_header(cursor, version_code, object_type, fallback_handle)?;

    read_entity_display_properties(cursor, version_code, common)
}

pub(super) fn read_common_entity_header(
    cursor: &mut BitCursor<'_>,
    version_code: &str,
    object_type: ObjectType,
    fallback_handle: u64,
) -> ParseResult<Common> {
    let mut common = common_from_handle(&object_type.fixed_name(), fallback_handle);

    if !is_r2000_or_later(version_code) {
        return Err(unsupported_entity());
    }

    // Before R2010 each entity starts with its declared bit size. R2010 moved
    // that value into the enclosing object record.
    if !is_r2010_or_later(version_code) {
        cursor.read_raw_u32_le()?;
    }

    let handle = cursor.read_handle_reference()?;
    if handle.value != 0 {
        common.id = format!("{}-{:x}", object_type.fixed_name(), handle.value);
    }

    let eed_size = cursor.read_bit_short()?;
    let eed_size = usize::try_from(eed_size).map_err(|_| ParseError::InvalidCode)?;
    cursor.read_raw_bytes(eed_size)?;

    if cursor.read_bit()? {
        skip_entity_graphics(cursor, version_code)?;
    }

    Ok(common)
}

fn skip_entity_graphics(cursor: &mut BitCursor<'_>, version_code: &str) -> ParseResult<()> {
    let size = if is_r2010_or_later(version_code) {
        usize::try_from(cursor.read_bit_long_long()?).map_err(|_| ParseError::InvalidCode)?
    } else {
        usize::try_from(cursor.read_raw_u32_le()?).map_err(|_| ParseError::InvalidCode)?
    };

    if size > cursor.remaining_bits() / 8 {
        return Err(ParseError::ShortRead);
    }

    cursor.read_raw_bytes(size)?;
    Ok(())
}

pub(super) fn read_entity_display_properties(
    cursor: &mut BitCursor<'_>,
    version_code: &str,
    mut common: Common,
) -> ParseResult<Common> {
    if is_r2004_or_later(version_code) && !is_r2010_or_later(version_code) {
        cursor.read_bits(5)?;
    } else {
        cursor.read_bit()?;
    }

    let (color, color_role) = read_entity_color(cursor, version_code)?;
    common.color = color.or(common.color);
    common.color_role = color_role.or(common.color_role);

    cursor.read_bit_double()?;
    cursor.read_bits(2)?;
    cursor.read_bits(2)?;

    if is_r2007_or_later(version_code) {
        cursor.read_bits(2)?;
        cursor.read_raw_u8()?;
    }
    if is_r2010_or_later(version_code) {
        cursor.read_bits(3)?;
    }

    cursor.read_bit_short()?;
    cursor.read_raw_u8()?;

    Ok(common)
}

pub(super) fn read_entity_color(
    cursor: &mut BitCursor<'_>,
    version_code: &str,
) -> ParseResult<(Option<String>, Option<String>)> {
    let color = cursor.read_bit_short()?;
    if !is_r2004_or_later(version_code) {
        return Ok(aci_color_value(i32::from(color)));
    }

    let raw = color as u16;
    let flags = raw & 0xe000;
    let index = i32::from(raw & 0x01ff);

    let true_color = if flags & 0x8000 != 0 {
        Some(true_color_value(cursor.read_bit_long()? as u32))
    } else {
        None
    };

    // Color-book IDs carry metadata that is irrelevant to rendering, but they
    // still occupy the entity stream and therefore must be consumed.
    if flags & 0x2000 != 0 {
        cursor.read_bit_long()?;
    }

    if let Some(value) = true_color
        && (value.0.is_some() || value.1.is_some())
    {
        return Ok(value);
    }

    if flags & 0x4000 != 0 || index == 0 || index == 256 {
        return Ok((None, None));
    }

    Ok(aci_color_value(index))
}

pub(super) fn true_color_value(raw: u32) -> (Option<String>, Option<String>) {
    let method = raw >> 24;
    let rgb = raw & 0x00ff_ffff;

    if method == 0xc3 && (1..256).contains(&rgb) {
        return aci_color_value(rgb as i32);
    }

    (true_color_hex(raw), None)
}

pub(super) fn true_color_hex(raw: u32) -> Option<String> {
    let method = raw >> 24;
    let rgb = raw & 0x00ff_ffff;

    if method == 0xc3 && (1..256).contains(&rgb) {
        return aci_color_hex(rgb as i32);
    }
    if rgb <= 0xff || matches!(rgb, 0x100 | 0x101) {
        return None;
    }

    Some(format!("#{rgb:06x}"))
}

pub(super) fn aci_color_value(index: i32) -> (Option<String>, Option<String>) {
    if index == 7 {
        return (None, Some("foreground".to_owned()));
    }

    (aci_color_hex(index), None)
}

pub(super) fn aci_color_hex(index: i32) -> Option<String> {
    let basic = match index {
        1 => Some("#ff0000"),
        2 => Some("#ffff00"),
        3 => Some("#00ff00"),
        4 => Some("#00ffff"),
        5 => Some("#0000ff"),
        6 => Some("#ff00ff"),
        8 => Some("#808080"),
        9 => Some("#c0c0c0"),
        _ => None,
    };
    if let Some(color) = basic {
        return Some(color.to_owned());
    }
    if !(10..=249).contains(&index) {
        return None;
    }

    let hue = f64::from((index - 10) / 10) * 15.0;
    let shade = usize::try_from((index - 10) % 10).expect("shade is non-negative");
    let saturation = [1.0, 1.0, 1.0, 1.0, 1.0, 0.55, 0.55, 0.55, 0.25, 0.25][shade];
    let value = [1.0, 0.85, 0.65, 0.5, 0.35, 1.0, 0.75, 0.55, 0.85, 0.65][shade];

    Some(hsv_hex(hue, saturation, value))
}

fn hsv_hex(hue: f64, saturation: f64, value: f64) -> String {
    let chroma = value * saturation;
    let secondary = chroma * (1.0 - ((hue / 60.0) % 2.0 - 1.0).abs());
    let offset = value - chroma;

    let (red, green, blue) = if hue < 60.0 {
        (chroma, secondary, 0.0)
    } else if hue < 120.0 {
        (secondary, chroma, 0.0)
    } else if hue < 180.0 {
        (0.0, chroma, secondary)
    } else if hue < 240.0 {
        (0.0, secondary, chroma)
    } else if hue < 300.0 {
        (secondary, 0.0, chroma)
    } else {
        (chroma, 0.0, secondary)
    };

    format!(
        "#{:02x}{:02x}{:02x}",
        ((red + offset) * 255.0).round() as u8,
        ((green + offset) * 255.0).round() as u8,
        ((blue + offset) * 255.0).round() as u8,
    )
}

#[derive(Debug)]
pub(super) struct ObjectStringStream<'a> {
    body: &'a [u8],
    cursor: BitCursor<'a>,
    start_bit: usize,
    end_bit: usize,
}

impl<'a> ObjectStringStream<'a> {
    pub(super) fn extract(
        body: &'a [u8],
        handle_stream_bits: usize,
        version_code: &str,
    ) -> Option<Self> {
        if !is_r2007_or_later(version_code) {
            return None;
        }

        let pre_handle_end_bit = body.len().checked_mul(8)?.checked_sub(handle_stream_bits)?;
        let present_bit = pre_handle_end_bit.checked_sub(1)?;
        if present_bit >= body.len() * 8 || !read_bit_at(body, present_bit) {
            return None;
        }

        let low_start = present_bit.checked_sub(16)?;
        let low = read_raw_u16_at_bit(body, low_start).ok()?;
        let (stream_end_bit, stream_size_bits) = if low & 0x8000 != 0 {
            let high_start = low_start.checked_sub(16)?;
            let high = read_raw_u16_at_bit(body, high_start).ok()?;

            (
                high_start,
                usize::from(low & 0x7fff) | (usize::from(high) << 15),
            )
        } else {
            (low_start, usize::from(low))
        };

        let stream_start_bit = stream_end_bit.checked_sub(stream_size_bits)?;
        let mut cursor = BitCursor::new(body);
        cursor.seek_bit(stream_start_bit).ok()?;

        Some(Self {
            body,
            cursor,
            start_bit: stream_start_bit,
            end_bit: stream_end_bit,
        })
    }

    pub(super) fn start_bit(&self) -> usize {
        self.start_bit
    }

    pub(super) fn read_unicode_text(&mut self) -> ParseResult<String> {
        let length = self.cursor.read_bit_short()?;
        let length = usize::try_from(length).map_err(|_| ParseError::InvalidCode)?;
        if length > MAX_TEXT_CHARS {
            return Err(ParseError::InvalidCode);
        }

        let byte_length = length.checked_mul(2).ok_or(ParseError::InvalidCode)?;
        let text_end = self
            .cursor
            .bit_offset()
            .checked_add(byte_length * 8)
            .ok_or(ParseError::InvalidCode)?;
        if text_end > self.end_bit {
            return Err(ParseError::ShortRead);
        }

        let raw = self.cursor.read_raw_bytes(byte_length)?;
        let units = raw
            .chunks_exact(2)
            .map(|bytes| u16::from_le_bytes([bytes[0], bytes[1]]));

        let decoded = char::decode_utf16(units)
            .map(|result| result.unwrap_or('\u{fffd}'))
            .collect::<String>();

        Ok(clean_cad_text(&decoded))
    }
}

impl Clone for ObjectStringStream<'_> {
    fn clone(&self) -> Self {
        let mut cursor = BitCursor::new(self.body);
        cursor
            .seek_bit(self.start_bit)
            .expect("stored string-stream offset was already validated");

        Self {
            body: self.body,
            cursor,
            start_bit: self.start_bit,
            end_bit: self.end_bit,
        }
    }
}

fn read_bit_at(data: &[u8], bit: usize) -> bool {
    data[bit / 8] & (0x80 >> (bit % 8)) != 0
}

fn read_raw_u16_at_bit(data: &[u8], bit: usize) -> ParseResult<u16> {
    let mut cursor = BitCursor::new(data);
    cursor.seek_bit(bit)?;

    cursor.read_raw_u16_le()
}

pub(super) fn read_variable_text(
    cursor: &mut BitCursor<'_>,
    stream: Option<&mut ObjectStringStream<'_>>,
    version_code: &str,
) -> ParseResult<String> {
    if is_r2007_or_later(version_code) {
        return stream.ok_or(ParseError::ShortRead)?.read_unicode_text();
    }

    let length = read_bit_short_count(cursor, MAX_TEXT_CHARS)?;
    let raw = cursor.read_raw_bytes(length)?;

    Ok(clean_cad_text(&decode_single_byte_cad_text(&raw)))
}

pub(super) fn decode_single_byte_cad_text(raw: &[u8]) -> String {
    const WINDOWS_1252_CONTROLS: [char; 32] = [
        '\u{20ac}', '\u{0081}', '\u{201a}', '\u{0192}', '\u{201e}', '\u{2026}', '\u{2020}',
        '\u{2021}', '\u{02c6}', '\u{2030}', '\u{0160}', '\u{2039}', '\u{0152}', '\u{008d}',
        '\u{017d}', '\u{008f}', '\u{0090}', '\u{2018}', '\u{2019}', '\u{201c}', '\u{201d}',
        '\u{2022}', '\u{2013}', '\u{2014}', '\u{02dc}', '\u{2122}', '\u{0161}', '\u{203a}',
        '\u{0153}', '\u{009d}', '\u{017e}', '\u{0178}',
    ];

    raw.iter()
        .map(|byte| {
            if (0x80..=0x9f).contains(byte) {
                WINDOWS_1252_CONTROLS[usize::from(*byte - 0x80)]
            } else {
                char::from(*byte)
            }
        })
        .collect()
}

pub(super) fn clean_cad_text(value: &str) -> String {
    strip_mtext_controls(&value.replace('\0', ""))
        .trim()
        .to_owned()
}

fn strip_mtext_controls(value: &str) -> String {
    let characters: Vec<char> = value.chars().collect();
    let mut output = String::with_capacity(value.len());
    let mut index = 0;

    while index < characters.len() {
        let character = characters[index];
        if matches!(character, '{' | '}') {
            index += 1;
            continue;
        }
        if character != '\\' || index + 1 >= characters.len() {
            output.push(character);
            index += 1;
            continue;
        }

        let command = characters[index + 1];
        match command {
            'P' => {
                output.push('\n');
                index += 2;
            }
            '~' => {
                output.push(' ');
                index += 2;
            }
            '\\' | '{' | '}' => {
                output.push(command);
                index += 2;
            }
            _ if mtext_command_consumes_argument(command) => {
                index += 2;
                while index < characters.len() && characters[index] != ';' {
                    index += 1;
                }
                if index < characters.len() {
                    index += 1;
                }
            }
            _ => {
                output.push(command);
                index += 2;
            }
        }
    }

    output
}

fn mtext_command_consumes_argument(command: char) -> bool {
    matches!(
        command,
        'A' | 'a' | 'C' | 'c' | 'F' | 'f' | 'H' | 'h' | 'Q' | 'q' | 'T' | 't' | 'W' | 'w' | 'p'
    )
}

pub(super) fn read_bit_short_count(
    cursor: &mut BitCursor<'_>,
    maximum: usize,
) -> ParseResult<usize> {
    let count = cursor.read_bit_short()?;
    let count = usize::try_from(count).map_err(|_| ParseError::InvalidCode)?;

    (count <= maximum)
        .then_some(count)
        .ok_or(ParseError::InvalidCode)
}

pub(super) fn read_bit_long_count(
    cursor: &mut BitCursor<'_>,
    maximum: usize,
) -> ParseResult<usize> {
    let count = cursor.read_bit_long()?;
    let count = usize::try_from(count).map_err(|_| ParseError::InvalidCode)?;

    (count <= maximum)
        .then_some(count)
        .ok_or(ParseError::InvalidCode)
}

pub(super) fn unsupported_entity() -> ParseError {
    ParseError::UnsupportedEntity
}

pub(super) fn is_r2000_or_later(version_code: &str) -> bool {
    matches!(
        version_code,
        "AC1015" | "AC1018" | "AC1021" | "AC1024" | "AC1027" | "AC1032"
    )
}

pub(super) fn is_r2004_or_later(version_code: &str) -> bool {
    matches!(
        version_code,
        "AC1018" | "AC1021" | "AC1024" | "AC1027" | "AC1032"
    )
}

pub(super) fn is_r2007_or_later(version_code: &str) -> bool {
    matches!(version_code, "AC1021" | "AC1024" | "AC1027" | "AC1032")
}

pub(super) fn is_r2013_or_later(version_code: &str) -> bool {
    matches!(version_code, "AC1027" | "AC1032")
}

pub(super) fn is_r2010_or_later(version_code: &str) -> bool {
    matches!(version_code, "AC1024" | "AC1027" | "AC1032")
}

#[cfg(test)]
mod tests {
    use super::{aci_color_hex, clean_cad_text, decode_single_byte_cad_text, true_color_value};

    #[test]
    fn cleans_cad_text_and_decodes_windows_1252() {
        assert_eq!(clean_cad_text("{\\C1;Room\\Pname}"), "Room\nname");
        assert_eq!(decode_single_byte_cad_text(&[0x80, b' ', 0x97]), "€ —");
    }

    #[test]
    fn maps_aci_and_true_colors() {
        assert_eq!(aci_color_hex(1).as_deref(), Some("#ff0000"));
        assert_eq!(aci_color_hex(7), None);
        assert_eq!(
            true_color_value(0xc300_0007).1.as_deref(),
            Some("foreground")
        );
        assert_eq!(true_color_value(0xc200_ff80).0.as_deref(), Some("#00ff80"));
    }
}
