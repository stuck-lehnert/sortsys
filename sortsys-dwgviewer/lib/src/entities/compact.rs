//! Version-specific candidate offsets for DWG layouts seen in real drawings.
//!
//! Autodesk changed several object payload starts without making those starts
//! self-describing. We probe a small, documented candidate set and accept a
//! result only after strict geometry and stream-boundary validation.

use crate::{
    bits::{BitCursor, ParseError, ParseResult},
    objects::ObjectType,
};

use super::common::{
    ObjectStringStream, is_r2010_or_later, read_common_entity_header,
    read_entity_display_properties, unsupported_entity,
};
use super::geometry::{
    decode_arc, decode_circle, decode_ellipse, decode_insert, decode_line, decode_lw_polyline,
    decode_mtext, decode_point, decode_solid_trace, decode_spline, decode_text_like,
    reasonable_angle_pair, reasonable_point,
};
use super::hatch::decode_hatch_body;
use super::{Common, Entity, Insert};

const MAX_COMPACT_TRAILING_BITS: usize = 1_024;
const MAX_POLYLINE_POINTS: usize = 1_000_000;
const MAX_HATCH_PATHS: usize = 100_000;
const MAX_HATCH_POINTS: usize = 100_000;

pub(super) fn decode_r2004_offset_entity(
    body: &[u8],
    object_type: ObjectType,
    fallback_handle: u64,
    version_code: &str,
) -> ParseResult<Entity> {
    if !matches!(version_code, "AC1018" | "AC1021") {
        return Err(ParseError::ShortRead);
    }

    let mut header_cursor = BitCursor::new(body);
    header_cursor.read_object_type(false)?;
    let common = read_common_entity_header(
        &mut header_cursor,
        version_code,
        object_type,
        fallback_handle,
    )?;
    let header_end = header_cursor.bit_offset();

    // Display properties sometimes precede the payload and sometimes follow
    // it in R2004-family files. Retain them only when the candidate offset
    // proves that they were actually before the decoded geometry.
    let (display_common, display_end) =
        match read_entity_display_properties(&mut header_cursor, version_code, common.clone()) {
            Ok(display) => (Some(display), Some(header_cursor.bit_offset())),
            Err(_) => (None, None),
        };

    match object_type {
        ObjectType::TEXT | ObjectType::ATTRIB | ObjectType::ATTDEF | ObjectType::MTEXT => {
            let mut offsets = vec![
                150, 142, 134, 158, 166, 168, 70, 64, 62, 174, 182, 190, 218, 246,
            ];
            if let Some(end) = display_end {
                append_unique_offsets(&mut offsets, [end, end + 8]);
            }

            decode_at_offsets(
                body,
                &offsets,
                |cursor, offset| {
                    let common =
                        common_for_payload(&common, display_common.as_ref(), display_end, offset);

                    match object_type {
                        ObjectType::MTEXT => decode_mtext(cursor, None, common, version_code),
                        _ => decode_text_like(cursor, None, common, version_code),
                    }
                },
                text_looks_valid,
            )
        }
        ObjectType::SPLINE => decode_at_offsets(
            body,
            &[150, 142, 134, 158, 166, 168, 70, 64, 62, 218, 246],
            |cursor, offset| {
                decode_spline(
                    cursor,
                    common_for_payload(&common, display_common.as_ref(), display_end, offset),
                    version_code,
                )
            },
            |_| true,
        ),
        ObjectType::SOLID | ObjectType::TRACE => {
            let mut offsets = vec![header_end + 7];
            append_unique_offsets(&mut offsets, [84, 76, 68]);

            decode_r2004_at_offsets(
                body,
                &offsets,
                |cursor, offset| {
                    decode_solid_trace(
                        cursor,
                        common_for_payload(&common, display_common.as_ref(), display_end, offset),
                    )
                },
                fill_looks_valid,
            )
        }
        ObjectType::HATCH => {
            let dynamic = header_cursor.bit_offset().saturating_sub(2);
            let mut offsets = vec![dynamic];
            append_unique_offsets(&mut offsets, [158]);

            decode_r2004_at_offsets(
                body,
                &offsets,
                |cursor, offset| {
                    decode_hatch_body(
                        cursor,
                        common_for_payload(&common, display_common.as_ref(), display_end, offset),
                        version_code,
                        false,
                    )
                },
                fill_looks_valid,
            )
        }
        ObjectType::LW_POLYLINE => decode_at_offsets(
            body,
            &[150, 142, 70, 168, 158, 64, 62],
            |cursor, offset| {
                decode_lw_polyline(
                    cursor,
                    common_for_payload(&common, display_common.as_ref(), display_end, offset),
                )
            },
            polyline_looks_valid,
        ),
        _ => Err(unsupported_entity()),
    }
}

