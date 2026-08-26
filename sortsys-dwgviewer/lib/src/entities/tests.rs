use std::f64::consts::PI;

use crate::{objects::ObjectType, scene::Point};

use super::{Entity, decode_insert, decode_raw_object};

#[derive(Default)]
struct BitWriter {
    bits: Vec<bool>,
}

impl BitWriter {
    fn bits(&mut self, value: u64, count: usize) {
        for shift in (0..count).rev() {
            self.bits.push(value & (1 << shift) != 0);
        }
    }

    fn bit(&mut self, value: bool) {
        self.bits.push(value);
    }

    fn raw_u8(&mut self, value: u8) {
        self.bits(u64::from(value), 8);
    }

    fn raw_bytes(&mut self, values: &[u8]) {
        for value in values {
            self.raw_u8(*value);
        }
    }

    fn raw_u16(&mut self, value: u16) {
        self.raw_bytes(&value.to_le_bytes());
    }

    fn raw_u32(&mut self, value: u32) {
        self.raw_bytes(&value.to_le_bytes());
    }

    fn raw_f64(&mut self, value: f64) {
        self.raw_bytes(&value.to_le_bytes());
    }

    fn bit_short_zero(&mut self) {
        self.bits(2, 2);
    }

    fn bit_short_byte(&mut self, value: u8) {
        self.bits(1, 2);
        self.raw_u8(value);
    }

    fn bit_short_full(&mut self, value: u16) {
        self.bits(0, 2);
        self.raw_u16(value);
    }

    fn bit_long_zero(&mut self) {
        self.bits(2, 2);
    }

    fn bit_long_byte(&mut self, value: u8) {
        self.bits(1, 2);
        self.raw_u8(value);
    }

    fn bit_double_zero(&mut self) {
        self.bits(2, 2);
    }

    fn bit_double(&mut self, value: f64) {
        self.bits(0, 2);
        self.raw_f64(value);
    }

    fn default_double_same(&mut self) {
        self.bits(0, 2);
    }

    fn default_double(&mut self, value: f64) {
        self.bits(3, 2);
        self.raw_f64(value);
    }

    fn handle(&mut self, code: u8, value: &[u8]) {
        self.bits(u64::from(code), 4);
        self.bits(value.len() as u64, 4);
        self.raw_bytes(value);
    }

    fn into_bytes(self) -> Vec<u8> {
        let mut output = vec![0_u8; self.bits.len().div_ceil(8)];
        for (index, bit) in self.bits.into_iter().enumerate() {
            if bit {
                output[index / 8] |= 0x80 >> (index % 8);
            }
        }

        output
    }
}

fn fixed_entity(object_type: u8, write_payload: impl FnOnce(&mut BitWriter)) -> Vec<u8> {
    let mut writer = BitWriter::default();
    writer.bit_short_byte(object_type);
    writer.raw_u32(0);
    writer.handle(0, &[0xab]);
    writer.bit_short_zero();
    writer.bit(false);

    // Sequential entity display properties.
    writer.bit(true);
    writer.bit_short_zero();
    writer.bit_double_zero();
    writer.bits(0, 2);
    writer.bits(0, 2);
    writer.bit_short_zero();
    writer.raw_u8(0);

    write_payload(&mut writer);
    finish_record(writer.into_bytes(), 0)
}

fn fixed_r2010_entity_at(
    object_type: u8,
    payload_bit_offset: usize,
    write_payload: impl FnOnce(&mut BitWriter),
) -> Vec<u8> {
    let mut writer = BitWriter::default();
    writer.bits(0, 2);
    writer.raw_u8(object_type);
    writer.handle(0, &[0xab]);
    writer.bit_short_zero();
    writer.bit(false);

    while writer.bits.len() < payload_bit_offset {
        writer.bit(false);
    }

    write_payload(&mut writer);
    let body_bit_length = writer.bits.len();
    let body = writer.into_bytes();
    let padding_bits = body.len() * 8 - body_bit_length;

    let mut record = Vec::with_capacity(body.len() + 3);
    record.extend_from_slice(&(body.len() as u16).to_le_bytes());
    record.push(padding_bits as u8);
    record.extend_from_slice(&body);
    record
}

