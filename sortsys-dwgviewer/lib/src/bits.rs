//! Byte- and bit-oriented readers for DWG's primitive encodings.

use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParseError {
    ShortRead,
    InvalidCode,
    UnsupportedEntity,
    InvalidData(String),
}

impl fmt::Display for ParseError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ShortRead => formatter.write_str("DWG cursor reached the end of its input"),
            Self::UnsupportedEntity => formatter.write_str("unsupported DWG entity"),
            Self::InvalidCode => formatter.write_str("DWG value uses an invalid bit code"),
            Self::InvalidData(message) => formatter.write_str(message),
        }
    }
}

impl std::error::Error for ParseError {}

pub type ParseResult<T> = Result<T, ParseError>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HandleReference {
    pub code: u8,
    pub count: u8,
    pub value: u64,
    pub bytes: Vec<u8>,
}

/// Reads byte-aligned DWG structures.
#[derive(Debug, Clone)]
pub struct Cursor<'a> {
    data: &'a [u8],
    offset: usize,
}

impl<'a> Cursor<'a> {
    pub fn new(data: &'a [u8]) -> Self {
        Self { data, offset: 0 }
    }

    pub fn offset(&self) -> usize {
        self.offset
    }

    pub fn remaining(&self) -> usize {
        self.data.len().saturating_sub(self.offset)
    }

    pub fn seek(&mut self, offset: usize) -> ParseResult<()> {
        if offset > self.data.len() {
            return Err(ParseError::ShortRead);
        }

        self.offset = offset;
        Ok(())
    }

    pub fn read_u8(&mut self) -> ParseResult<u8> {
        let value = *self.data.get(self.offset).ok_or(ParseError::ShortRead)?;
        self.offset += 1;
        Ok(value)
    }

    pub fn read_bytes(&mut self, count: usize) -> ParseResult<&'a [u8]> {
        let end = self
            .offset
            .checked_add(count)
            .filter(|end| *end <= self.data.len())
            .ok_or(ParseError::ShortRead)?;

        let value = &self.data[self.offset..end];
        self.offset = end;
        Ok(value)
    }

    pub fn read_u16_le(&mut self) -> ParseResult<u16> {
        Ok(u16::from_le_bytes(
            self.read_bytes(2)?.try_into().expect("length checked"),
        ))
    }

    pub fn read_u16_be(&mut self) -> ParseResult<u16> {
        Ok(u16::from_be_bytes(
            self.read_bytes(2)?.try_into().expect("length checked"),
        ))
    }

    pub fn read_u32_le(&mut self) -> ParseResult<u32> {
        Ok(u32::from_le_bytes(
            self.read_bytes(4)?.try_into().expect("length checked"),
        ))
    }

    pub fn read_u64_le(&mut self) -> ParseResult<u64> {
        Ok(u64::from_le_bytes(
            self.read_bytes(8)?.try_into().expect("length checked"),
        ))
    }

    pub fn read_u32_be(&mut self) -> ParseResult<u32> {
        Ok(u32::from_be_bytes(
            self.read_bytes(4)?.try_into().expect("length checked"),
        ))
    }

    pub fn read_i32_le(&mut self) -> ParseResult<i32> {
        Ok(self.read_u32_le()? as i32)
    }

    pub fn read_f64_le(&mut self) -> ParseResult<f64> {
        Ok(f64::from_bits(self.read_u64_le()?))
    }

    pub fn read_modular_char(&mut self) -> ParseResult<i64> {
        self.read_modular(7, true).map(|(value, _)| value)
    }

    pub fn read_modular_char_unsigned(&mut self) -> ParseResult<u64> {
        self.read_modular(7, false).map(|(value, _)| value as u64)
    }

    pub fn read_modular_short_unsigned(&mut self) -> ParseResult<u64> {
        self.read_modular_short(false)
            .map(|(value, _)| value as u64)
    }

    fn read_modular(&mut self, payload_bits: u32, signed: bool) -> ParseResult<(i64, usize)> {
        let mut value = 0_u64;
        let mut shift = 0_u32;
        let mut count = 0_usize;

        loop {
            let byte = self.read_u8()?;
            count += 1;

            let last = byte & 0x80 == 0;
            let mut payload = byte & 0x7f;
            let negative = signed && last && payload & 0x40 != 0;
            if negative {
                payload &= !0x40;
            }

            value |= u64::from(payload) << shift;

            if last {
                let value = value as i64;
                return Ok((if negative { -value } else { value }, count));
            }

            shift += payload_bits;
            if shift >= 63 {
                return Err(ParseError::InvalidCode);
            }
        }
    }

    fn read_modular_short(&mut self, signed: bool) -> ParseResult<(i64, usize)> {
        let mut value = 0_u64;
        let mut shift = 0_u32;
        let mut count = 0_usize;

        loop {
            let raw = self.read_u16_le()?;
            count += 1;

            let last = raw & 0x8000 == 0;
            let mut payload = raw & 0x7fff;
            let negative = signed && last && payload & 0x4000 != 0;
            if negative {
                payload &= !0x4000;
            }

            value |= u64::from(payload) << shift;

            if last {
                let value = value as i64;
                return Ok((if negative { -value } else { value }, count));
            }

            shift += 15;
            if shift >= 63 {
                return Err(ParseError::InvalidCode);
            }
        }
    }
}