pub(super) fn decode_r2010_compact_entity(
    body: &[u8],
    handle_stream_bits: usize,
    object_type: ObjectType,
    fallback_handle: u64,
    version_code: &str,
    string_stream: Option<&ObjectStringStream<'_>>,
) -> ParseResult<Entity> {
    if !is_r2010_or_later(version_code) {
        return Err(ParseError::ShortRead);
    }

    let mut header_cursor = BitCursor::new(body);
    header_cursor.read_object_type(true)?;
    let common = read_common_entity_header(
        &mut header_cursor,
        version_code,
        object_type,
        fallback_handle,
    )?;

    if object_type_is_text(object_type) {
        return decode_compact_text(
            body,
            handle_stream_bits,
            string_stream.ok_or(ParseError::ShortRead)?,
            common,
            object_type,
            version_code,
            header_cursor.bit_offset(),
        );
    }
    if object_type == ObjectType::HATCH {
        return decode_compact_hatch(body, handle_stream_bits, common, version_code);
    }

    let (offsets, allowed_trailing) =
        primitive_offsets(object_type, version_code).ok_or_else(unsupported_entity)?;
    decode_compact_at_offsets(
        body,
        handle_stream_bits,
        &offsets,
        allowed_trailing,
        |cursor| decode_primitive(cursor, common.clone(), object_type),
    )
}

pub(super) fn decode_r2010_compact_insert(
    body: &[u8],
    handle_stream_bits: usize,
    common: Common,
    object_type: ObjectType,
    version_code: &str,
) -> ParseResult<Insert> {
    let end_bit = body
        .len()
        .checked_mul(8)
        .and_then(|bits| bits.checked_sub(handle_stream_bits))
        .ok_or(ParseError::ShortRead)?;

    let mut last_error = ParseError::ShortRead;
    for offset in payload_offsets(version_code, &[65, 73, 81, 28, 9, 17, 1]) {
        if offset >= end_bit {
            continue;
        }

        let mut cursor = BitCursor::new(body);
        cursor.seek_bit(offset)?;
        match decode_insert(&mut cursor, common.clone(), object_type, version_code) {
            Ok(insert) if cursor.bit_offset() <= end_bit && end_bit - cursor.bit_offset() <= 16 => {
                return Ok(insert);
            }
            Ok(_) => last_error = ParseError::InvalidCode,
            Err(error) => last_error = error,
        }
    }

    Err(last_error)
}

fn decode_compact_text(
    body: &[u8],
    handle_stream_bits: usize,
    stream: &ObjectStringStream<'_>,
    common: Common,
    object_type: ObjectType,
    version_code: &str,
    minimum_offset: usize,
) -> ParseResult<Entity> {
    let end_bit = body.len() * 8 - handle_stream_bits;
    let mut last_error = ParseError::ShortRead;

    for offset in payload_offsets(version_code, &[81, 89, 73, 65, 93, 97]) {
        if offset < minimum_offset || offset >= end_bit || stream.start_bit() <= offset {
            continue;
        }

        let mut cursor = BitCursor::new(body);
        cursor.seek_bit(offset)?;
        let mut strings = stream.clone();
        let decoded = if object_type == ObjectType::MTEXT {
            decode_mtext(
                &mut cursor,
                Some(&mut strings),
                common.clone(),
                version_code,
            )
        } else {
            decode_text_like(
                &mut cursor,
                Some(&mut strings),
                common.clone(),
                version_code,
            )
        };

        match decoded {
            Ok(entity)
                if cursor.bit_offset() <= stream.start_bit() && text_looks_valid(&entity) =>
            {
                return Ok(entity);
            }
            Ok(_) => last_error = ParseError::InvalidCode,
            Err(error) => last_error = error,
        }
    }

    Err(last_error)
}

