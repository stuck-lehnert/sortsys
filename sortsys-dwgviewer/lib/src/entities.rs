//! Decoded DWG entities and conversion into scene items.

use std::collections::BTreeMap;

use crate::{
    bits::{BitCursor, ParseError, ParseResult},
    objects::{ObjectType, RawObject, decode_raw_header},
    scene::{Item, Point, StrokeShape},
};
mod common;
mod compact;
mod geometry;
mod hatch;
#[cfg(test)]
mod tests;

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Common {
    pub id: String,
    pub layer_id: Option<String>,
    pub color: Option<String>,
    pub color_role: Option<String>,
    pub line_weight: Option<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Insert {
    pub common: Common,
    pub position: Point,
    pub scale_x: f64,
    pub scale_y: f64,
    pub rotation: f64,
    pub block_handle: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Entity {
    Line {
        common: Common,
        start: Point,
        end: Point,
    },
    Polyline {
        common: Common,
        points: Vec<Point>,
        bulges: Vec<f64>,
        closed: bool,
    },
    Circle {
        common: Common,
        center: Point,
        radius: f64,
    },
    Arc {
        common: Common,
        center: Point,
        radius: f64,
        start_angle: f64,
        end_angle: f64,
    },
    Ellipse {
        common: Common,
        center: Point,
        radius_x: f64,
        radius_y: f64,
        rotation: Option<f64>,
        start_angle: Option<f64>,
        end_angle: Option<f64>,
    },
    Spline {
        common: Common,
        points: Vec<Point>,
    },
    Point {
        common: Common,
        position: Point,
    },
    Insert(Insert),
    Text {
        common: Common,
        position: Point,
        value: String,
        height: Option<f64>,
        rotation: Option<f64>,
    },
    Fill {
        common: Common,
        loops: Vec<Vec<Point>>,
        solid: bool,
    },
    Mask {
        common: Common,
        loops: Vec<Vec<Point>>,
    },
}

impl Entity {
    pub fn scene_items(&self) -> Vec<Item> {
        let (common, kind) = match self {
            Self::Line { common, .. }
            | Self::Polyline { common, .. }
            | Self::Circle { common, .. }
            | Self::Arc { common, .. }
            | Self::Ellipse { common, .. }
            | Self::Spline { common, .. } => (common, "stroke"),
            Self::Point { common, .. } => (common, "point"),
            Self::Insert(_) => return Vec::new(),
            Self::Text { common, .. } => (common, "text"),
            Self::Fill { common, .. } => (common, "fill"),
            Self::Mask { common, .. } => (common, "mask"),
        };

        let mut item = base_item(common, kind);
        match self {
            Self::Line { start, end, .. } => {
                item.shape = Some(StrokeShape::line(*start, *end));
            }
            Self::Polyline {
                points,
                bulges,
                closed,
                ..
            } => {
                item.shape = Some(StrokeShape::polyline(
                    points.clone(),
                    bulges.clone(),
                    *closed,
                ));
            }
            Self::Circle { center, radius, .. } => {
                item.shape = Some(StrokeShape::circle(*center, *radius));
            }
            Self::Arc {
                center,
                radius,
                start_angle,
                end_angle,
                ..
            } => {
                item.shape = Some(StrokeShape::arc(*center, *radius, *start_angle, *end_angle));
            }
            Self::Ellipse {
                center,
                radius_x,
                radius_y,
                rotation,
                start_angle,
                end_angle,
                ..
            } => {
                item.shape = Some(StrokeShape::ellipse(
                    *center,
                    *radius_x,
                    *radius_y,
                    *rotation,
                    *start_angle,
                    *end_angle,
                ));
            }
            Self::Spline { points, .. } => {
                item.shape = Some(StrokeShape::spline(points.clone()));
            }
            Self::Point { position, .. } => item.position = Some(*position),
            Self::Text {
                position,
                value,
                height,
                rotation,
                ..
            } => {
                item.position = Some(*position);
                item.value = Some(value.clone());
                item.height = *height;
                item.rotation = *rotation;
            }
            Self::Fill { loops, solid, .. } => {
                item.loops = loops.clone();
                item.solid = Some(*solid);
            }
            Self::Mask { loops, .. } => item.loops = loops.clone(),
            Self::Insert(_) => unreachable!("insert returned before item construction"),
        }

        vec![item]
    }
}

#[derive(Debug, Default)]
pub struct DecodeResult {
    pub entities: Vec<Entity>,
    pub unsupported: BTreeMap<String, usize>,
    pub failures: BTreeMap<String, usize>,
}

pub fn common_from_handle(prefix: &str, handle: u64) -> Common {
    Common {
        id: format!("{prefix}-{handle:x}"),
        ..Common::default()
    }
}

fn base_item(common: &Common, kind: &str) -> Item {
    let mut item = Item::new(&common.id, kind);
    item.layer_id.clone_from(&common.layer_id);
    item.color.clone_from(&common.color);
    item.color_role.clone_from(&common.color_role);
    item.line_weight = common.line_weight;
    item
}

pub fn decode_raw_objects(raw_objects: &[RawObject], version_code: &str) -> DecodeResult {
    let mut result = DecodeResult::default();

    for raw in raw_objects {
        match decode_raw_object(&raw.data, version_code, raw.handle) {
            Ok((entity, _)) => result.entities.push(entity),
            Err(error) => {
                let object_type = decode_raw_header(&raw.data, version_code)
                    .map(|header| header.object_type)
                    .unwrap_or(ObjectType(-1));
                let name = object_type.fixed_name();
                let counts = if error == ParseError::UnsupportedEntity {
                    &mut result.unsupported
                } else {
                    &mut result.failures
                };

                *counts.entry(name).or_default() += 1;
            }
        }
    }

    result
}

pub fn decode_raw_object(
    raw: &[u8],
    version_code: &str,
    fallback_handle: u64,
) -> ParseResult<(Entity, ObjectType)> {
    let header = decode_raw_header(raw, version_code)?;
    let mut cursor = BitCursor::new(&header.body);
    let object_type = ObjectType(cursor.read_object_type(common::is_r2010_or_later(version_code))?);

    if !object_type.is_renderable() {
        return Err(ParseError::UnsupportedEntity);
    }

    let mut string_stream =
        common::ObjectStringStream::extract(&header.body, header.handle_stream_bits, version_code);

    // R2004 and R2010 introduced payload layouts observed in production files
    // whose starts are not self-describing. Try those strictly validated forms
    // before the canonical sequential layout.
    if common::is_r2004_or_later(version_code)
        && !common::is_r2010_or_later(version_code)
        && let Ok(entity) = compact::decode_r2004_offset_entity(
            &header.body,
            object_type,
            fallback_handle,
            version_code,
        )
    {
        return Ok((entity, object_type));
    }

    if common::is_r2010_or_later(version_code)
        && let Ok(entity) = compact::decode_r2010_compact_entity(
            &header.body,
            header.handle_stream_bits,
            object_type,
            fallback_handle,
            version_code,
            string_stream.as_ref(),
        )
    {
        return Ok((entity, object_type));
    }

    let common =
        common::read_common_entity_data(&mut cursor, version_code, object_type, fallback_handle)?;

    let entity = match object_type {
        ObjectType::LINE => geometry::decode_line(&mut cursor, common),
        ObjectType::CIRCLE => geometry::decode_circle(&mut cursor, common),
        ObjectType::ARC => geometry::decode_arc(&mut cursor, common),
        ObjectType::POINT => geometry::decode_point(&mut cursor, common),
        ObjectType::SOLID | ObjectType::TRACE => geometry::decode_solid_trace(&mut cursor, common),
        ObjectType::ELLIPSE => geometry::decode_ellipse(&mut cursor, common),
        ObjectType::SPLINE => geometry::decode_spline(&mut cursor, common, version_code),
        ObjectType::LW_POLYLINE => geometry::decode_lw_polyline(&mut cursor, common),
        ObjectType::TEXT | ObjectType::ATTRIB | ObjectType::ATTDEF => {
            geometry::decode_text_like(&mut cursor, string_stream.as_mut(), common, version_code)
        }
        ObjectType::MTEXT => {
            geometry::decode_mtext(&mut cursor, string_stream.as_mut(), common, version_code)
        }
        ObjectType::HATCH => hatch::decode_hatch(&mut cursor, common, version_code)
            .map_err(|_| ParseError::UnsupportedEntity),
        _ => Err(ParseError::UnsupportedEntity),
    }?;

    Ok((entity, object_type))
}

pub fn decode_insert(
    raw: &[u8],
    version_code: &str,
    fallback_handle: u64,
    block_handle: u64,
) -> ParseResult<(Insert, ObjectType)> {
    let header = decode_raw_header(raw, version_code)?;
    let mut cursor = BitCursor::new(&header.body);
    let object_type = ObjectType(cursor.read_object_type(common::is_r2010_or_later(version_code))?);

    if !matches!(object_type, ObjectType::INSERT | ObjectType::M_INSERT) {
        return Err(ParseError::UnsupportedEntity);
    }

    let direct_result =
        common::read_common_entity_data(&mut cursor, version_code, object_type, fallback_handle)
            .and_then(|common| {
                geometry::decode_insert(&mut cursor, common, object_type, version_code)
            });

    if let Ok(mut insert) = direct_result {
        insert.block_handle = block_handle;
        return Ok((insert, object_type));
    }

    if common::is_r2010_or_later(version_code) {
        let compact_common = common_from_handle(&object_type.fixed_name(), fallback_handle);
        if let Ok(mut insert) = compact::decode_r2010_compact_insert(
            &header.body,
            header.handle_stream_bits,
            compact_common,
            object_type,
            version_code,
        ) {
            insert.block_handle = block_handle;
            return Ok((insert, object_type));
        }
    }

    Err(direct_result.unwrap_err())
}
