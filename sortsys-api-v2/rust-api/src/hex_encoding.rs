const DIGITS: &[u8; 16] = b"0123456789abcdef";

pub(crate) fn encode(bytes: impl AsRef<[u8]>) -> String {
    let bytes = bytes.as_ref();
    let mut output = String::with_capacity(bytes.len() * 2);
    for &byte in bytes {
        output.push(char::from(DIGITS[usize::from(byte >> 4)]));
        output.push(char::from(DIGITS[usize::from(byte & 0x0f)]));
    }
    output
}

#[cfg(test)]
mod tests {
    use super::encode;

    #[test]
    fn encodes_empty_input() {
        assert_eq!(encode([]), "");
    }

    #[test]
    fn preserves_leading_zeroes_and_lowercase_digits() {
        assert_eq!(
            encode([0, 1, 15, 16, 127, 128, 254, 255]),
            "00010f107f80feff"
        );
        assert_eq!(encode(b"sortsys"), "736f7274737973");
    }

    #[test]
    fn matches_standard_formatting_for_every_byte() {
        let input: Vec<u8> = (0..=255).collect();
        let expected: String = input.iter().map(|byte| format!("{byte:02x}")).collect();
        assert_eq!(encode(input), expected);
    }
}
