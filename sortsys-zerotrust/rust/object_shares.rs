//! Recipient envelopes for one exact ciphertext, without sharing its area key.
use crate::{
    Result,
    crypto::{decode, encode, frame, identifier, invalid, packet_hash, revision},
    protocol::{EncryptedObject, IdentityCertificate, SealedBox},
};
use sha2::{Digest, Sha256};

pub fn recipient_binding(
    recipient: Option<&IdentityCertificate>,
    envelope: Option<&SealedBox>,
) -> Result<String> {
    let packets = match (recipient, envelope) {
        (None, None) => Vec::new(),
        (Some(recipient), Some(envelope)) => {
            if envelope.purpose != "object-key"
                || envelope.recipient != recipient.user
                || envelope.tenant != recipient.tenant
                || envelope.generation != recipient.generation
                || decode(&envelope.ciphertext, 48)?.len() != 48
            {
                return Err(invalid());
            }
            vec![
                packet_hash(&recipient.frame()?, &recipient.signature)?,
                packet_hash(&envelope.frame()?, &envelope.signature)?,
            ]
        }
        _ => return Err(invalid()),
    };
    let fields = packets.iter().map(String::as_str).collect::<Vec<_>>();
    Ok(encode(&Sha256::digest(frame(
        "sortsys/object-key-recipient/v1",
        &fields,
    ))))
}

pub struct ObjectShareContext<'a> {
    pub authority_generation: &'a str,
    pub recipient: &'a str,
    pub author: &'a str,
}

pub fn binding<F: AsRef<str>>(object: &EncryptedObject<F>) -> Result<String> {
    if object.is_tombstone() {
        return Err(invalid());
    }
    Ok(format!("object-key:{}", object.packet_hash()?))
}

/// Permission, recipient certification, current-version checks and revocation
/// belong to the host's atomic storage transaction. No plaintext is needed.
pub fn verify<F: AsRef<str>>(
    envelope: &SealedBox,
    object: &EncryptedObject<F>,
    expected: &ObjectShareContext<'_>,
    object_signer: &[u8],
    grant_signer: &[u8],
) -> Result<()> {
    revision(expected.authority_generation)?;
    identifier(expected.recipient)?;
    identifier(expected.author)?;
    object.verify(object_signer)?;
    if envelope.tenant != object.tenant
        || envelope.purpose != "object-key"
        || envelope.object != binding(object)?
        || envelope.generation != expected.authority_generation
        || envelope.recipient != expected.recipient
        || envelope.author != expected.author
        || decode(&envelope.ciphertext, 48)?.len() != 48
    {
        return Err(invalid());
    }
    envelope.verify(grant_signer)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::{encode, sized};
    use serde_json::{Value, json};

    #[test]
    fn browser_object_key_shares_bind_the_source_recipient_issuer_and_epoch() {
        let vector: Value =
            serde_json::from_str(include_str!("../test/fixtures/object-shares.json")).unwrap();
        let object: EncryptedObject = serde_json::from_value(vector["source"].clone()).unwrap();
        let envelope: SealedBox = serde_json::from_value(vector["share"].clone()).unwrap();
        let writer = sized::<32>(vector["sourceSigner"].as_str().unwrap()).unwrap();
        let manager = sized::<32>(vector["grantSigner"].as_str().unwrap()).unwrap();
        let context = ObjectShareContext {
            authority_generation: "3",
            recipient: "patient:recipient",
            author: "doctor:manager",
        };
        verify(&envelope, &object, &context, &writer, &manager).unwrap();
        assert_eq!(envelope.object, binding(&object).unwrap());
        let recipient: IdentityCertificate =
            serde_json::from_value(vector["recipientCertificate"].clone()).unwrap();
        recipient
            .verify(&sized::<32>(vector["authority"].as_str().unwrap()).unwrap())
            .unwrap();
        assert_eq!(
            recipient_binding(Some(&recipient), Some(&envelope)).unwrap(),
            vector["recipientBinding"].as_str().unwrap()
        );
        assert_eq!(
            recipient_binding(None, None).unwrap(),
            vector["emptyBinding"].as_str().unwrap()
        );
        assert_ne!(
            recipient_binding(None, None).unwrap(),
            vector["recipientBinding"].as_str().unwrap()
        );
        assert!(recipient_binding(None, Some(&envelope)).is_err());
        assert!(recipient_binding(Some(&recipient), None).is_err());
        assert_ne!(object.generation, context.authority_generation);
        assert_ne!(object.author, context.author);
        for different in vector["differentObjects"].as_array().unwrap() {
            let different: EncryptedObject = serde_json::from_value(different.clone()).unwrap();
            different.verify(&writer).unwrap();
            assert!(verify(&envelope, &different, &context, &writer, &manager).is_err());
        }
        for (field, value) in [
            ("tenant", json!("practice:other")),
            ("scope", json!("calendar:other")),
            ("facet", json!("research-notes")),
            ("object", json!("appointment:18")),
            ("revision", json!("5")),
            ("generation", json!("8")),
            ("policyVersion", json!("13")),
            ("author", json!("doctor:other")),
            ("nonce", json!(encode(&[0; 12]))),
            ("wrappedKey", json!(encode(&[0; 40]))),
            ("ciphertext", json!(encode(&[0; 32]))),
            ("signature", json!(encode(&[0; 64]))),
        ] {
            let mut changed = vector["source"].clone();
            changed[field] = value;
            let changed: EncryptedObject = serde_json::from_value(changed).unwrap();
            assert!(
                verify(&envelope, &changed, &context, &writer, &manager).is_err(),
                "{field}"
            );
        }
        for (field, value) in [
            ("tenant", json!("practice:other")),
            ("purpose", json!("area-key")),
            ("object", json!("object-key:other")),
            ("generation", json!("4")),
            ("recipient", json!("patient:other")),
            ("author", json!("doctor:other")),
            ("enc", json!(encode(&[0; 32]))),
            ("ciphertext", json!(encode(&[0; 48]))),
            ("signature", json!(encode(&[0; 64]))),
        ] {
            let mut changed = vector["share"].clone();
            changed[field] = value;
            let changed: SealedBox = serde_json::from_value(changed).unwrap();
            assert!(
                verify(&changed, &object, &context, &writer, &manager).is_err(),
                "{field}"
            );
        }
        assert!(verify(&envelope, &object, &context, &manager, &manager).is_err());
        assert!(verify(&envelope, &object, &context, &writer, &writer).is_err());
        for malformed in vector["malformedKeys"].as_array().unwrap() {
            let malformed: SealedBox = serde_json::from_value(malformed.clone()).unwrap();
            malformed.verify(&manager).unwrap();
            assert!(verify(&malformed, &object, &context, &writer, &manager).is_err());
        }
        for context in [
            ObjectShareContext {
                authority_generation: "4",
                ..context
            },
            ObjectShareContext {
                recipient: "patient:other",
                ..context
            },
            ObjectShareContext {
                author: "doctor:other",
                ..context
            },
        ] {
            assert!(verify(&envelope, &object, &context, &writer, &manager).is_err());
        }
        let mut deleted = object;
        deleted.format = "sortsys-object-tombstone-v1".into();
        deleted.ciphertext = encode(&[0; 16]);
        assert!(binding(&deleted).is_err());
    }
}