/// Reads MSB-first bit-coded values while preserving unaligned byte reads.
#[derive(Debug, Clone)]
pub struct BitCursor<'a> {
    data: &'a [u8],
    bit_offset: usize,
}

impl<'a> BitCursor<'a> {
    pub fn new(data: &'a [u8]) -> Self {
        Self {
            data,
            bit_offset: 0,
        }
    }

    pub fn bit_offset(&self) -> usize {
        self.bit_offset
    }

    pub fn seek_bit(&mut self, offset: usize) -> ParseResult<()> {
        if offset > self.data.len() * 8 {
            return Err(ParseError::ShortRead);
        }

        self.bit_offset = offset;
        Ok(())
    }

    pub fn remaining_bits(&self) -> usize {
        (self.data.len() * 8).saturating_sub(self.bit_offset)
    }

    pub fn align_byte(&mut self) {
        let remainder = self.bit_offset % 8;
        if remainder != 0 {
            self.bit_offset += 8 - remainder;
        }
    }

    pub fn read_bit(&mut self) -> ParseResult<bool> {
        if self.remaining_bits() < 1 {
            return Err(ParseError::ShortRead);
        }

        let byte = self.data[self.bit_offset / 8];
        let mask = 0x80_u8 >> (self.bit_offset % 8);
        self.bit_offset += 1;

        Ok(byte & mask != 0)
    }

    pub fn read_bits(&mut self, count: usize) -> ParseResult<u64> {
        if count > 64 || self.remaining_bits() < count {
            return Err(ParseError::ShortRead);
        }

        let mut value = 0_u64;
        for _ in 0..count {
            value <<= 1;
            if self.read_bit()? {
                value |= 1;
            }
        }

        Ok(value)
    }

    pub fn read_raw_u8(&mut self) -> ParseResult<u8> {
        Ok(self.read_bits(8)? as u8)
    }

    pub fn read_raw_bytes(&mut self, count: usize) -> ParseResult<Vec<u8>> {
        if self.remaining_bits() < count.saturating_mul(8) {
            return Err(ParseError::ShortRead);
        }

        (0..count).map(|_| self.read_raw_u8()).collect()
    }

    pub fn read_raw_u16_le(&mut self) -> ParseResult<u16> {
        let raw = self.read_raw_bytes(2)?;
        Ok(u16::from_le_bytes(raw.try_into().expect("length checked")))
    }

    pub fn read_raw_u32_le(&mut self) -> ParseResult<u32> {
        let raw = self.read_raw_bytes(4)?;
        Ok(u32::from_le_bytes(raw.try_into().expect("length checked")))
    }

    pub fn read_raw_f64_le(&mut self) -> ParseResult<f64> {
        let raw = self.read_raw_bytes(8)?;
        Ok(f64::from_le_bytes(raw.try_into().expect("length checked")))
    }

    pub fn read_bit_triplet(&mut self) -> ParseResult<u8> {
        let mut value = 0_u8;

        for _ in 0..3 {
            value <<= 1;
            if self.read_bit()? {
                value |= 1;
            } else {
                return Ok(value);
            }
        }

        Ok(value)
    }

    pub fn read_bit_short(&mut self) -> ParseResult<i16> {
        match self.read_bits(2)? {
            0 => Ok(self.read_raw_u16_le()? as i16),
            1 => Ok(i16::from(self.read_raw_u8()?)),
            2 => Ok(0),
            3 => Ok(256),
            _ => unreachable!(),
        }
    }

    pub fn read_bit_long(&mut self) -> ParseResult<i32> {
        match self.read_bits(2)? {
            0 => Ok(self.read_raw_u32_le()? as i32),
            1 => Ok(i32::from(self.read_raw_u8()?)),
            2 => Ok(0),
            3 => Err(ParseError::InvalidCode),
            _ => unreachable!(),
        }
    }

    pub fn read_bit_long_long(&mut self) -> ParseResult<u64> {
        let length = usize::from(self.read_bit_triplet()?);
        let mut value = 0_u64;

        for (index, byte) in self.read_raw_bytes(length)?.into_iter().enumerate() {
            value |= u64::from(byte) << (index * 8);
        }

        Ok(value)
    }

    pub fn read_bit_double(&mut self) -> ParseResult<f64> {
        match self.read_bits(2)? {
            0 => self.read_raw_f64_le(),
            1 => Ok(1.0),
            2 => Ok(0.0),
            3 => Err(ParseError::InvalidCode),
            _ => unreachable!(),
        }
    }

    pub fn read_2bd(&mut self) -> ParseResult<[f64; 2]> {
        Ok([self.read_bit_double()?, self.read_bit_double()?])
    }

