//! Object-reference graph construction and recursive INSERT expansion.

use std::collections::{BTreeMap, BTreeSet};
use std::f64::consts::PI;

use crate::{
    entities::{self, Insert},
    objects::{self, ObjectType, RawObject},
    scene::{Document, Item, Point},
};

const MAX_EXPANDED_ITEMS: usize = 250_000;
const MAX_EXPANSION_DEPTH: usize = 16;

#[derive(Default)]
pub(super) struct ObjectGraph {
    raw_by_handle: BTreeMap<u64, RawObject>,
    type_by_handle: BTreeMap<u64, ObjectType>,
    refs_by_handle: BTreeMap<u64, Vec<u64>>,
}

impl ObjectGraph {
    pub(super) fn build(raw_objects: &[RawObject], version_code: &str) -> Self {
        let mut graph = Self::default();

        for raw in raw_objects {
            graph.raw_by_handle.insert(raw.handle, raw.clone());

            if let Ok(header) = objects::decode_raw_header(&raw.data, version_code) {
                graph.type_by_handle.insert(raw.handle, header.object_type);
            }

            let targets = objects::decode_handle_stream(&raw.data, version_code, raw.handle)
                .unwrap_or_default()
                .into_iter()
                .filter_map(|reference| (reference.target != 0).then_some(reference.target))
                .collect::<Vec<_>>();
            if !targets.is_empty() {
                graph.refs_by_handle.insert(raw.handle, targets);
            }
        }

        graph
    }
}

#[derive(Clone)]
struct Transform {
    insert: Insert,
    handle: u64,
}

pub(super) fn project_expanded_inserts(
    document: &mut Document,
    graph: &ObjectGraph,
    version_code: &str,
) -> usize {
    let blocks = block_definitions(graph);
    let mut cache = BTreeMap::<u64, Vec<Item>>::new();
    let mut expanded = 0;

    let inserts = graph
        .raw_by_handle
        .keys()
        .filter(|handle| is_insert(graph.type_by_handle.get(handle).copied()))
        .copied()
        .collect::<Vec<_>>();

    for handle in inserts {
        if expanded >= MAX_EXPANDED_ITEMS {
            break;
        }

        let block_handle = insert_block_handle(graph, handle);
        let Some(children) = blocks
            .get(&block_handle)
            .filter(|children| !children.is_empty())
        else {
            continue;
        };
        let _ = children;

        let Some(raw) = graph.raw_by_handle.get(&handle) else {
            continue;
        };
        let Ok((insert, _)) =
            entities::decode_insert(&raw.data, version_code, handle, block_handle)
        else {
            continue;
        };
        if !usable_insert(&insert) {
            continue;
        }

        expand_block(
            document,
            graph,
            &blocks,
            &mut cache,
            block_handle,
            &[Transform { insert, handle }],
            version_code,
            0,
            &mut BTreeSet::new(),
            &mut expanded,
        );
    }

    expanded
}

#[allow(clippy::too_many_arguments)]
fn expand_block(
    document: &mut Document,
    graph: &ObjectGraph,
    blocks: &BTreeMap<u64, Vec<u64>>,
    cache: &mut BTreeMap<u64, Vec<Item>>,
    block_handle: u64,
    transforms: &[Transform],
    version_code: &str,
    depth: usize,
    stack: &mut BTreeSet<u64>,
    expanded: &mut usize,
) {
    if *expanded >= MAX_EXPANDED_ITEMS || depth > MAX_EXPANSION_DEPTH || !stack.insert(block_handle)
    {
        return;
    }

    for child_handle in blocks.get(&block_handle).into_iter().flatten() {
        if *expanded >= MAX_EXPANDED_ITEMS {
            break;
        }

        if is_insert(graph.type_by_handle.get(child_handle).copied()) {
            expand_nested_insert(
                document,
                graph,
                blocks,
                cache,
                *child_handle,
                transforms,
                version_code,
                depth,
                stack,
                expanded,
            );
            continue;
        }

        if !cache.contains_key(child_handle) {
            let items = graph
                .raw_by_handle
                .get(child_handle)
                .and_then(|raw| {
                    entities::decode_raw_object(&raw.data, version_code, *child_handle).ok()
                })
                .map(|(entity, _)| entity.scene_items())
                .unwrap_or_default();
            cache.insert(*child_handle, items);
        }

        for item in cache.get(child_handle).cloned().unwrap_or_default() {
            document.add_item("model", transform_through(item, transforms));
            *expanded += 1;

            if *expanded >= MAX_EXPANDED_ITEMS {
                break;
            }
        }
    }

    stack.remove(&block_handle);
}

