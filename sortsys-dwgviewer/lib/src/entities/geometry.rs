//! Primitive geometry and text payload decoders.
//!
//! These functions start exactly at an entity's payload. Object headers,
//! display properties, and version-specific offset probing live in sibling
//! modules so the geometry layouts remain easy to compare with the DWG spec.

use std::f64::consts::PI;

use crate::{
    bits::{BitCursor, ParseError, ParseResult},
    objects::ObjectType,
    scene::Point,
};

use super::common::{
    ObjectStringStream, is_r2000_or_later, is_r2004_or_later, is_r2007_or_later, is_r2013_or_later,
    read_bit_long_count, read_variable_text, unsupported_entity,
};
use super::{Common, Entity, Insert};

const MAX_COORDINATE: f64 = 1.0e8;
const MAX_LW_POLYLINE_POINTS: usize = 1_000_000;
const MAX_SPLINE_POINTS: usize = 100_000;
const MAX_SPLINE_KNOTS: usize = 200_000;

pub(super) fn decode_insert(
    cursor: &mut BitCursor<'_>,
    common: Common,
    object_type: ObjectType,
    version_code: &str,
) -> ParseResult<Insert> {
    let position = cursor.read_3bd()?;
    let (scale_x, scale_y) = if is_r2000_or_later(version_code) {
        match cursor.read_bits(2)? {
            0 => {
                let x = cursor.read_raw_f64_le()?;
                let y = cursor.read_bit_double_default(x)?;
                cursor.read_bit_double_default(x)?;
                (x, y)
            }
            1 => {
                let y = cursor.read_bit_double_default(1.0)?;
                cursor.read_bit_double_default(1.0)?;
                (1.0, y)
            }
            2 => {
                let scale = cursor.read_raw_f64_le()?;
                (scale, scale)
            }
            3 => (1.0, 1.0),
            _ => unreachable!("two bits cannot exceed three"),
        }
    } else {
        let x = cursor.read_bit_double()?;
        let y = cursor.read_bit_double()?;
        cursor.read_bit_double()?;
        (x, y)
    };

    let rotation = cursor.read_bit_double()?;
    cursor.read_bit_extrusion()?;
    cursor.read_bit()?;

    if is_r2004_or_later(version_code) {
        cursor.read_bit_long()?;
    }
    if object_type == ObjectType::M_INSERT {
        cursor.read_bit_short()?;
        cursor.read_bit_short()?;
        cursor.read_bit_double()?;
        cursor.read_bit_double()?;
    }

    Ok(Insert {
        common,
        position: point2(position),
        scale_x,
        scale_y,
        rotation,
        block_handle: 0,
    })
}

pub(super) fn decode_text_like(
    cursor: &mut BitCursor<'_>,
    stream: Option<&mut ObjectStringStream<'_>>,
    common: Common,
    version_code: &str,
) -> ParseResult<Entity> {
    if !is_r2000_or_later(version_code) {
        return Err(unsupported_entity());
    }

    let flags = cursor.read_raw_u8()?;
    if flags & 0x01 == 0 {
        cursor.read_raw_f64_le()?;
    }

    let insertion = read_raw_2d_point(cursor)?;
    if flags & 0x02 == 0 {
        cursor.read_bit_double_default(insertion.x)?;
        cursor.read_bit_double_default(insertion.y)?;
    }

    cursor.read_bit_extrusion()?;
    cursor.read_bit_thickness()?;
    if flags & 0x04 == 0 {
        cursor.read_raw_f64_le()?;
    }

    let rotation = if flags & 0x08 == 0 {
        cursor.read_raw_f64_le()?
    } else {
        0.0
    };
    let height = cursor.read_raw_f64_le()?;

    if flags & 0x10 == 0 {
        cursor.read_raw_f64_le()?;
    }

    let value = read_variable_text(cursor, stream, version_code)?;
    if flags & 0x20 == 0 {
        cursor.read_bit_short()?;
    }
    if flags & 0x40 == 0 {
        cursor.read_bit_short()?;
    }
    if flags & 0x80 == 0 {
        cursor.read_bit_short()?;
    }

    text_entity(common, insertion, value, height, rotation)
}