fn finish_record(body: Vec<u8>, handle_stream_bits: u8) -> Vec<u8> {
    let mut record = Vec::with_capacity(body.len() + 3);
    record.extend_from_slice(&(body.len() as u16).to_le_bytes());
    if handle_stream_bits != 0 {
        record.push(handle_stream_bits);
    }
    record.extend_from_slice(&body);
    record
}

#[test]
fn decodes_sequential_line_circle_and_arc_records() {
    let line = fixed_entity(0x13, |writer| {
        writer.bit(true);
        writer.raw_f64(1.0);
        writer.default_double(3.0);
        writer.raw_f64(2.0);
        writer.default_double(4.0);
        writer.bit(true);
        writer.bit(true);
    });
    let (line, kind) = decode_raw_object(&line, "AC1015", 0x20).unwrap();
    assert_eq!(kind, ObjectType::LINE);
    assert!(matches!(
        line,
        Entity::Line { start, end, common }
            if start == Point::new(1.0, 2.0)
                && end == Point::new(3.0, 4.0)
                && common.id == "LINE-ab"
    ));

    let circle = fixed_entity(0x12, |writer| {
        writer.bit_double(5.0);
        writer.bit_double(6.0);
        writer.bit_double_zero();
        writer.bit_double(7.0);
        writer.bit(true);
        writer.bit(true);
    });
    assert!(matches!(
        decode_raw_object(&circle, "AC1015", 0x21).unwrap().0,
        Entity::Circle { center, radius, .. }
            if center == Point::new(5.0, 6.0) && radius == 7.0
    ));

    let arc = fixed_entity(0x11, |writer| {
        writer.bit_double(8.0);
        writer.bit_double(9.0);
        writer.bit_double_zero();
        writer.bit_double(10.0);
        writer.bit(true);
        writer.bit(true);
        writer.bit_double(0.25);
        writer.bit_double(1.5);
    });
    assert!(matches!(
        decode_raw_object(&arc, "AC1015", 0x22).unwrap().0,
        Entity::Arc { center, radius, start_angle, end_angle, .. }
            if center == Point::new(8.0, 9.0)
                && radius == 10.0
                && start_angle == 0.25
                && end_angle == 1.5
    ));
}

#[test]
fn decodes_filled_solid_and_trace_boundaries() {
    let solid = fixed_entity(0x1f, |writer| {
        writer.bit(true);
        writer.bit_double_zero();
        for value in [0.0, 0.0, 10.0, 0.0, 0.0, 5.0, 10.0, 5.0] {
            writer.raw_f64(value);
        }
        writer.bit(true);
    });
    let Entity::Fill { loops, solid, .. } = decode_raw_object(&solid, "AC1015", 0x31).unwrap().0
    else {
        panic!("expected solid fill");
    };
    assert!(solid);
    assert_eq!(
        loops[0],
        vec![
            Point::new(0.0, 0.0),
            Point::new(10.0, 0.0),
            Point::new(10.0, 5.0),
            Point::new(0.0, 5.0),
            Point::new(0.0, 0.0),
        ]
    );
}

#[test]
fn decodes_closed_lwpolyline_and_retains_bulges() {
    let polyline = fixed_entity(0x4d, |writer| {
        writer.bit_short_full(512 | 16);
        writer.bit_long_byte(4);
        writer.bit_long_byte(1);
        writer.raw_f64(1.0);
        writer.raw_f64(2.0);
        writer.default_double(5.0);
        writer.default_double_same();
        writer.default_double_same();
        writer.default_double(8.0);
        writer.default_double(1.0);
        writer.default_double_same();
        writer.bit_double((PI / 8.0).tan());
    });

    let Entity::Polyline {
        points,
        bulges,
        closed,
        ..
    } = decode_raw_object(&polyline, "AC1015", 0x23).unwrap().0
    else {
        panic!("expected polyline");
    };

    assert!(closed);
    assert_eq!(points.len(), 4);
    assert_eq!(bulges.len(), 4);
    assert!((bulges[0] - (PI / 8.0).tan()).abs() < 1.0e-9);
}

