//! HATCH boundary decoding and curve approximation.

use crate::{
    bits::{BitCursor, ParseError, ParseResult},
    scene::Point,
};

use super::common::{
    MAX_TEXT_CHARS, is_r2004_or_later, is_r2007_or_later, read_bit_long_count,
    read_bit_short_count, unsupported_entity,
};
use super::geometry::{
    append_point, append_points, approximate_arc, approximation_steps, normalized_sweep,
    read_raw_2d_point,
};
use super::{Common, Entity};

const MAX_HATCH_PATHS: usize = 100_000;
const MAX_HATCH_SEGMENTS: usize = 100_000;
const MAX_HATCH_PATTERN_LINES: usize = 10_000;
const MAX_HATCH_DASHES: usize = 10_000;
const MAX_HATCH_BOUNDARY_HANDLES: usize = 100_000;

pub(super) fn decode_hatch(
    cursor: &mut BitCursor<'_>,
    common: Common,
    version_code: &str,
) -> ParseResult<Entity> {
    let start_bit = cursor.bit_offset();
    if is_r2004_or_later(version_code) {
        if let Ok(entity) = decode_hatch_body(cursor, common.clone(), version_code, true) {
            return Ok(entity);
        }

        cursor.seek_bit(start_bit)?;
    }

    decode_hatch_body(cursor, common, version_code, false)
}

pub(super) fn decode_hatch_body(
    cursor: &mut BitCursor<'_>,
    common: Common,
    version_code: &str,
    has_gradient_preamble: bool,
) -> ParseResult<Entity> {
    if has_gradient_preamble {
        skip_hatch_gradient(cursor, version_code)?;
    }

    cursor.read_bit_double()?;
    cursor.read_3bd()?;
    skip_variable_text(cursor, version_code)?;
    let solid_fill = cursor.read_bit()?;
    cursor.read_bit()?;

    let path_count = read_bit_long_count(cursor, MAX_HATCH_PATHS)?;
    let mut loops = Vec::with_capacity(path_count);
    let mut path_flags = Vec::with_capacity(path_count);
    let mut total_boundary_handles = 0_usize;

    for _ in 0..path_count {
        let raw_flags = cursor.read_bit_long()?;
        let flags = u32::try_from(raw_flags).map_err(|_| ParseError::InvalidCode)?;
        path_flags.push(flags);

        let boundary = if flags & 2 != 0 {
            read_polyline_path(cursor)?
        } else {
            read_segment_path(cursor, version_code)?
        };
        if boundary.len() >= 2 {
            loops.push(boundary);
        }

        let handle_count = read_bit_long_count(cursor, MAX_HATCH_BOUNDARY_HANDLES)?;
        total_boundary_handles = total_boundary_handles
            .checked_add(handle_count)
            .filter(|count| *count <= MAX_HATCH_BOUNDARY_HANDLES)
            .ok_or(ParseError::InvalidCode)?;
    }

    cursor.read_bit_short()?;
    cursor.read_bit_short()?;
    if !solid_fill {
        skip_hatch_pattern(cursor)?;
    }
    if path_flags.iter().any(|flags| flags & 4 != 0) {
        cursor.read_bit_double()?;
    }

    let seed_count = read_bit_long_count(cursor, MAX_HATCH_SEGMENTS)?;
    for _ in 0..seed_count {
        read_raw_2d_point(cursor)?;
    }

    if loops.is_empty() {
        return Err(unsupported_entity());
    }

    Ok(Entity::Fill {
        common,
        loops,
        solid: solid_fill,
    })
}

fn skip_hatch_gradient(cursor: &mut BitCursor<'_>, version_code: &str) -> ParseResult<()> {
    cursor.read_bit_long()?;
    cursor.read_bit_long()?;
    cursor.read_bit_double()?;
    cursor.read_bit_double()?;
    cursor.read_bit_long()?;
    cursor.read_bit_double()?;

    let color_count = read_bit_long_count(cursor, 1_024)?;
    for _ in 0..color_count {
        cursor.read_bit_double()?;
        cursor.read_bit_short()?;
        cursor.read_bit_long()?;
        cursor.read_raw_u8()?;
    }

    skip_variable_text(cursor, version_code)
}

fn read_polyline_path(cursor: &mut BitCursor<'_>) -> ParseResult<Vec<Point>> {
    let bulges_present = cursor.read_bit()?;
    let closed = cursor.read_bit()?;
    let point_count = read_bit_long_count(cursor, MAX_HATCH_SEGMENTS)?;
    let mut points = Vec::with_capacity(point_count + usize::from(closed));

    for _ in 0..point_count {
        points.push(read_raw_2d_point(cursor)?);
        if bulges_present {
            cursor.read_bit_double()?;
        }
    }

    if closed && points.len() > 1 && points.first() != points.last() {
        points.push(points[0]);
    }

    Ok(points)
}