pub(super) fn decode_mtext(
    cursor: &mut BitCursor<'_>,
    stream: Option<&mut ObjectStringStream<'_>>,
    common: Common,
    version_code: &str,
) -> ParseResult<Entity> {
    let insertion = cursor.read_3bd()?;
    cursor.read_3bd()?;
    let x_axis = cursor.read_3bd()?;
    cursor.read_bit_double()?;
    cursor.read_bit_double()?;
    let height = cursor.read_bit_double()?;
    cursor.read_bit_short()?;
    cursor.read_bit_short()?;

    if is_r2007_or_later(version_code) {
        cursor.read_bit_double()?;
        cursor.read_bit_double()?;
    }

    let value = read_variable_text(cursor, stream, version_code)?;
    let rotation = x_axis[1].atan2(x_axis[0]);

    text_entity(common, point2(insertion), value, height, rotation)
}

fn text_entity(
    common: Common,
    position: Point,
    value: String,
    height: f64,
    rotation: f64,
) -> ParseResult<Entity> {
    if !reasonable_point(position)
        || !height.is_finite()
        || !(1.0e-6..=1.0e6).contains(&height)
        || !rotation.is_finite()
    {
        return Err(ParseError::InvalidCode);
    }

    let near_origin = position.x.abs() < 1.0e-6 && position.y.abs() <= 1.000_001;
    let default_metric = height <= 1.000_001 || height > 1_000.0;
    if near_origin && default_metric {
        return Err(ParseError::InvalidCode);
    }
    if value.is_empty() {
        return Err(unsupported_entity());
    }

    Ok(Entity::Text {
        common,
        position,
        value,
        height: Some(height),
        rotation: (rotation != 0.0).then_some(rotation),
    })
}

pub(super) fn decode_line(cursor: &mut BitCursor<'_>, common: Common) -> ParseResult<Entity> {
    let z_is_zero = cursor.read_bit()?;
    let start_x = cursor.read_raw_f64_le()?;
    let end_x = cursor.read_bit_double_default(start_x)?;
    let start_y = cursor.read_raw_f64_le()?;
    let end_y = cursor.read_bit_double_default(start_y)?;

    if !z_is_zero {
        cursor.read_raw_f64_le()?;
        cursor.read_bit_double_default(0.0)?;
    }

    cursor.read_bit_thickness()?;
    cursor.read_bit_extrusion()?;

    Ok(Entity::Line {
        common,
        start: Point::new(start_x, start_y),
        end: Point::new(end_x, end_y),
    })
}

pub(super) fn decode_lw_polyline(
    cursor: &mut BitCursor<'_>,
    common: Common,
) -> ParseResult<Entity> {
    let flags = cursor.read_bit_short()? as u16;
    let mut elevation = 0.0;
    let mut normal = [0.0, 0.0, 1.0];

    if flags & 4 != 0 {
        cursor.read_bit_double()?;
    }
    if flags & 8 != 0 {
        elevation = cursor.read_bit_double()?;
    }
    if flags & 2 != 0 {
        cursor.read_bit_double()?;
    }
    if flags & 1 != 0 {
        normal = cursor.read_3bd()?;
    }

    let point_count = read_bit_long_count(cursor, MAX_LW_POLYLINE_POINTS)?;
    if point_count < 2 {
        return Err(ParseError::InvalidCode);
    }

    let bulge_count = if flags & 16 != 0 {
        read_bit_long_count(cursor, point_count)?
    } else {
        0
    };
    let vertex_id_count = if flags & 1024 != 0 {
        read_bit_long_count(cursor, point_count)?
    } else {
        0
    };
    let width_count = if flags & 32 != 0 {
        read_bit_long_count(cursor, point_count)?
    } else {
        0
    };

    let mut x = cursor.read_raw_f64_le()?;
    let mut y = cursor.read_raw_f64_le()?;
    let mut points = Vec::with_capacity(point_count);
    points.push(Point::new(x, y));

    for _ in 1..point_count {
        x = cursor.read_bit_double_default(x)?;
        y = cursor.read_bit_double_default(y)?;
        points.push(Point::new(x, y));
    }

    let mut bulges = Vec::with_capacity(bulge_count);
    for _ in 0..bulge_count {
        bulges.push(cursor.read_bit_double()?);
    }
    for _ in 0..vertex_id_count {
        cursor.read_bit_long()?;
    }
    for _ in 0..width_count {
        cursor.read_2bd()?;
    }

    let points = project_lw_polyline_ocs(points, elevation, normal)?;
    let closed = flags & 512 != 0;
    let bulges = normalize_lw_polyline_bulges(&bulges, points.len(), closed);

    Ok(Entity::Polyline {
        common,
        points,
        bulges,
        closed,
    })
}