    pub fn read_3bd(&mut self) -> ParseResult<[f64; 3]> {
        Ok([
            self.read_bit_double()?,
            self.read_bit_double()?,
            self.read_bit_double()?,
        ])
    }

    /// DWG's default-double encoding patches bytes of the previous value.
    pub fn read_bit_double_default(&mut self, default: f64) -> ParseResult<f64> {
        let code = self.read_bits(2)?;
        if code == 0 {
            return Ok(default);
        }
        if code == 3 {
            return self.read_raw_f64_le();
        }

        let mut raw = default.to_le_bytes();
        if code == 1 {
            raw[..4].copy_from_slice(&self.read_raw_bytes(4)?);
        } else {
            let patch = self.read_raw_bytes(6)?;
            raw[4..6].copy_from_slice(&patch[..2]);
            raw[..4].copy_from_slice(&patch[2..]);
        }

        Ok(f64::from_le_bytes(raw))
    }

    pub fn read_bit_thickness(&mut self) -> ParseResult<f64> {
        if self.read_bit()? {
            Ok(0.0)
        } else {
            self.read_bit_double()
        }
    }

    pub fn read_bit_extrusion(&mut self) -> ParseResult<[f64; 3]> {
        if self.read_bit()? {
            Ok([0.0, 0.0, 1.0])
        } else {
            self.read_3bd()
        }
    }

    pub fn read_object_type(&mut self, r2010_or_later: bool) -> ParseResult<i32> {
        if !r2010_or_later {
            return Ok(i32::from(self.read_bit_short()?));
        }

        match self.read_bits(2)? {
            0 => Ok(i32::from(self.read_raw_u8()?)),
            1 => Ok(i32::from(self.read_raw_u8()?) + 0x1f0),
            2 | 3 => Ok(i32::from(self.read_raw_u16_le()?)),
            _ => unreachable!(),
        }
    }

    pub fn read_handle_reference(&mut self) -> ParseResult<HandleReference> {
        let code = self.read_bits(4)? as u8;
        let count = self.read_bits(4)? as u8;
        let bytes = self.read_raw_bytes(usize::from(count))?;
        let value = bytes
            .iter()
            .fold(0_u64, |value, byte| (value << 8) | u64::from(*byte));

        Ok(HandleReference {
            code,
            count,
            value,
            bytes,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{BitCursor, Cursor, ParseError};

    struct BitWriter {
        bits: Vec<bool>,
    }

    impl BitWriter {
        fn new() -> Self {
            Self { bits: Vec::new() }
        }

        fn value(&mut self, value: u64, count: usize) {
            for shift in (0..count).rev() {
                self.bits.push(value & (1 << shift) != 0);
            }
        }

        fn byte(&mut self, value: u8) {
            self.value(u64::from(value), 8);
        }

        fn bytes(self) -> Vec<u8> {
            let mut output = vec![0; self.bits.len().div_ceil(8)];
            for (index, bit) in self.bits.into_iter().enumerate() {
                if bit {
                    output[index / 8] |= 0x80 >> (index % 8);
                }
            }
            output
        }
    }

    #[test]
    fn cursor_reads_endian_and_modular_values() {
        let data = [0x34, 0x12, 0x78, 0x56, 0x34, 0x12, 0xac, 0x02, 0x45];
        let mut cursor = Cursor::new(&data);

        assert_eq!(cursor.read_u16_le().unwrap(), 0x1234);
        assert_eq!(cursor.read_u32_le().unwrap(), 0x1234_5678);
        assert_eq!(cursor.read_modular_char_unsigned().unwrap(), 300);
        assert_eq!(cursor.read_modular_char().unwrap(), -5);
        assert_eq!(cursor.remaining(), 0);
        assert_eq!(cursor.read_u8(), Err(ParseError::ShortRead));
    }

    #[test]
    fn bit_cursor_reads_short_long_double_and_handles() {
        let mut writer = BitWriter::new();
        writer.value(1, 2);
        writer.byte(42);
        writer.value(1, 2);
        writer.byte(9);
        writer.value(1, 2);
        writer.value(0xa, 4);
        writer.value(2, 4);
        writer.byte(0x12);
        writer.byte(0x34);

        let bytes = writer.bytes();
        let mut cursor = BitCursor::new(&bytes);

        assert_eq!(cursor.read_bit_short().unwrap(), 42);
        assert_eq!(cursor.read_bit_long().unwrap(), 9);
        assert_eq!(cursor.read_bit_double().unwrap(), 1.0);

        let handle = cursor.read_handle_reference().unwrap();
        assert_eq!(handle.code, 0xa);
        assert_eq!(handle.value, 0x1234);
    }

    #[test]
    fn bit_cursor_seeks_and_rejects_short_reads() {
        let mut cursor = BitCursor::new(&[0b1010_0000]);
        assert!(cursor.read_bit().unwrap());
        assert!(!cursor.read_bit().unwrap());

        cursor.seek_bit(0).unwrap();
        assert_eq!(cursor.read_bits(4).unwrap(), 0b1010);
        assert_eq!(cursor.read_bits(8), Err(ParseError::ShortRead));
    }
}
