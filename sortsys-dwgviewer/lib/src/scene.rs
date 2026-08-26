//! Stable browser-facing scene document.
//!
//! This module is deliberately independent from DWG record layouts. Decoder
//! changes can therefore evolve without changing the TypeScript adapter.

use serde::Serialize;

pub const SCHEMA: &str = "sortsys-dwg-scene@1";

const MAX_COORDINATE_MAGNITUDE: f64 = 1.0e8;
const MAX_ANGLE_MAGNITUDE: f64 = std::f64::consts::PI * 64.0;
const MINIMUM_RENDERABLE_EXTENT: f64 = 1.0e-6;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Document {
    pub schema: &'static str,
    pub meta: Meta,
    pub layers: Vec<Layer>,
    pub pages: Vec<Page>,
    pub items: Vec<Item>,
    pub diagnostics: Vec<Diagnostic>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Meta {
    pub version: Option<String>,
    pub units: Option<String>,

    #[serde(rename = "sourceStats")]
    pub source_stats: SourceStats,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Default)]
pub struct SourceStats {
    #[serde(rename = "byteLength")]
    pub byte_length: usize,

    #[serde(rename = "sectionCount")]
    pub section_count: usize,

    #[serde(rename = "objectCount")]
    pub object_count: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Layer {
    pub id: String,
    pub name: String,
    pub visible: bool,
    pub color: Option<String>,

    #[serde(rename = "lineWeight")]
    pub line_weight: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Default)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

impl Point {
    pub const fn new(x: f64, y: f64) -> Self {
        Self { x, y }
    }

    fn is_finite(self) -> bool {
        self.x.is_finite() && self.y.is_finite()
    }

    fn is_reasonable(self) -> bool {
        reasonable_number(self.x) && reasonable_number(self.y)
    }