pub(super) fn project_lw_polyline_ocs(
    points: Vec<Point>,
    elevation: f64,
    normal: [f64; 3],
) -> ParseResult<Vec<Point>> {
    if points.is_empty() || normal_is_default_ocs(normal) {
        return Ok(points);
    }
    if !normal.iter().all(|value| value.is_finite()) || !elevation.is_finite() {
        return Err(ParseError::InvalidCode);
    }

    let (nx, ny, nz) =
        normalize_vector3(normal[0], normal[1], normal[2]).ok_or(ParseError::InvalidCode)?;
    let arbitrary_axis = if nx.abs() < 1.0 / 64.0 && ny.abs() < 1.0 / 64.0 {
        (nz, 0.0, -nx)
    } else {
        (-ny, nx, 0.0)
    };
    let (ax, ay, az) = normalize_vector3(arbitrary_axis.0, arbitrary_axis.1, arbitrary_axis.2)
        .ok_or(ParseError::InvalidCode)?;

    let bx = ny * az - nz * ay;
    let by = nz * ax - nx * az;
    points
        .into_iter()
        .map(|point| {
            let projected = Point::new(
                point.x * ax + point.y * bx + elevation * nx,
                point.x * ay + point.y * by + elevation * ny,
            );

            reasonable_point(projected)
                .then_some(projected)
                .ok_or(ParseError::InvalidCode)
        })
        .collect()
}

fn normal_is_default_ocs(normal: [f64; 3]) -> bool {
    normal[0].abs() <= 1.0e-12 && normal[1].abs() <= 1.0e-12 && (normal[2] - 1.0).abs() <= 1.0e-12
}

fn normalize_vector3(x: f64, y: f64, z: f64) -> Option<(f64, f64, f64)> {
    if !x.is_finite() || !y.is_finite() || !z.is_finite() {
        return None;
    }

    let length = (x * x + y * y + z * z).sqrt();
    (length > 1.0e-12).then_some((x / length, y / length, z / length))
}

pub(super) fn normalize_lw_polyline_bulges(
    bulges: &[f64],
    point_count: usize,
    closed: bool,
) -> Vec<f64> {
    if point_count < 2 || !has_non_zero_bulge(bulges) {
        return Vec::new();
    }

    let segment_count = if closed { point_count } else { point_count - 1 };
    let mut normalized = vec![0.0; segment_count];
    for (target, source) in normalized.iter_mut().zip(bulges) {
        if source.is_finite() {
            *target = *source;
        }
    }

    if has_non_zero_bulge(&normalized) {
        normalized
    } else {
        Vec::new()
    }
}

pub(super) fn has_non_zero_bulge(bulges: &[f64]) -> bool {
    bulges
        .iter()
        .any(|bulge| bulge.is_finite() && bulge.abs() > 1.0e-12)
}

#[cfg(test)]
pub(super) fn approximate_bulge_arc(start: Point, end: Point, bulge: f64) -> Option<Vec<Point>> {
    let chord_x = end.x - start.x;
    let chord_y = end.y - start.y;
    let chord = chord_x.hypot(chord_y);
    if chord <= 1.0e-12 {
        return None;
    }

    let sweep = 4.0 * bulge.atan();
    if sweep.abs() <= 1.0e-12 || sweep.abs() >= PI * 2.0 {
        return None;
    }

    let radius = chord / (2.0 * (sweep / 2.0).sin().abs());
    let center_distance = chord / (2.0 * (sweep.abs() / 2.0).tan());
    let middle = Point::new((start.x + end.x) / 2.0, (start.y + end.y) / 2.0);
    let sign = if bulge < 0.0 { -1.0 } else { 1.0 };
    let center = Point::new(
        middle.x - chord_y / chord * center_distance * sign,
        middle.y + chord_x / chord * center_distance * sign,
    );
    let start_angle = (start.y - center.y).atan2(start.x - center.x);
    let end_angle = (end.y - center.y).atan2(end.x - center.x);

    Some(approximate_arc(
        center,
        radius,
        start_angle,
        end_angle,
        bulge > 0.0,
    ))
}

pub(super) fn decode_spline(
    cursor: &mut BitCursor<'_>,
    common: Common,
    version_code: &str,
) -> ParseResult<Entity> {
    let mut scenario = cursor.read_bit_long()?;
    if is_r2013_or_later(version_code) {
        cursor.read_bit_long()?;
        if cursor.read_bit_long()? == 15 {
            scenario = 1;
        }
    }

    let degree = cursor.read_bit_long()?;
    if !(1..=64).contains(&degree) {
        return Err(ParseError::InvalidCode);
    }

    let points = match scenario {
        2 => decode_fit_point_spline(cursor)?,
        1 => decode_control_point_spline(cursor)?,
        _ => return Err(ParseError::InvalidCode),
    };

    spline_points_look_valid(&points)
        .then_some(Entity::Spline { common, points })
        .ok_or(ParseError::InvalidCode)
}