#[allow(clippy::too_many_arguments)]
fn expand_nested_insert(
    document: &mut Document,
    graph: &ObjectGraph,
    blocks: &BTreeMap<u64, Vec<u64>>,
    cache: &mut BTreeMap<u64, Vec<Item>>,
    insert_handle: u64,
    transforms: &[Transform],
    version_code: &str,
    depth: usize,
    stack: &mut BTreeSet<u64>,
    expanded: &mut usize,
) {
    if depth >= MAX_EXPANSION_DEPTH {
        return;
    }

    let block_handle = insert_block_handle(graph, insert_handle);
    if blocks.get(&block_handle).is_none_or(Vec::is_empty) {
        return;
    }
    let Some(raw) = graph.raw_by_handle.get(&insert_handle) else {
        return;
    };
    let Ok((insert, _)) =
        entities::decode_insert(&raw.data, version_code, insert_handle, block_handle)
    else {
        return;
    };
    if !usable_insert(&insert) {
        return;
    }

    let mut nested = transforms.to_vec();
    nested.push(Transform {
        insert,
        handle: insert_handle,
    });

    expand_block(
        document,
        graph,
        blocks,
        cache,
        block_handle,
        &nested,
        version_code,
        depth + 1,
        stack,
        expanded,
    );
}

fn transform_through(mut item: Item, transforms: &[Transform]) -> Item {
    for transform in transforms.iter().rev() {
        item = transform_scene_item(item, &transform.insert, transform.handle);
    }

    item
}

fn block_definitions(graph: &ObjectGraph) -> BTreeMap<u64, Vec<u64>> {
    let mut blocks = BTreeMap::new();

    for (&handle, &object_type) in &graph.type_by_handle {
        if object_type != ObjectType::BLOCK_HEADER {
            continue;
        }

        let mut inside_block = false;
        for reference in graph.refs_by_handle.get(&handle).into_iter().flatten() {
            let reference_type = graph.type_by_handle.get(reference).copied();
            if reference_type == Some(ObjectType::BLOCK) {
                inside_block = true;
                continue;
            }
            if reference_type == Some(ObjectType::END_BLOCK) {
                break;
            }
            if inside_block && reference_type.is_some_and(expandable_child) {
                blocks
                    .entry(handle)
                    .or_insert_with(Vec::new)
                    .push(*reference);
            }
        }
    }

    blocks
}

fn expandable_child(object_type: ObjectType) -> bool {
    object_type.is_renderable()
        || matches!(
            object_type,
            ObjectType::POLYLINE_2D
                | ObjectType::POLYLINE_3D
                | ObjectType::REGION
                | ObjectType::LEADER
        )
}

fn is_insert(object_type: Option<ObjectType>) -> bool {
    matches!(object_type, Some(ObjectType::INSERT | ObjectType::M_INSERT))
}

fn insert_block_handle(graph: &ObjectGraph, insert_handle: u64) -> u64 {
    graph
        .refs_by_handle
        .get(&insert_handle)
        .into_iter()
        .flatten()
        .find(|reference| graph.type_by_handle.get(reference) == Some(&ObjectType::BLOCK_HEADER))
        .copied()
        .unwrap_or(0)
}

fn usable_insert(insert: &Insert) -> bool {
    insert.position.x.is_finite()
        && insert.position.y.is_finite()
        && insert.scale_x.is_finite()
        && insert.scale_y.is_finite()
        && insert.rotation.is_finite()
        && insert.scale_x.abs() > 1.0e-12
        && insert.scale_y.abs() > 1.0e-12
}

pub(super) fn transform_scene_item(mut item: Item, insert: &Insert, insert_handle: u64) -> Item {
    item.id = format!("INSERT-{insert_handle:x}-{}", item.id);

    if let Some(shape) = &mut item.shape {
        match shape.kind.as_str() {
            "line" => {
                shape.start = shape.start.map(|point| transform_point(point, insert));
                shape.end = shape.end.map(|point| transform_point(point, insert));
            }
            "polyline" | "spline" => {
                if shape.kind == "polyline" && has_bulges(&shape.bulges) {
                    if uniform_scale(insert) {
                        if insert.scale_x * insert.scale_y < 0.0 {
                            shape.bulges.iter_mut().for_each(|bulge| *bulge = -*bulge);
                        }
                    } else {
                        shape.points = flatten_bulges(&shape.points, &shape.bulges, shape.closed);
                        shape.bulges.clear();
                        shape.closed = false;
                    }
                }
                shape.points = transform_points(&shape.points, insert);
            }
            "circle" => {
                shape.center = shape.center.map(|point| transform_point(point, insert));
                if uniform_scale(insert) {
                    shape.radius = shape.radius.map(|radius| radius * insert.scale_x.abs());
                }
            }
            "arc" => {
                shape.center = shape.center.map(|point| transform_point(point, insert));
                if uniform_scale(insert) {
                    shape.radius = shape.radius.map(|radius| radius * insert.scale_x.abs());
                    shape.start_angle = shape.start_angle.map(|angle| angle + insert.rotation);
                    shape.end_angle = shape.end_angle.map(|angle| angle + insert.rotation);
                }
            }
            "ellipse" => {
                shape.center = shape.center.map(|point| transform_point(point, insert));
                shape.radius_x = shape.radius_x.map(|radius| radius * insert.scale_x.abs());
                shape.radius_y = shape.radius_y.map(|radius| radius * insert.scale_y.abs());
                shape.rotation = Some(shape.rotation.unwrap_or_default() + insert.rotation);
            }
            _ => {}
        }
    }

    item.position = item.position.map(|point| transform_point(point, insert));
    item.loops = item
        .loops
        .iter()
        .map(|points| transform_points(points, insert))
        .collect();
    item.rotation = item.rotation.map(|rotation| rotation + insert.rotation);

    item
}