#[test]
fn decodes_inline_text_and_fit_point_spline() {
    let text = fixed_entity(0x01, |writer| {
        writer.raw_u8(0xff);
        writer.raw_f64(12.0);
        writer.raw_f64(34.0);
        writer.bit(true);
        writer.bit(true);
        writer.raw_f64(2.5);
        writer.bit_short_byte(4);
        writer.raw_bytes(b"Cafe");
    });
    assert!(matches!(
        decode_raw_object(&text, "AC1015", 0x2b).unwrap().0,
        Entity::Text { position, value, height: Some(2.5), .. }
            if position == Point::new(12.0, 34.0) && value == "Cafe"
    ));

    let spline = fixed_entity(0x24, |writer| {
        writer.bit_long_byte(2);
        writer.bit_long_byte(3);
        writer.bit_double_zero();
        for _ in 0..6 {
            writer.bit_double_zero();
        }
        writer.bit_long_byte(3);
        for value in [0.0, 0.0, 0.0, 5.0, 2.0, 0.0, 10.0, 0.0, 0.0] {
            if value == 0.0 {
                writer.bit_double_zero();
            } else {
                writer.bit_double(value);
            }
        }
    });
    assert!(matches!(
        decode_raw_object(&spline, "AC1015", 0x31).unwrap().0,
        Entity::Spline { points, .. }
            if points == vec![
                Point::new(0.0, 0.0),
                Point::new(5.0, 2.0),
                Point::new(10.0, 0.0),
            ]
    ));
}

#[test]
fn decodes_hatch_polyline_boundary() {
    let hatch = fixed_entity(0x4e, |writer| {
        writer.bit_double_zero();
        writer.bit_double_zero();
        writer.bit_double_zero();
        writer.bit_double(1.0);
        writer.bit_short_zero();
        writer.bit(true);
        writer.bit(false);
        writer.bit_long_byte(1);
        writer.bit_long_byte(2);
        writer.bit(false);
        writer.bit(true);
        writer.bit_long_byte(4);
        for value in [0.0, 0.0, 10.0, 0.0, 10.0, 5.0, 0.0, 5.0] {
            writer.raw_f64(value);
        }
        writer.bit_long_zero();
        writer.bit_short_zero();
        writer.bit_short_zero();
        writer.bit_long_zero();
    });

    let Entity::Fill { loops, solid, .. } = decode_raw_object(&hatch, "AC1015", 0x29).unwrap().0
    else {
        panic!("expected hatch fill");
    };
    assert!(solid);
    assert_eq!(loops[0].first(), loops[0].last());
    assert_eq!(loops[0].len(), 5);
}

#[test]
fn decodes_r2010_compact_lines_at_all_known_offsets() {
    for payload_offset in [73, 81, 89, 41] {
        let line = fixed_r2010_entity_at(0x13, payload_offset, |writer| {
            writer.bit(true);
            writer.raw_f64(1.0);
            writer.default_double(3.0);
            writer.raw_f64(2.0);
            writer.default_double(4.0);
            writer.bit(true);
            writer.bit(true);
        });

        assert!(matches!(
            decode_raw_object(&line, "AC1024", 0x20).unwrap().0,
            Entity::Line { start, end, .. }
                if start == Point::new(1.0, 2.0) && end == Point::new(3.0, 4.0)
        ));
    }
}

#[test]
fn decodes_r2010_compact_insert_and_assigns_block() {
    let record = fixed_r2010_entity_at(0x07, 65, |writer| {
        writer.bit_double(10.0);
        writer.bit_double(20.0);
        writer.bit_double_zero();
        writer.bits(3, 2);
        writer.bit_double(PI / 4.0);
        writer.bit(true);
        writer.bit(false);
        writer.bit_long_zero();
    });

    let (insert, kind) = decode_insert(&record, "AC1024", 0x70, 0x123).unwrap();
    assert_eq!(kind, ObjectType::INSERT);
    assert_eq!(insert.common.id, "INSERT-70");
    assert_eq!(insert.block_handle, 0x123);
    assert_eq!(insert.position, Point::new(10.0, 20.0));
    assert!((insert.rotation - PI / 4.0).abs() < 1.0e-9);
}

fn fixed_r2004_offset_entity(
    object_type: u8,
    payload_offset: usize,
    color_index: u8,
    write_payload: impl FnOnce(&mut BitWriter),
) -> Vec<u8> {
    let mut writer = BitWriter::default();
    writer.bit_short_byte(object_type);
    writer.raw_u32(0);
    writer.handle(0, &[0xab]);
    writer.bit_short_zero();
    writer.bit(false);
    writer.bits(0b00101, 5);
    writer.bit_short_byte(color_index);
    writer.bit_double_zero();
    writer.bits(0, 2);
    writer.bits(0, 2);
    writer.bit_short_zero();
    writer.raw_u8(0);

    while writer.bits.len() < payload_offset {
        writer.bit(false);
    }
    write_payload(&mut writer);

    finish_record(writer.into_bytes(), 0)
}

