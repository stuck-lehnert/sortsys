//! Public base-32 identifiers and their serde/TypeScript representation.

use serde::{Deserialize, Deserializer, Serialize, Serializer, de};
use sqlx::Type;
use ts_rs::TS;

const RADIX: i64 = 32;

/// Database identifier represented as the lowercase base-32 string used by the
/// existing HTTP API. Keeping the conversion at the serde boundary prevents
/// database decimal IDs from leaking onto the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Type, TS)]
#[sqlx(transparent)]
#[ts(type = "string")]
pub struct Id(pub i64);

impl Id {
    pub fn decode(value: &str) -> Result<Self, DecodeError> {
        if value.is_empty() {
            return Err(DecodeError);
        }

        let mut result = 0_i64;
        for byte in value.bytes() {
            let digit = match byte {
                b'0'..=b'9' => i64::from(byte - b'0'),
                b'a'..=b'v' => i64::from(byte - b'a') + 10,
                b'A'..=b'V' => i64::from(byte - b'A') + 10,
                _ => return Err(DecodeError),
            };
            result = result
                .checked_mul(RADIX)
                .and_then(|current| current.checked_add(digit))
                .ok_or(DecodeError)?;
        }
        Ok(Self(result))
    }

    pub fn encode(self) -> String {
        if self.0 == 0 {
            return "0".to_owned();
        }

        let mut value = self.0;
        let mut encoded = Vec::new();
        while value > 0 {
            let digit = (value % RADIX) as u8;
            encoded.push(if digit < 10 {
                b'0' + digit
            } else {
                b'a' + digit - 10
            });
            value /= RADIX;
        }
        encoded.reverse();
        String::from_utf8(encoded).expect("base-32 is ASCII")
    }
}

impl Serialize for Id {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.encode())
    }
}

impl<'de> Deserialize<'de> for Id {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        Self::decode(&value).map_err(|_| de::Error::custom("invalid base-32 identifier"))
    }
}

#[derive(Debug, thiserror::Error)]
#[error("invalid base-32 identifier")]
pub struct DecodeError;

#[cfg(test)]
mod tests {
    use super::Id;

    #[test]
    fn matches_the_legacy_base_32_codec() {
        for (encoded, decoded) in [("0", 0), ("v", 31), ("10", 32), ("7dbfi", 7_777_778)] {
            assert_eq!(Id::decode(encoded).unwrap(), Id(decoded));
            assert_eq!(Id(decoded).encode(), encoded);
        }
        assert_eq!(Id::decode("7DBFI").unwrap(), Id(7_777_778));
    }

    #[test]
    fn rejects_invalid_or_overflowing_identifiers() {
        assert!(Id::decode("").is_err());
        assert!(Id::decode("w").is_err());
        assert!(Id::decode("zzzzzzzzzzzzzzzzzzzzzz").is_err());
    }

    #[test]
    fn serde_uses_strings() {
        assert_eq!(serde_json::to_value(Id(32)).unwrap(), "10");
        assert_eq!(serde_json::from_str::<Id>("\"10\"").unwrap(), Id(32));
    }
}