fn has_bulges(bulges: &[f64]) -> bool {
    bulges
        .iter()
        .any(|bulge| bulge.is_finite() && bulge.abs() > 1.0e-12)
}

fn flatten_bulges(points: &[Point], bulges: &[f64], closed: bool) -> Vec<Point> {
    if points.is_empty() || !has_bulges(bulges) {
        return points.to_vec();
    }

    let mut output = vec![points[0]];
    let segment_count = if closed {
        points.len()
    } else {
        points.len() - 1
    };
    for index in 0..segment_count {
        let start = points[index];
        let end = points[(index + 1) % points.len()];
        let bulge = bulges.get(index).copied().unwrap_or_default();

        if let Some(arc) = bulge_arc(start, end, bulge) {
            for point in arc.into_iter().skip(1) {
                append_point(&mut output, point);
            }
        } else {
            append_point(&mut output, end);
        }
    }

    output
}

fn bulge_arc(start: Point, end: Point, bulge: f64) -> Option<Vec<Point>> {
    let chord_x = end.x - start.x;
    let chord_y = end.y - start.y;
    let chord = chord_x.hypot(chord_y);
    if chord <= 1.0e-12 || bulge.abs() <= 1.0e-12 || !bulge.is_finite() {
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
    let steps = ((sweep.abs() / (PI / 16.0)).ceil() as usize).clamp(4, 96);

    Some(
        (0..=steps)
            .map(|index| {
                let angle = start_angle + sweep * index as f64 / steps as f64;
                Point::new(
                    center.x + angle.cos() * radius,
                    center.y + angle.sin() * radius,
                )
            })
            .collect(),
    )
}

fn append_point(points: &mut Vec<Point>, point: Point) {
    if points.last() != Some(&point) {
        points.push(point);
    }
}

fn transform_points(points: &[Point], insert: &Insert) -> Vec<Point> {
    points
        .iter()
        .map(|point| transform_point(*point, insert))
        .collect()
}

fn transform_point(point: Point, insert: &Insert) -> Point {
    let x = point.x * insert.scale_x;
    let y = point.y * insert.scale_y;
    let (sin_rotation, cos_rotation) = insert.rotation.sin_cos();

    Point::new(
        insert.position.x + x * cos_rotation - y * sin_rotation,
        insert.position.y + x * sin_rotation + y * cos_rotation,
    )
}

fn uniform_scale(insert: &Insert) -> bool {
    (insert.scale_x.abs() - insert.scale_y.abs()).abs() <= 1.0e-9
}

#[cfg(test)]
mod tests {
    use crate::{
        entities::{Common, Insert},
        scene::{Item, Point, StrokeShape},
    };

    use super::transform_scene_item;

    #[test]
    fn insert_transform_updates_line_identity_and_geometry() {
        let mut item = Item::new("LINE-ab", "stroke");
        item.shape = Some(StrokeShape::line(
            Point::new(1.0, 0.0),
            Point::new(3.0, 0.0),
        ));
        let insert = Insert {
            common: Common::default(),
            position: Point::new(10.0, 20.0),
            scale_x: 2.0,
            scale_y: 2.0,
            rotation: std::f64::consts::FRAC_PI_2,
            block_handle: 0,
        };

        let transformed = transform_scene_item(item, &insert, 0x42);
        let shape = transformed.shape.unwrap();

        assert_eq!(transformed.id, "INSERT-42-LINE-ab");
        assert!((shape.start.unwrap().x - 10.0).abs() < 1.0e-9);
        assert!((shape.start.unwrap().y - 22.0).abs() < 1.0e-9);
        assert!((shape.end.unwrap().y - 26.0).abs() < 1.0e-9);
    }
}