fn fixed_r2010_displayed_entity(
    object_type: u8,
    write_payload: impl FnOnce(&mut BitWriter),
    texts: &[&str],
) -> Vec<u8> {
    let mut writer = BitWriter::default();
    writer.bits(0, 2);
    writer.raw_u8(object_type);
    writer.handle(0, &[0xab]);
    writer.bit_short_zero();
    writer.bit(false);

    writer.bit(true);
    writer.bit_short_zero();
    writer.bit_double_zero();
    writer.bits(0, 2);
    writer.bits(0, 2);
    writer.bits(0, 2);
    writer.raw_u8(0);
    writer.bits(0, 3);
    writer.bit_short_zero();
    writer.raw_u8(0);

    write_payload(&mut writer);
    append_r2010_string_stream(&mut writer, texts);

    let bit_length = writer.bits.len();
    let body = writer.into_bytes();
    let mut record = Vec::with_capacity(body.len() + 3);
    record.extend_from_slice(&(body.len() as u16).to_le_bytes());
    record.push((body.len() * 8 - bit_length) as u8);
    record.extend_from_slice(&body);
    record
}

fn append_r2010_string_stream(writer: &mut BitWriter, texts: &[&str]) {
    let start = writer.bits.len();
    for text in texts {
        let units = text.encode_utf16().collect::<Vec<_>>();
        writer.bit_short_byte(units.len() as u8);
        for unit in units {
            writer.raw_u16(unit);
        }
    }

    let stream_bits = writer.bits.len() - start;
    writer.raw_u16(stream_bits as u16);
    writer.bit(true);
}

#[test]
fn decodes_r2010_unicode_text_and_mtext_string_streams() {
    for object_type in [0x01, 0x02, 0x03] {
        let record = fixed_r2010_displayed_entity(
            object_type,
            |writer| {
                writer.raw_u8(0xff);
                writer.raw_f64(12.0);
                writer.raw_f64(34.0);
                writer.bit(true);
                writer.bit(true);
                writer.raw_f64(2.5);
            },
            &["Café"],
        );

        assert!(matches!(
            decode_raw_object(&record, "AC1024", 0x2c).unwrap().0,
            Entity::Text { position, value, height: Some(2.5), .. }
                if position == Point::new(12.0, 34.0) && value == "Café"
        ));
    }

    let mtext = fixed_r2010_displayed_entity(
        0x2c,
        |writer| {
            for value in [12.0, 34.0, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0] {
                if value == 0.0 {
                    writer.bit_double_zero();
                } else {
                    writer.bit_double(value);
                }
            }
            writer.bit_double(50.0);
            writer.bit_double(10.0);
            writer.bit_double(3.0);
            writer.bit_short_byte(1);
            writer.bit_short_zero();
            writer.bit_double_zero();
            writer.bit_double_zero();
        },
        &["Room\\P101"],
    );

    assert!(matches!(
        decode_raw_object(&mtext, "AC1024", 0x2d).unwrap().0,
        Entity::Text { position, value, height: Some(3.0), .. }
            if position == Point::new(12.0, 34.0) && value == "Room\n101"
    ));
}

#[test]
fn decodes_r2004_offset_text_and_polyline_with_display_colors() {
    let text = fixed_r2004_offset_entity(0x01, 150, 2, |writer| {
        writer.raw_u8(0xff);
        writer.raw_f64(12.0);
        writer.raw_f64(34.0);
        writer.bit(true);
        writer.bit(true);
        writer.raw_f64(2.5);
        writer.bit_short_byte(4);
        writer.raw_bytes(b"Text");
    });
    assert!(matches!(
        decode_raw_object(&text, "AC1018", 0x30).unwrap().0,
        Entity::Text { common, value, .. }
            if value == "Text" && common.color.as_deref() == Some("#ffff00")
    ));

    let polyline = fixed_r2004_offset_entity(0x4d, 150, 1, |writer| {
        writer.bit_short_zero();
        writer.bit_long_byte(3);
        writer.raw_f64(10.0);
        writer.raw_f64(20.0);
        writer.default_double(15.0);
        writer.default_double_same();
        writer.default_double_same();
        writer.default_double(25.0);
    });
    assert!(matches!(
        decode_raw_object(&polyline, "AC1018", 0x2e).unwrap().0,
        Entity::Polyline { common, points, closed: false, .. }
            if common.color.as_deref() == Some("#ff0000")
                && points == vec![
                    Point::new(10.0, 20.0),
                    Point::new(15.0, 20.0),
                    Point::new(15.0, 25.0),
                ]
    ));
}