    fn distance_to(self, other: Self) -> f64 {
        (self.x - other.x).hypot(self.y - other.y)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Bounds {
    #[serde(rename = "minX")]
    pub min_x: f64,

    #[serde(rename = "minY")]
    pub min_y: f64,

    #[serde(rename = "maxX")]
    pub max_x: f64,

    #[serde(rename = "maxY")]
    pub max_y: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Page {
    pub id: String,
    pub name: String,
    pub bounds: Option<Bounds>,

    #[serde(rename = "itemIds")]
    pub item_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct StrokeShape {
    #[serde(rename = "type")]
    pub kind: String,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub start: Option<Point>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub end: Option<Point>,

    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub points: Vec<Point>,

    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub bulges: Vec<f64>,

    #[serde(skip_serializing_if = "is_false")]
    pub closed: bool,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub center: Option<Point>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub radius: Option<f64>,

    #[serde(rename = "radiusX", skip_serializing_if = "Option::is_none")]
    pub radius_x: Option<f64>,

    #[serde(rename = "radiusY", skip_serializing_if = "Option::is_none")]
    pub radius_y: Option<f64>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub rotation: Option<f64>,

    #[serde(rename = "startAngle", skip_serializing_if = "Option::is_none")]
    pub start_angle: Option<f64>,

    #[serde(rename = "endAngle", skip_serializing_if = "Option::is_none")]
    pub end_angle: Option<f64>,
}

impl StrokeShape {
    pub fn line(start: Point, end: Point) -> Self {
        Self {
            kind: "line".into(),
            start: Some(start),
            end: Some(end),
            ..Self::empty()
        }
    }

    pub fn polyline(points: Vec<Point>, bulges: Vec<f64>, closed: bool) -> Self {
        Self {
            kind: "polyline".into(),
            points,
            bulges,
            closed,
            ..Self::empty()
        }
    }

    pub fn spline(points: Vec<Point>) -> Self {
        Self {
            kind: "spline".into(),
            points,
            ..Self::empty()
        }
    }

    pub fn circle(center: Point, radius: f64) -> Self {
        Self {
            kind: "circle".into(),
            center: Some(center),
            radius: Some(radius),
            ..Self::empty()
        }
    }

    pub fn arc(center: Point, radius: f64, start_angle: f64, end_angle: f64) -> Self {
        Self {
            kind: "arc".into(),
            center: Some(center),
            radius: Some(radius),
            start_angle: Some(start_angle),
            end_angle: Some(end_angle),
            ..Self::empty()
        }
    }

    pub fn ellipse(
        center: Point,
        radius_x: f64,
        radius_y: f64,
        rotation: Option<f64>,
        start_angle: Option<f64>,
        end_angle: Option<f64>,
    ) -> Self {
        Self {
            kind: "ellipse".into(),
            center: Some(center),
            radius_x: Some(radius_x),
            radius_y: Some(radius_y),
            rotation,
            start_angle,
            end_angle,
            ..Self::empty()
        }
    }

    fn empty() -> Self {
        Self {
            kind: String::new(),
            start: None,
            end: None,
            points: Vec::new(),
            bulges: Vec::new(),
            closed: false,
            center: None,
            radius: None,
            radius_x: None,
            radius_y: None,
            rotation: None,
            start_angle: None,
            end_angle: None,
        }
    }

    fn is_finite(&self) -> bool {
        self.start.is_none_or(Point::is_finite)
            && self.end.is_none_or(Point::is_finite)
            && self.center.is_none_or(Point::is_finite)
            && self.points.iter().copied().all(Point::is_finite)
            && self.bulges.iter().all(|value| value.is_finite())
            && optional_finite(self.radius)
            && optional_finite(self.radius_x)
            && optional_finite(self.radius_y)
            && optional_finite(self.rotation)
            && optional_finite(self.start_angle)
            && optional_finite(self.end_angle)
    }

    fn has_reasonable_geometry(&self) -> bool {
        match self.kind.as_str() {
            "line" => self.start.zip(self.end).is_some_and(|(start, end)| {
                start.is_reasonable()
                    && end.is_reasonable()
                    && start.distance_to(end) >= MINIMUM_RENDERABLE_EXTENT
            }),
            "polyline" | "spline" => {
                self.points.len() >= 2
                    && self.points.iter().copied().all(Point::is_reasonable)
                    && self.bulges.iter().all(|value| reasonable_number(*value))
            }
            "circle" => {
                self.center.is_some_and(Point::is_reasonable)
                    && self.radius.is_some_and(reasonable_positive_number)
            }
            "arc" => {
                self.center.is_some_and(Point::is_reasonable)
                    && self.radius.is_some_and(reasonable_positive_number)
                    && reasonable_angle_pair(self.start_angle, self.end_angle)
            }
            "ellipse" => {
                self.center.is_some_and(Point::is_reasonable)
                    && self.radius_x.is_some_and(reasonable_positive_number)
                    && self.radius_y.is_some_and(reasonable_positive_number)
                    && reasonable_optional_angle_pair(self.start_angle, self.end_angle)
            }
            _ => true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Item {
    pub id: String,

    #[serde(rename = "type")]
    pub kind: String,

    #[serde(rename = "layerId", skip_serializing_if = "Option::is_none")]
    pub layer_id: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,

    #[serde(rename = "colorRole", skip_serializing_if = "Option::is_none")]
    pub color_role: Option<String>,

    #[serde(rename = "lineWeight", skip_serializing_if = "Option::is_none")]
    pub line_weight: Option<f64>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub shape: Option<StrokeShape>,

    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub loops: Vec<Vec<Point>>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub solid: Option<bool>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<Point>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<f64>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub rotation: Option<f64>,
}

impl Item {
    pub fn new(id: impl Into<String>, kind: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            kind: kind.into(),
            layer_id: None,
            color: None,
            color_role: None,
            line_weight: None,
            shape: None,
            loops: Vec::new(),
            solid: None,
            position: None,
            value: None,
            height: None,
            rotation: None,
        }
    }

    fn is_finite(&self) -> bool {
        optional_finite(self.line_weight)
            && optional_finite(self.height)
            && optional_finite(self.rotation)
            && self.shape.as_ref().is_none_or(StrokeShape::is_finite)
            && self.position.is_none_or(Point::is_finite)
            && self.loops.iter().flatten().copied().all(Point::is_finite)
    }

    fn has_reasonable_geometry(&self) -> bool {
        optional_reasonable(self.line_weight)
            && optional_reasonable(self.height)
            && optional_reasonable(self.rotation)
            && self
                .shape
                .as_ref()
                .is_none_or(StrokeShape::has_reasonable_geometry)
            && self.position.is_none_or(Point::is_reasonable)
            && self.loops.iter().all(|points| {
                !points.is_empty() && points.iter().copied().all(Point::is_reasonable)
            })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Diagnostic {
    pub level: String,
    pub code: String,
    pub message: String,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub count: Option<usize>,

    #[serde(rename = "objectType", skip_serializing_if = "Option::is_none")]
    pub object_type: Option<String>,
}

impl Document {
    pub fn new(version: Option<String>, byte_length: usize) -> Self {
        Self {
            schema: SCHEMA,
            meta: Meta {
                version,
                units: None,
                source_stats: SourceStats {
                    byte_length,
                    ..SourceStats::default()
                },
            },
            layers: Vec::new(),
            pages: vec![Page {
                id: "model".into(),
                name: "Model".into(),
                bounds: None,
                item_ids: Vec::new(),
            }],
            items: Vec::new(),
            diagnostics: Vec::new(),
        }
    }

    pub fn add_diagnostic(
        &mut self,
        level: impl Into<String>,
        code: impl Into<String>,
        message: impl Into<String>,
    ) {
        self.diagnostics.push(Diagnostic {
            level: level.into(),
            code: code.into(),
            message: message.into(),
            count: None,
            object_type: None,
        });
    }

    pub fn add_object_diagnostic(
        &mut self,
        level: impl Into<String>,
        code: impl Into<String>,
        message: impl Into<String>,
        count: usize,
        object_type: impl Into<String>,
    ) {
        self.diagnostics.push(Diagnostic {
            level: level.into(),
            code: code.into(),
            message: message.into(),
            count: Some(count),
            object_type: Some(object_type.into()),
        });
    }

    pub fn add_counted_diagnostic(
        &mut self,
        level: impl Into<String>,
        code: impl Into<String>,
        message: impl Into<String>,
    ) {
        let level = level.into();
        let code = code.into();
        let message = message.into();

        if let Some(existing) = self.diagnostics.iter_mut().find(|diagnostic| {
            diagnostic.level == level
                && diagnostic.code == code
                && diagnostic.message == message
                && diagnostic.object_type.is_none()
        }) {
            *existing.count.get_or_insert(1) += 1;
            return;
        }

        self.diagnostics.push(Diagnostic {
            level,
            code,
            message,
            count: Some(1),
            object_type: None,
        });
    }

    pub fn add_item(&mut self, page_id: &str, item: Item) {
        if !item.is_finite() {
            self.add_counted_diagnostic(
                "warning",
                "invalid_geometry_dropped",
                "Skipped DWG geometry containing non-finite coordinates.",
            );
            return;
        }

        if !item.has_reasonable_geometry() {
            self.add_counted_diagnostic(
                "warning",
                "invalid_geometry_dropped",
                "Skipped DWG geometry containing implausible coordinates.",
            );
            return;
        }

        let item_id = item.id.clone();
        self.items.push(item);

        if let Some(page) = self.pages.iter_mut().find(|page| page.id == page_id) {
            page.item_ids.push(item_id);
            return;
        }

        self.pages.push(Page {
            id: page_id.into(),
            name: page_id.into(),
            bounds: None,
            item_ids: vec![item_id],
        });
    }
}

fn is_false(value: &bool) -> bool {
    !*value
}

fn optional_finite(value: Option<f64>) -> bool {
    value.is_none_or(f64::is_finite)
}

fn optional_reasonable(value: Option<f64>) -> bool {
    value.is_none_or(reasonable_number)
}

fn reasonable_number(value: f64) -> bool {
    value.is_finite() && value.abs() <= MAX_COORDINATE_MAGNITUDE
}

fn reasonable_positive_number(value: f64) -> bool {
    value > 0.0 && reasonable_number(value)
}

fn reasonable_angle(value: f64) -> bool {
    value.is_finite() && value.abs() <= MAX_ANGLE_MAGNITUDE
}

fn reasonable_angle_pair(start: Option<f64>, end: Option<f64>) -> bool {
    start.zip(end).is_some_and(|(start, end)| {
        reasonable_angle(start)
            && reasonable_angle(end)
            && (end - start).abs() <= MAX_ANGLE_MAGNITUDE
    })
}

fn reasonable_optional_angle_pair(start: Option<f64>, end: Option<f64>) -> bool {
    start.is_none() && end.is_none() || reasonable_angle_pair(start, end)
}

#[cfg(test)]
mod tests {
    use super::{Document, Item, Point, StrokeShape};

    #[test]
    fn drops_unbounded_arc_angle_spans() {
        let mut document = Document::new(Some("AC1032".into()), 128);
        let mut item = Item::new("arc-1", "stroke");
        item.shape = Some(StrokeShape::arc(
            Point::new(0.0, 0.0),
            10.0,
            0.0,
            std::f64::consts::PI * 100.0,
        ));

        document.add_item("model", item);

        assert!(document.items.is_empty());
        assert_eq!(document.diagnostics[0].code, "invalid_geometry_dropped");
    }

    #[test]
    fn serializes_the_browser_scene_schema() {
        let document = Document::new(Some("AC1032".into()), 32);
        let value = serde_json::to_value(document).unwrap();

        assert_eq!(value["schema"], "sortsys-dwg-scene@1");
        assert_eq!(value["meta"]["version"], "AC1032");
        assert_eq!(value["meta"]["sourceStats"]["byteLength"], 32);
    }
}
