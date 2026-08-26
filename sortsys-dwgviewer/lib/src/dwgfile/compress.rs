//! R2004 LZ-style logical-section decompression.

const INVALID_COMPRESSION: &str = "invalid R2004 compressed DWG section";

pub fn decompress_r2004_section(input: &[u8], expected_size: usize) -> Result<Vec<u8>, String> {
    let mut reader = CompressionReader::new(input);
    let mut output = Vec::with_capacity(expected_size);

    let (literal_count, mut pending) = reader.read_literal_length()?;
    if literal_count > 0 {
        reader.copy_literal(&mut output, literal_count)?;
    }

    loop {
        let opcode = pending.take().map_or_else(|| reader.read_u8(), Ok)?;
        if opcode == 0x11 {
            break;
        }

        let (compressed_bytes, copy_offset, mut literal_count) = reader.decode_opcode(opcode)?;
        copy_from_window(&mut output, copy_offset, compressed_bytes)?;

        if literal_count == 0 {
            (literal_count, pending) = reader.read_literal_length()?;
        }
        if literal_count > 0 {
            reader.copy_literal(&mut output, literal_count)?;
        }

        if expected_size > 0 && output.len() > expected_size {
            return Err(format!(
                "{INVALID_COMPRESSION}: decompressed output exceeded {expected_size} bytes"
            ));
        }
    }

    if expected_size > 0 && output.len() != expected_size {
        return Err(format!(
            "{INVALID_COMPRESSION}: decompressed {} bytes, expected {expected_size}",
            output.len()
        ));
    }

    Ok(output)
}

struct CompressionReader<'a> {
    data: &'a [u8],
    offset: usize,
}

impl<'a> CompressionReader<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, offset: 0 }
    }

    fn read_u8(&mut self) -> Result<u8, String> {
        let byte = self.data.get(self.offset).copied().ok_or_else(|| {
            format!(
                "{INVALID_COMPRESSION}: unexpected end at compressed offset {}",
                self.offset
            )
        })?;

        self.offset += 1;
        Ok(byte)
    }

    fn copy_literal(&mut self, output: &mut Vec<u8>, count: usize) -> Result<(), String> {
        let end = self
            .offset
            .checked_add(count)
            .filter(|end| *end <= self.data.len())
            .ok_or_else(|| {
                format!(
                    "{INVALID_COMPRESSION}: literal count={count} at compressed offset {} exceeds input {}",
                    self.offset,
                    self.data.len()
                )
            })?;

        output.extend_from_slice(&self.data[self.offset..end]);
        self.offset = end;
        Ok(())
    }

    fn read_literal_length(&mut self) -> Result<(usize, Option<u8>), String> {
        let byte = self.read_u8()?;
        if (0x01..=0x0f).contains(&byte) {
            return Ok((usize::from(byte) + 3, None));
        }
        if byte & 0xf0 != 0 {
            return Ok((0, Some(byte)));
        }
        if byte != 0 {
            return Err(format!(
                "{INVALID_COMPRESSION}: invalid literal-length byte {byte:#x} at compressed offset {}",
                self.offset - 1
            ));
        }

        let mut total = 0x0f_usize;
        loop {
            let next = self.read_u8()?;
            if next == 0 {
                total += 0xff;
            } else {
                return Ok((total + usize::from(next) + 3, None));
            }
        }
    }

    fn decode_opcode(&mut self, opcode: u8) -> Result<(usize, usize, usize), String> {
        match opcode {
            0x00..=0x0f => Err(self.invalid_opcode(opcode)),
            0x10 => {
                let length = self.read_long_compression_offset()?;
                let (offset, literal) = self.read_two_byte_offset()?;
                Ok((length + 9, offset + 0x3fff, literal))
            }
            0x12..=0x1f => {
                let (offset, literal) = self.read_two_byte_offset()?;
                Ok((usize::from(opcode & 0x0f) + 2, offset + 0x3fff, literal))
            }
            0x20 => {
                let length = self.read_long_compression_offset()?;
                let (offset, literal) = self.read_two_byte_offset()?;
                Ok((length + 0x21, offset, literal))
            }
            0x21..=0x3f => {
                let (offset, literal) = self.read_two_byte_offset()?;
                Ok((usize::from(opcode) - 0x1e, offset, literal))
            }
            0x40..=0xff => {
                let second = self.read_u8()?;
                let literal = usize::from(opcode & 0x03);
                let length = usize::from((opcode & 0xf0) >> 4) - 1;
                let offset = usize::from(second) << 2 | usize::from((opcode & 0x0c) >> 2);
                Ok((length, offset, literal))
            }
            0x11 => unreachable!("terminator handled by caller"),
        }
    }

    fn read_two_byte_offset(&mut self) -> Result<(usize, usize), String> {
        let first = self.read_u8()?;
        let second = self.read_u8()?;

        Ok((
            usize::from(first >> 2) | usize::from(second) << 6,
            usize::from(first & 0x03),
        ))
    }

    fn read_long_compression_offset(&mut self) -> Result<usize, String> {
        let byte = self.read_u8()?;
        if byte != 0 {
            return Ok(usize::from(byte));
        }

        let mut total = 0xff_usize;
        loop {
            let next = self.read_u8()?;
            if next == 0 {
                total += 0xff;
            } else {
                return Ok(total + usize::from(next));
            }
        }
    }

    fn invalid_opcode(&self, opcode: u8) -> String {
        format!(
            "{INVALID_COMPRESSION}: invalid opcode {opcode:#x} at compressed offset {}",
            self.offset.saturating_sub(1)
        )
    }
}

fn copy_from_window(output: &mut Vec<u8>, offset: usize, count: usize) -> Result<(), String> {
    let distance = offset + 1;
    if distance > output.len() {
        return Err(format!(
            "{INVALID_COMPRESSION}: invalid window offset={offset} distance={distance} count={count} out={}",
            output.len()
        ));
    }

    let start = output.len() - distance;
    for index in 0..count {
        output.push(output[start + index]);
    }

    Ok(())
}
#[cfg(test)]
mod tests {
    use super::decompress_r2004_section;

    #[test]
    fn decompresses_literal_runs() {
        let input = [0x02, b'h', b'e', b'l', b'l', b'o', 0x11];

        assert_eq!(decompress_r2004_section(&input, 5).unwrap(), b"hello");
    }

    #[test]
    fn decompresses_overlapping_back_references() {
        // Four literal bytes, followed by a length-three reference to "abc".
        // The decoder must copy one byte at a time because DWG back references
        // may overlap the output currently being appended.
        let input = [0x01, b'a', b'b', b'c', b'd', 0x4c, 0x00, 0x11];
        let result = decompress_r2004_section(&input, 7).unwrap();

        assert_eq!(result, b"abcdabc");
    }

    #[test]
    fn rejects_invalid_back_references() {
        let input = [0xf0, 0x40, 0x01, 0x11];

        assert!(decompress_r2004_section(&input, 3).is_err());
    }
}