#[test]
fn decodes_r2010_compact_curves_and_point() {
    let circle = fixed_r2010_entity_at(0x12, 81, |writer| {
        writer.bit_double(5.0);
        writer.bit_double(6.0);
        writer.bit_double_zero();
        writer.bit_double(7.0);
        writer.bit(true);
        writer.bit(true);
    });
    assert!(matches!(
        decode_raw_object(&circle, "AC1024", 0x25).unwrap().0,
        Entity::Circle { center, radius, .. }
            if center == Point::new(5.0, 6.0) && radius == 7.0
    ));

    let point = fixed_r2010_entity_at(0x1b, 89, |writer| {
        writer.bit_double(8.0);
        writer.bit_double(9.0);
        writer.bit_double_zero();
        writer.bit(true);
        writer.bit(true);
        writer.bit_double_zero();
    });
    assert!(matches!(
        decode_raw_object(&point, "AC1024", 0x26).unwrap().0,
        Entity::Point { position, .. } if position == Point::new(8.0, 9.0)
    ));

    let ellipse = fixed_r2010_entity_at(0x23, 81, |writer| {
        for value in [
            10.0, 11.0, 0.0, 3.0, 4.0, 0.0, 0.0, 0.0, 1.0, 0.5, 0.25, 1.75,
        ] {
            if value == 0.0 {
                writer.bit_double_zero();
            } else {
                writer.bit_double(value);
            }
        }
    });
    assert!(matches!(
        decode_raw_object(&ellipse, "AC1024", 0x27).unwrap().0,
        Entity::Ellipse { center, radius_x, radius_y, .. }
            if center == Point::new(10.0, 11.0)
                && (radius_x - 5.0).abs() < 1.0e-9
                && (radius_y - 2.5).abs() < 1.0e-9
    ));

    let arc = fixed_r2010_entity_at(0x11, 89, |writer| {
        writer.bit_double(12.0);
        writer.bit_double(13.0);
        writer.bit_double_zero();
        writer.bit_double(14.0);
        writer.bit(true);
        writer.bit(true);
        writer.bit_double(0.25);
        writer.bit_double(1.5);
    });
    assert!(matches!(
        decode_raw_object(&arc, "AC1024", 0x28).unwrap().0,
        Entity::Arc { center, radius, .. }
            if center == Point::new(12.0, 13.0) && radius == 14.0
    ));
}

#[test]
fn decodes_r2010_compact_hatch() {
    let hatch = fixed_r2010_entity_at(0x4e, 73, |writer| {
        writer.bit_long_zero();
        writer.bit_long_zero();
        writer.bit_double_zero();
        writer.bit_double_zero();
        writer.bit_long_zero();
        writer.bit_double_zero();
        writer.bit_long_zero();
        writer.bit_double_zero();
        writer.bit_double_zero();
        writer.bit_double_zero();
        writer.bit_double(1.0);
        writer.bit(true);
        writer.bit(false);
        writer.bit_long_byte(1);
        writer.bit_long_byte(2);
        writer.bit(false);
        writer.bit(true);
        writer.bit_long_byte(4);
        for value in [0.0, 0.0, 10.0, 0.0, 10.0, 5.0, 0.0, 5.0] {
            writer.raw_f64(value);
        }
        writer.bit_long_zero();
        writer.bit_short_zero();
        writer.bit_short_zero();
        writer.bit_long_zero();
    });

    assert!(matches!(
        decode_raw_object(&hatch, "AC1024", 0x2a).unwrap().0,
        Entity::Fill { loops, solid: true, .. }
            if loops.len() == 1 && loops[0].len() == 5
    ));
}
