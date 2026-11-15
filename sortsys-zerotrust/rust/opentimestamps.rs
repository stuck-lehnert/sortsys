//! Bounded OTS wire validation, not a Bitcoin consensus verifier. Stored proofs
//! are evidence candidates; neither their presence nor their absence grants edits.
use super::crypto::invalid;
use crate::Result;
pub const MAX_BYTES: usize = 262144;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProofSummary {
    pub has_pending_attestations: bool,
}
const MAGIC: &[u8] = b"\x00OpenTimestamps\x00\x00Proof\x00\xbf\x89\xe2\xe8\x84\xe8\x92\x94";
const PENDING: &[u8] = &[0x83, 0xdf, 0xe3, 0x0d, 0x2e, 0xf9, 0x0c, 0x8e];
const BITCOIN: &[u8] = &[0x05, 0x88, 0x96, 0x0d, 0x73, 0xd7, 0x19, 0x01];
struct Reader<'a> {
    bytes: &'a [u8],
    offset: usize,
    budget: usize,
}
impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8]> {
        let end = self.offset.checked_add(n).ok_or_else(invalid)?;
        let result = self.bytes.get(self.offset..end).ok_or_else(invalid)?;
        self.offset = end;
        Ok(result)
    }
    fn byte(&mut self) -> Result<u8> {
        Ok(self.take(1)?[0])
    }
    fn uint(&mut self) -> Result<u64> {
        let mut value = 0u64;
        for i in 0..8 {
            let byte = self.byte()?;
            value |= u64::from(byte & 127) << (i * 7);
            if value > 9007199254740991 {
                return Err(invalid());
            }
            if byte & 128 == 0 {
                if i > 0 && byte == 0 {
                    return Err(invalid());
                }
                return Ok(value);
            }
        }
        Err(invalid())
    }
    fn variable(&mut self, min: usize, max: usize) -> Result<&'a [u8]> {
        let n = self.uint()? as usize;
        if n < min || n > max {
            return Err(invalid());
        }
        self.take(n)
    }
    fn count(&mut self) -> Result<()> {
        self.budget += 1;
        if self.budget > 4096 {
            return Err(invalid());
        }
        Ok(())
    }
    fn node(&mut self, length: usize, depth: usize) -> Result<bool> {
        if depth > 128 || length > 4096 {
            return Err(invalid());
        }
        self.count()?;
        let mut pending = false;
        loop {
            let mut op = self.byte()?;
            let fork = op == 255;
            if fork {
                op = self.byte()?;
            }
            if op == 0 {
                self.count()?;
                let tag = self.take(8)?;
                let payload = self.variable(0, 8192)?;
                let mut inner = Reader {
                    bytes: payload,
                    offset: 0,
                    budget: 0,
                };
                if tag == PENDING {
                    let uri = inner.variable(0, 1000)?;
                    if uri
                        .iter()
                        .any(|b| !b.is_ascii_alphanumeric() && !b"-._/:".contains(b))
                    {
                        return Err(invalid());
                    }
                    pending = true;
                } else if tag == BITCOIN {
                    if length != 32 {
                        return Err(invalid());
                    }
                    inner.uint()?;
                } else {
                    inner.offset = payload.len();
                }
                if inner.offset != payload.len() {
                    return Err(invalid());
                }
            } else {
                let next = match op {
                    2 | 3 => 20,
                    8 => 32,
                    240 | 241 => length
                        .checked_add(self.variable(1, 4096)?.len())
                        .ok_or_else(invalid)?,
                    242 if length > 0 => length,
                    243 if length > 0 => length * 2,
                    _ => return Err(invalid()),
                };
                pending |= self.node(next, depth + 1)?;
            }
            if !fork {
                return Ok(pending);
            }
        }
    }
}
/// Checks root binding, canonical framing, operation lengths and resource
/// bounds. A Bitcoin attestation remains unverified without a canonical block.
pub fn inspect(bytes: &[u8], digest: &[u8; 32]) -> Result<ProofSummary> {
    if bytes.len() > MAX_BYTES {
        return Err(invalid());
    }
    let mut reader = Reader {
        bytes,
        offset: 0,
        budget: 0,
    };
    if reader.take(MAGIC.len())? != MAGIC
        || reader.uint()? != 1
        || reader.byte()? != 8
        || reader.take(32)? != digest
    {
        return Err(invalid());
    }
    let pending = reader.node(32, 0)?;
    if reader.offset != bytes.len() {
        return Err(invalid());
    }
    Ok(ProofSummary {
        has_pending_attestations: pending,
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn official_upstream_proofs_pass_structural_and_root_validation() {
        use base64::{Engine as _, engine::general_purpose::STANDARD};
        let source: serde_json::Value =
            serde_json::from_str(include_str!("../test/fixtures/opentimestamps.json")).unwrap();
        for entry in source["files"].as_array().unwrap() {
            let proof = STANDARD.decode(entry["proof"].as_str().unwrap()).unwrap();
            let hex = entry["digest"].as_str().unwrap();
            let digest: Vec<u8> = (0..hex.len())
                .step_by(2)
                .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
                .collect();
            inspect(&proof, &digest.try_into().unwrap()).unwrap();
        }
    }
    #[test]
    fn bound_root_null_and_truncated_proofs_cannot_be_accepted() {
        let mut bytes = MAGIC.to_vec();
        bytes.extend([1, 8]);
        bytes.extend([7; 32]);
        bytes.push(0);
        bytes.extend(BITCOIN);
        bytes.extend([1, 1]);
        assert!(!inspect(&bytes, &[7; 32]).unwrap().has_pending_attestations);
        assert!(inspect(&bytes, &[8; 32]).is_err());
        for end in 0..bytes.len() {
            assert!(inspect(&bytes[..end], &[7; 32]).is_err());
        }
        bytes.push(0);
        assert!(inspect(&bytes, &[7; 32]).is_err());
    }
    #[test]
    fn bounded_forks_and_noncanonical_integers_are_rejected() {
        let header = [MAGIC, &[1, 8], &[7; 32]].concat();
        for tree in [
            vec![8; 130],
            vec![240, 0],
            vec![255; 5000],
            vec![0; 300000],
            vec![0, 5, 136, 150, 13, 115, 215, 25, 1, 2, 129, 0],
        ] {
            assert!(inspect(&[header.clone(), tree].concat(), &[7; 32]).is_err());
        }
        let mut tree = vec![0];
        tree.extend(PENDING);
        tree.extend([3, 2, b'a', b'b']);
        assert!(
            inspect(&[header, tree].concat(), &[7; 32])
                .unwrap()
                .has_pending_attestations
        );
    }
}