fn decode_compact_hatch(
    body: &[u8],
    handle_stream_bits: usize,
    common: Common,
    version_code: &str,
) -> ParseResult<Entity> {
    let offsets = payload_offsets(version_code, &[73, 81, 89, 65, 93]);

    decode_compact_at_offsets(
        body,
        handle_stream_bits,
        &offsets,
        MAX_COMPACT_TRAILING_BITS,
        |cursor| decode_hatch_body(cursor, common.clone(), version_code, true),
    )
}

/// Decodes R2004 candidates whose object header declares the exact end of the
/// entity data. Matching that boundary prevents a plausible-looking payload
/// at the wrong offset from being accepted.
fn decode_r2004_at_offsets<F, V>(
    body: &[u8],
    offsets: &[usize],
    mut decode: F,
    validate: V,
) -> ParseResult<Entity>
where
    F: FnMut(&mut BitCursor<'_>, usize) -> ParseResult<Entity>,
    V: Fn(&Entity) -> bool,
{
    let declared_end = r2004_object_data_end_bit(body);
    let mut last_error = ParseError::ShortRead;

    for &offset in offsets {
        if offset >= body.len() * 8 {
            continue;
        }

        let mut cursor = BitCursor::new(body);
        cursor.seek_bit(offset)?;

        match decode(&mut cursor, offset) {
            Ok(entity)
                if cursor.bit_offset() <= body.len() * 8
                    && declared_end.is_none_or(|end| cursor.bit_offset() == end)
                    && validate(&entity) =>
            {
                return Ok(entity);
            }
            Ok(_) => last_error = ParseError::InvalidCode,
            Err(error) => last_error = error,
        }
    }

    Err(last_error)
}

fn r2004_object_data_end_bit(body: &[u8]) -> Option<usize> {
    let mut cursor = BitCursor::new(body);
    cursor.read_object_type(false).ok()?;

    let end = usize::try_from(cursor.read_raw_u32_le().ok()?).ok()?;
    (end != 0 && end <= body.len() * 8).then_some(end)
}

fn decode_compact_at_offsets<F>(
    body: &[u8],
    handle_stream_bits: usize,
    offsets: &[usize],
    allowed_trailing: usize,
    mut decode: F,
) -> ParseResult<Entity>
where
    F: FnMut(&mut BitCursor<'_>) -> ParseResult<Entity>,
{
    let end_bit = body
        .len()
        .checked_mul(8)
        .and_then(|bits| bits.checked_sub(handle_stream_bits))
        .ok_or(ParseError::ShortRead)?;
    let mut last_error = ParseError::ShortRead;

    for &offset in offsets {
        if offset >= end_bit {
            continue;
        }

        let mut cursor = BitCursor::new(body);
        cursor.seek_bit(offset)?;
        match decode(&mut cursor) {
            Ok(entity) if cursor.bit_offset() <= end_bit && compact_entity_looks_valid(&entity) => {
                let trailing = end_bit - cursor.bit_offset();
                if trailing <= allowed_trailing || trailing <= MAX_COMPACT_TRAILING_BITS {
                    return Ok(entity);
                }
                last_error = ParseError::InvalidCode;
            }
            Ok(_) => last_error = ParseError::InvalidCode,
            Err(error) => last_error = error,
        }
    }

    Err(last_error)
}

fn decode_at_offsets<F, V>(
    body: &[u8],
    offsets: &[usize],
    mut decode: F,
    validate: V,
) -> ParseResult<Entity>
where
    F: FnMut(&mut BitCursor<'_>, usize) -> ParseResult<Entity>,
    V: Fn(&Entity) -> bool,
{
    let mut last_error = ParseError::ShortRead;
    for &offset in offsets {
        if offset >= body.len() * 8 {
            continue;
        }

        let mut cursor = BitCursor::new(body);
        cursor.seek_bit(offset)?;
        match decode(&mut cursor, offset) {
            Ok(entity) if cursor.bit_offset() <= body.len() * 8 && validate(&entity) => {
                return Ok(entity);
            }
            Ok(_) => last_error = ParseError::InvalidCode,
            Err(error) => last_error = error,
        }
    }

    Err(last_error)
}

fn primitive_offsets(object_type: ObjectType, version_code: &str) -> Option<(Vec<usize>, usize)> {
    let (base, trailing): (&[usize], usize) = match object_type {
        ObjectType::LINE => (&[73, 81, 89, 41], 2),
        ObjectType::CIRCLE => (&[81, 89], 8),
        ObjectType::ARC => (&[89, 81], 8),
        ObjectType::POINT => (&[81, 89], 8),
        ObjectType::ELLIPSE => (&[81, 89], 8),
        ObjectType::LW_POLYLINE => (&[73, 89, 71, 33, 29], 8),
        _ => return None,
    };

    let mut offsets = payload_offsets(version_code, base);
    if version_code == "AC1032" {
        let observed: &[usize] = match object_type {
            ObjectType::LINE => &[132, 196, 146, 252, 80],
            ObjectType::LW_POLYLINE => &[82, 146, 154, 128, 252, 98, 162, 170],
            _ => &[],
        };
        let mut preferred = observed.to_vec();
        append_unique_offsets(&mut preferred, offsets);
        offsets = preferred;
    }

    Some((offsets, trailing))
}

fn payload_offsets(version_code: &str, base: &[usize]) -> Vec<usize> {
    if !matches!(version_code, "AC1027" | "AC1032") {
        return base.to_vec();
    }

    let mut offsets: Vec<usize> = base.iter().map(|offset| offset + 1).collect();
    append_unique_offsets(&mut offsets, base.iter().copied());
    offsets
}

fn append_unique_offsets(offsets: &mut Vec<usize>, candidates: impl IntoIterator<Item = usize>) {
    for candidate in candidates {
        if !offsets.contains(&candidate) {
            offsets.push(candidate);
        }
    }
}

fn common_for_payload(
    common: &Common,
    display_common: Option<&Common>,
    display_end: Option<usize>,
    payload_offset: usize,
) -> Common {
    let Some(display) = display_common else {
        return common.clone();
    };

    if display.color.is_some()
        || display.color_role.is_some()
        || display_end.is_some_and(|end| end <= payload_offset)
    {
        display.clone()
    } else {
        common.clone()
    }
}

fn decode_primitive(
    cursor: &mut BitCursor<'_>,
    common: Common,
    object_type: ObjectType,
) -> ParseResult<Entity> {
    match object_type {
        ObjectType::LINE => decode_line(cursor, common),
        ObjectType::CIRCLE => decode_circle(cursor, common),
        ObjectType::ARC => decode_arc(cursor, common),
        ObjectType::POINT => decode_point(cursor, common),
        ObjectType::ELLIPSE => decode_ellipse(cursor, common),
        ObjectType::LW_POLYLINE => decode_lw_polyline(cursor, common),
        _ => Err(unsupported_entity()),
    }
}

fn object_type_is_text(object_type: ObjectType) -> bool {
    matches!(
        object_type,
        ObjectType::TEXT | ObjectType::ATTRIB | ObjectType::ATTDEF | ObjectType::MTEXT
    )
}

fn compact_entity_looks_valid(entity: &Entity) -> bool {
    match entity {
        Entity::Line { start, end, .. } => {
            reasonable_point(*start)
                && reasonable_point(*end)
                && (end.x - start.x).hypot(end.y - start.y) >= 1.0e-9
        }
        Entity::Circle { center, radius, .. } => {
            reasonable_point(*center) && radius.is_finite() && (1.0e-9..=1.0e8).contains(radius)
        }
        Entity::Arc {
            center,
            radius,
            start_angle,
            end_angle,
            ..
        } => {
            reasonable_point(*center)
                && radius.is_finite()
                && (1.0e-9..=1.0e8).contains(radius)
                && reasonable_angle_pair(*start_angle, *end_angle)
        }
        Entity::Point { position, .. } => reasonable_point(*position),
        Entity::Ellipse {
            center,
            radius_x,
            radius_y,
            rotation,
            start_angle,
            end_angle,
            ..
        } => {
            reasonable_point(*center)
                && radius_x.is_finite()
                && radius_y.is_finite()
                && (1.0e-9..=1.0e8).contains(radius_x)
                && (1.0e-9..=1.0e8).contains(radius_y)
                && rotation.is_none_or(f64::is_finite)
                && match (start_angle, end_angle) {
                    (None, None) => true,
                    (Some(start), Some(end)) => reasonable_angle_pair(*start, *end),
                    _ => false,
                }
        }
        Entity::Polyline { .. } => polyline_looks_valid(entity),
        Entity::Fill { .. } => fill_looks_valid(entity),
        _ => false,
    }
}

fn text_looks_valid(entity: &Entity) -> bool {
    matches!(
        entity,
        Entity::Text {
            value,
            height: Some(height),
            position,
            rotation,
            ..
        } if !value.is_empty()
            && reasonable_point(*position)
            && height.is_finite()
            && rotation.is_none_or(f64::is_finite)
    )
}

fn polyline_looks_valid(entity: &Entity) -> bool {
    let Entity::Polyline { points, bulges, .. } = entity else {
        return false;
    };
    if !(2..=MAX_POLYLINE_POINTS).contains(&points.len())
        || !points.iter().all(|point| reasonable_point(*point))
        || !bulges.iter().all(|bulge| bulge.is_finite())
    {
        return false;
    }

    let (min_x, max_x, min_y, max_y) = points.iter().fold(
        (points[0].x, points[0].x, points[0].y, points[0].y),
        |(min_x, max_x, min_y, max_y), point| {
            (
                min_x.min(point.x),
                max_x.max(point.x),
                min_y.min(point.y),
                max_y.max(point.y),
            )
        },
    );

    (max_x - min_x).max(max_y - min_y) >= 1.0e-3
}

fn fill_looks_valid(entity: &Entity) -> bool {
    let Entity::Fill { loops, .. } = entity else {
        return false;
    };
    if loops.is_empty() || loops.len() > MAX_HATCH_PATHS {
        return false;
    }

    let mut total_points = 0;
    for boundary in loops {
        if !(2..=MAX_HATCH_POINTS).contains(&boundary.len())
            || !boundary.iter().all(|point| reasonable_point(*point))
        {
            return false;
        }
        total_points += boundary.len();
        if total_points > MAX_HATCH_POINTS {
            return false;
        }
    }

    true
}

#[cfg(test)]
mod tests {
    use super::{payload_offsets, primitive_offsets};
    use crate::objects::ObjectType;

    #[test]
    fn ac1032_prefers_observed_polyline_and_line_offsets() {
        let (line, _) = primitive_offsets(ObjectType::LINE, "AC1032").unwrap();
        let (polyline, _) = primitive_offsets(ObjectType::LW_POLYLINE, "AC1032").unwrap();

        assert_eq!(line[0], 132);
        assert_eq!(polyline[0], 82);
        assert!(line.contains(&74));
        assert!(polyline.contains(&89));
    }

    #[test]
    fn r2013_payloads_try_shifted_then_unshifted_offsets() {
        assert_eq!(payload_offsets("AC1027", &[73, 81]), vec![74, 82, 73, 81]);
    }
}