fn decode_fit_point_spline(cursor: &mut BitCursor<'_>) -> ParseResult<Vec<Point>> {
    cursor.read_bit_double()?;
    cursor.read_3bd()?;
    cursor.read_3bd()?;
    let count = read_bit_long_count(cursor, MAX_SPLINE_POINTS)?;

    (0..count).map(|_| cursor.read_3bd().map(point2)).collect()
}

fn decode_control_point_spline(cursor: &mut BitCursor<'_>) -> ParseResult<Vec<Point>> {
    cursor.read_bit()?;
    cursor.read_bit()?;
    cursor.read_bit()?;
    cursor.read_bit_double()?;
    cursor.read_bit_double()?;

    let knot_count = read_bit_long_count(cursor, MAX_SPLINE_KNOTS)?;
    let point_count = read_bit_long_count(cursor, MAX_SPLINE_POINTS)?;
    let weights_present = cursor.read_bit()?;

    for _ in 0..knot_count {
        cursor.read_bit_double()?;
    }

    let mut points = Vec::with_capacity(point_count);
    for _ in 0..point_count {
        points.push(point2(cursor.read_3bd()?));
        if weights_present {
            cursor.read_bit_double()?;
        }
    }

    Ok(points)
}

fn spline_points_look_valid(points: &[Point]) -> bool {
    if !(2..=MAX_SPLINE_POINTS).contains(&points.len()) {
        return false;
    }

    let mut min_x = points[0].x;
    let mut max_x = points[0].x;
    let mut min_y = points[0].y;
    let mut max_y = points[0].y;
    for point in points {
        if !reasonable_point(*point) {
            return false;
        }

        min_x = min_x.min(point.x);
        max_x = max_x.max(point.x);
        min_y = min_y.min(point.y);
        max_y = max_y.max(point.y);
    }

    (max_x - min_x).max(max_y - min_y) >= 1.0e-6
}

pub(super) fn decode_circle(cursor: &mut BitCursor<'_>, common: Common) -> ParseResult<Entity> {
    let center = point2(cursor.read_3bd()?);
    let radius = cursor.read_bit_double()?;
    cursor.read_bit_thickness()?;
    cursor.read_bit_extrusion()?;

    Ok(Entity::Circle {
        common,
        center,
        radius,
    })
}

pub(super) fn decode_arc(cursor: &mut BitCursor<'_>, common: Common) -> ParseResult<Entity> {
    let center = point2(cursor.read_3bd()?);
    let radius = cursor.read_bit_double()?;
    cursor.read_bit_thickness()?;
    cursor.read_bit_extrusion()?;
    let start_angle = cursor.read_bit_double()?;
    let end_angle = cursor.read_bit_double()?;

    Ok(Entity::Arc {
        common,
        center,
        radius,
        start_angle,
        end_angle,
    })
}

pub(super) fn decode_ellipse(cursor: &mut BitCursor<'_>, common: Common) -> ParseResult<Entity> {
    let center = point2(cursor.read_3bd()?);
    let major_axis = cursor.read_3bd()?;
    cursor.read_3bd()?;
    let ratio = cursor.read_bit_double()?;
    let start_angle = cursor.read_bit_double()?;
    let end_angle = cursor.read_bit_double()?;

    let radius_x = major_axis[0].hypot(major_axis[1]);
    if radius_x <= 0.0 || ratio <= 0.0 {
        return Err(ParseError::InvalidCode);
    }

    Ok(Entity::Ellipse {
        common,
        center,
        radius_x,
        radius_y: radius_x * ratio,
        rotation: Some(major_axis[1].atan2(major_axis[0])),
        start_angle: Some(start_angle),
        end_angle: Some(end_angle),
    })
}

pub(super) fn decode_point(cursor: &mut BitCursor<'_>, common: Common) -> ParseResult<Entity> {
    let position = point2(cursor.read_3bd()?);
    cursor.read_bit_thickness()?;
    cursor.read_bit_extrusion()?;
    cursor.read_bit_double()?;

    Ok(Entity::Point { common, position })
}

pub(super) fn decode_solid_trace(
    cursor: &mut BitCursor<'_>,
    common: Common,
) -> ParseResult<Entity> {
    cursor.read_bit_thickness()?;
    let elevation = cursor.read_bit_double()?;

    let mut corners = Vec::with_capacity(4);
    for _ in 0..4 {
        corners.push(read_raw_2d_point(cursor)?);
    }

    let normal = cursor.read_bit_extrusion()?;
    let projected = project_lw_polyline_ocs(corners, elevation, normal)?;
    let boundary = solid_trace_loop(&projected).ok_or(ParseError::InvalidCode)?;

    Ok(Entity::Fill {
        common,
        loops: vec![boundary],
        solid: true,
    })
}