fn read_segment_path(cursor: &mut BitCursor<'_>, version_code: &str) -> ParseResult<Vec<Point>> {
    let segment_count = read_bit_long_count(cursor, MAX_HATCH_SEGMENTS)?;
    let mut points = Vec::with_capacity(segment_count + 1);

    for _ in 0..segment_count {
        match cursor.read_raw_u8()? {
            1 => {
                append_point(&mut points, read_raw_2d_point(cursor)?);
                append_point(&mut points, read_raw_2d_point(cursor)?);
            }
            2 => append_points(&mut points, &read_arc(cursor)?),
            3 => append_points(&mut points, &read_ellipse(cursor)?),
            4 => append_points(&mut points, &read_spline(cursor, version_code)?),
            _ => return Err(ParseError::InvalidCode),
        }
    }

    Ok(points)
}

fn read_arc(cursor: &mut BitCursor<'_>) -> ParseResult<Vec<Point>> {
    let center = read_raw_2d_point(cursor)?;
    let radius = cursor.read_bit_double()?;
    let start_angle = cursor.read_bit_double()?;
    let end_angle = cursor.read_bit_double()?;
    let counter_clockwise = cursor.read_bit()?;
    if radius <= 0.0 {
        return Err(ParseError::InvalidCode);
    }

    Ok(approximate_arc(
        center,
        radius,
        start_angle,
        end_angle,
        counter_clockwise,
    ))
}

fn read_ellipse(cursor: &mut BitCursor<'_>) -> ParseResult<Vec<Point>> {
    let center = read_raw_2d_point(cursor)?;
    let major_axis = read_raw_2d_point(cursor)?;
    let ratio = cursor.read_bit_double()?;
    let start_angle = cursor.read_bit_double()?;
    let end_angle = cursor.read_bit_double()?;
    let counter_clockwise = cursor.read_bit()?;

    let radius_x = major_axis.x.hypot(major_axis.y);
    if radius_x <= 0.0 || ratio <= 0.0 {
        return Err(ParseError::InvalidCode);
    }

    Ok(approximate_ellipse(
        center,
        major_axis,
        radius_x,
        radius_x * ratio,
        start_angle,
        end_angle,
        counter_clockwise,
    ))
}

fn read_spline(cursor: &mut BitCursor<'_>, version_code: &str) -> ParseResult<Vec<Point>> {
    read_bit_long_count(cursor, 1_000)?;
    let rational = cursor.read_bit()?;
    cursor.read_bit()?;
    let knot_count = read_bit_long_count(cursor, MAX_HATCH_SEGMENTS)?;
    let point_count = read_bit_long_count(cursor, MAX_HATCH_SEGMENTS)?;

    for _ in 0..knot_count {
        cursor.read_bit_double()?;
    }

    let mut points = Vec::with_capacity(point_count);
    for _ in 0..point_count {
        points.push(read_raw_2d_point(cursor)?);
        if rational {
            cursor.read_bit_double()?;
        }
    }

    // AC1032 adds fit-point metadata after the control points. The viewer uses
    // the control polygon, but consuming this tail keeps the next field aligned.
    if version_code == "AC1032" {
        let fit_point_count = read_bit_long_count(cursor, MAX_HATCH_SEGMENTS)?;
        for _ in 0..fit_point_count {
            read_raw_2d_point(cursor)?;
        }
        read_raw_2d_point(cursor)?;
        read_raw_2d_point(cursor)?;
    }

    Ok(points)
}

fn skip_hatch_pattern(cursor: &mut BitCursor<'_>) -> ParseResult<()> {
    cursor.read_bit_double()?;
    cursor.read_bit_double()?;
    cursor.read_bit()?;

    let line_count = read_bit_short_count(cursor, MAX_HATCH_PATTERN_LINES)?;
    for _ in 0..line_count {
        cursor.read_bit_double()?;
        cursor.read_2bd()?;
        cursor.read_2bd()?;

        let dash_count = read_bit_short_count(cursor, MAX_HATCH_DASHES)?;
        for _ in 0..dash_count {
            cursor.read_bit_double()?;
        }
    }

    Ok(())
}

fn skip_variable_text(cursor: &mut BitCursor<'_>, version_code: &str) -> ParseResult<()> {
    if is_r2007_or_later(version_code) {
        return Ok(());
    }

    let byte_count = read_bit_short_count(cursor, MAX_TEXT_CHARS)?;
    cursor.read_raw_bytes(byte_count)?;
    Ok(())
}

fn approximate_ellipse(
    center: Point,
    major_axis: Point,
    radius_x: f64,
    radius_y: f64,
    start_angle: f64,
    end_angle: f64,
    counter_clockwise: bool,
) -> Vec<Point> {
    let sweep = normalized_sweep(start_angle, end_angle, counter_clockwise);
    let steps = approximation_steps(sweep);
    let rotation = major_axis.y.atan2(major_axis.x);
    let (sin_rotation, cos_rotation) = rotation.sin_cos();

    (0..=steps)
        .map(|index| {
            let angle = start_angle + sweep * index as f64 / steps as f64;
            let x = angle.cos() * radius_x;
            let y = angle.sin() * radius_y;

            Point::new(
                center.x + x * cos_rotation - y * sin_rotation,
                center.y + x * sin_rotation + y * cos_rotation,
            )
        })
        .collect()
}