fn solid_trace_loop(corners: &[Point]) -> Option<Vec<Point>> {
    if corners.len() != 4 {
        return None;
    }

    let mut ordered = vec![corners[0], corners[1], corners[3], corners[2]];
    if points_near_equal(ordered[2], ordered[3]) {
        ordered = vec![corners[0], corners[1], corners[2]];
    }

    let mut boundary = Vec::with_capacity(ordered.len() + 1);
    for point in ordered {
        if !reasonable_point(point) {
            return None;
        }
        if boundary
            .last()
            .is_none_or(|last| !points_near_equal(*last, point))
        {
            boundary.push(point);
        }
    }
    if boundary.len() < 3 {
        return None;
    }
    if !points_near_equal(boundary[0], *boundary.last()?) {
        boundary.push(boundary[0]);
    }

    Some(boundary)
}

pub(super) fn read_raw_2d_point(cursor: &mut BitCursor<'_>) -> ParseResult<Point> {
    Ok(Point::new(
        cursor.read_raw_f64_le()?,
        cursor.read_raw_f64_le()?,
    ))
}

pub(super) fn reasonable_point(point: Point) -> bool {
    point.x.is_finite()
        && point.y.is_finite()
        && point.x.abs() <= MAX_COORDINATE
        && point.y.abs() <= MAX_COORDINATE
}

pub(super) fn reasonable_angle(value: f64) -> bool {
    value.is_finite() && value.abs() <= PI * 64.0
}

pub(super) fn reasonable_angle_pair(start: f64, end: f64) -> bool {
    reasonable_angle(start) && reasonable_angle(end) && (end - start).abs() <= PI * 64.0
}

pub(super) fn points_near_equal(left: Point, right: Point) -> bool {
    (left.x - right.x).abs() <= 1.0e-9 && (left.y - right.y).abs() <= 1.0e-9
}

pub(super) fn append_point(points: &mut Vec<Point>, point: Point) {
    if points
        .last()
        .is_none_or(|last| !points_near_equal(*last, point))
    {
        points.push(point);
    }
}

pub(super) fn append_points(points: &mut Vec<Point>, additions: &[Point]) {
    for point in additions {
        append_point(points, *point);
    }
}

pub(super) fn approximate_arc(
    center: Point,
    radius: f64,
    start_angle: f64,
    end_angle: f64,
    counter_clockwise: bool,
) -> Vec<Point> {
    let sweep = normalized_sweep(start_angle, end_angle, counter_clockwise);
    let steps = approximation_steps(sweep);

    (0..=steps)
        .map(|index| {
            let angle = start_angle + sweep * index as f64 / steps as f64;
            Point::new(
                center.x + radius * angle.cos(),
                center.y + radius * angle.sin(),
            )
        })
        .collect()
}

pub(super) fn normalized_sweep(start: f64, end: f64, counter_clockwise: bool) -> f64 {
    let mut sweep = end - start;
    if counter_clockwise {
        while sweep <= 0.0 {
            sweep += PI * 2.0;
        }
    } else {
        while sweep >= 0.0 {
            sweep -= PI * 2.0;
        }
    }

    sweep
}

pub(super) fn approximation_steps(sweep: f64) -> usize {
    ((sweep.abs() / (PI / 16.0)).ceil() as usize).clamp(4, 96)
}

fn point2(point: [f64; 3]) -> Point {
    Point::new(point[0], point[1])
}

#[cfg(test)]
mod tests {
    use crate::scene::Point;

    use super::{approximate_bulge_arc, project_lw_polyline_ocs};

    #[test]
    fn default_ocs_preserves_xy_coordinates() {
        let points = vec![Point::new(1.0, 2.0), Point::new(3.0, 4.0)];

        assert_eq!(
            project_lw_polyline_ocs(points.clone(), 5.0, [0.0, 0.0, 1.0]).unwrap(),
            points
        );
    }

    #[test]
    fn bulge_arc_keeps_both_segment_endpoints() {
        let points =
            approximate_bulge_arc(Point::new(0.0, 0.0), Point::new(2.0, 0.0), 1.0).unwrap();

        assert!(points.first().unwrap().x.abs() < 1.0e-9);
        assert!((points.last().unwrap().x - 2.0).abs() < 1.0e-9);
    }
}
