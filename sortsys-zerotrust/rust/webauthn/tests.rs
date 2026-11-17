use super::*;
use p256::ecdsa::{SigningKey, signature::Signer};
use serde_json::json;

struct Fixture {
    origin: Origin,
    challenge: String,
    handle: String,
    key: SigningKey,
    credential: RegistrationCredential,
    auth_data: Vec<u8>,
}
fn cbor_bytes(value: &Cbor) -> Vec<u8> {
    let mut bytes = Vec::new();
    ciborium::ser::into_writer(value, &mut bytes).unwrap();
    bytes
}
fn client_data(kind: &str, challenge: &str, origin: &str) -> String {
    encode(
        &serde_json::to_vec(
            &json!({"type": kind, "challenge": challenge, "origin": origin, "crossOrigin": false}),
        )
        .unwrap(),
    )
}
fn attestation(auth_data: &[u8]) -> String {
    encode(&cbor_bytes(&Cbor::Map(vec![
        (Cbor::Text("fmt".into()), Cbor::Text("none".into())),
        (Cbor::Text("attStmt".into()), Cbor::Map(vec![])),
        (
            Cbor::Text("authData".into()),
            Cbor::Bytes(auth_data.to_vec()),
        ),
    ])))
}
fn fixture() -> Fixture {
    // Synthetic test key, never retained in a production credential record.
    let key = SigningKey::from_slice(&[1; 32]).unwrap();
    let point = key.verifying_key().to_sec1_point(false);
    let cose = Cbor::Map(vec![
        (Cbor::Integer(1.into()), Cbor::Integer(2.into())),
        (Cbor::Integer(3.into()), Cbor::Integer((-7).into())),
        (Cbor::Integer((-1).into()), Cbor::Integer(1.into())),
        (
            Cbor::Integer((-2).into()),
            Cbor::Bytes(point.x().unwrap().to_vec()),
        ),
        (
            Cbor::Integer((-3).into()),
            Cbor::Bytes(point.y().unwrap().to_vec()),
        ),
    ]);
    let id = [7; 32];
    let mut auth_data = Sha256::digest(b"app.example.test").to_vec();
    auth_data.push(PRESENT | VERIFIED | ATTESTED);
    auth_data.extend_from_slice(&0_u32.to_be_bytes());
    auth_data.extend_from_slice(&[0; 16]);
    auth_data.extend_from_slice(&(id.len() as u16).to_be_bytes());
    auth_data.extend_from_slice(&id);
    auth_data.extend_from_slice(&cbor_bytes(&cose));
    let challenge = create_challenge().unwrap();
    Fixture {
        origin: Origin::parse("https://app.example.test").unwrap(),
        handle: routing_user_handle("practice:alpha", b"subject:lee").unwrap(),
        credential: RegistrationCredential {
            id: encode(&id),
            raw_id: encode(&id),
            r#type: "public-key".into(),
            response: RegistrationResponse {
                client_data_json: client_data(
                    "webauthn.create",
                    &challenge,
                    "https://app.example.test",
                ),
                attestation_object: attestation(&auth_data),
            },
            transports: Some(vec!["internal".into()]),
        },
        auth_data,
        key,
        challenge,
    }
}
fn assertion(fixture: &Fixture, flags: u8, counter: u32) -> AuthenticationCredential {
    let mut auth_data = Sha256::digest(fixture.origin.rp_id.as_bytes()).to_vec();
    auth_data.push(flags);
    auth_data.extend_from_slice(&counter.to_be_bytes());
    let client = client_data("webauthn.get", &fixture.challenge, &fixture.origin.value);
    let mut signed = auth_data.clone();
    signed.extend_from_slice(&Sha256::digest(decode(&client, 8192).unwrap()));
    let signature: Signature = fixture.key.sign(&signed);
    AuthenticationCredential {
        id: fixture.credential.id.clone(),
        raw_id: fixture.credential.raw_id.clone(),
        r#type: "public-key".into(),
        response: AuthenticationResponse {
            client_data_json: client,
            authenticator_data: encode(&auth_data),
            signature: encode(signature.to_der().as_bytes()),
            user_handle: Some(fixture.handle.clone()),
        },
    }
}

#[test]
fn verifies_real_es256_registration_and_assertion_without_private_key_storage() {
    let fixture = fixture();
    let registered =
        verify_registration(&fixture.credential, &fixture.challenge, &fixture.origin).unwrap();
    assert_eq!(registered.credential_id, fixture.credential.raw_id);
    let credential = assertion(&fixture, PRESENT | VERIFIED, 1);
    let state = verify_authentication(
        &credential,
        &registered,
        &fixture.challenge,
        &fixture.origin,
        &fixture.handle,
    )
    .unwrap();
    state.follows(&registered.state).unwrap();
    assert_eq!(state.counter, 1);
    assert!(!state.backup_eligible);
}

#[test]
fn requires_exact_origins_ceremonies_challenges_and_local_top_level_use() {
    let fixture = fixture();
    for change in [
        json!({"origin":"https://evil.example.test"}),
        json!({"challenge":create_challenge().unwrap()}),
        json!({"type":"webauthn.get"}),
        json!({"crossOrigin":true}),
        json!({"topOrigin":"https://evil.example.test"}),
    ] {
        let mut credential = fixture.credential.clone();
        let mut data: serde_json::Value =
            serde_json::from_slice(&decode(&credential.response.client_data_json, 8192).unwrap())
                .unwrap();
        for (key, value) in change.as_object().unwrap() {
            data[key] = value.clone();
        }
        credential.response.client_data_json = encode(&serde_json::to_vec(&data).unwrap());
        assert!(verify_registration(&credential, &fixture.challenge, &fixture.origin).is_err());
    }
    for origin in [
        "http://app.example.test",
        "https://user@app.example.test",
        "https://app.example.test/path",
        "https://app.example.test?query",
        "ftp://localhost",
    ] {
        assert!(Origin::parse(origin).is_err());
    }
    assert_eq!(
        Origin::parse("https://app.example.test:443/")
            .unwrap()
            .value,
        fixture.origin.value
    );
    assert!(Origin::parse("http://localhost:5173").is_ok());
}

#[test]
fn rejects_missing_presence_verification_rp_hash_and_invalid_backup_flags() {
    let fixture = fixture();
    for flags in [
        ATTESTED,
        ATTESTED | PRESENT,
        ATTESTED | VERIFIED,
        ATTESTED | PRESENT | VERIFIED | BACKED_UP,
    ] {
        let mut credential = fixture.credential.clone();
        let mut auth_data = fixture.auth_data.clone();
        auth_data[32] = flags;
        credential.response.attestation_object = attestation(&auth_data);
        assert!(verify_registration(&credential, &fixture.challenge, &fixture.origin).is_err());
    }
    let mut credential = fixture.credential.clone();
    let mut auth_data = fixture.auth_data.clone();
    auth_data[0] ^= 1;
    credential.response.attestation_object = attestation(&auth_data);
    assert!(verify_registration(&credential, &fixture.challenge, &fixture.origin).is_err());
}

#[test]
fn rejects_ambiguous_cbor_off_curve_keys_trailing_bytes_and_deep_nesting() {
    let fixture = fixture();
    let cose_start = 55 + 32;
    for mode in ["duplicate", "off-curve", "trailing", "extensions"] {
        let mut auth_data = fixture.auth_data.clone();
        if mode == "trailing" {
            auth_data.push(0);
        } else if mode == "extensions" {
            auth_data[32] |= EXTENSIONS;
        } else {
            let (mut value, _) = cbor(&auth_data[cose_start..]).unwrap();
            let Cbor::Map(entries) = &mut value else {
                unreachable!()
            };
            if mode == "duplicate" {
                entries.push(entries[0].clone());
            } else {
                for (key, value) in entries {
                    if *key == Cbor::Integer((-2).into()) || *key == Cbor::Integer((-3).into()) {
                        *value = Cbor::Bytes(vec![0; 32]);
                    }
                }
            }
            auth_data.truncate(cose_start);
            auth_data.extend_from_slice(&cbor_bytes(&value));
        }
        let mut credential = fixture.credential.clone();
        credential.response.attestation_object = attestation(&auth_data);
        assert!(
            verify_registration(&credential, &fixture.challenge, &fixture.origin).is_err(),
            "{mode}"
        );
    }
    let mut nested = vec![0x81; 40];
    nested.push(0);
    assert!(cbor(&nested).is_err());
    let mut credential = fixture.credential.clone();
    let mut bytes = decode(&credential.response.attestation_object, 32768).unwrap();
    bytes.push(0);
    credential.response.attestation_object = encode(&bytes);
    assert!(verify_registration(&credential, &fixture.challenge, &fixture.origin).is_err());
}

#[test]
fn credential_handles_and_signatures_cannot_be_substituted() {
    let fixture = fixture();
    let registered =
        verify_registration(&fixture.credential, &fixture.challenge, &fixture.origin).unwrap();
    let original = assertion(&fixture, PRESENT | VERIFIED, 1);
    for field in ["id", "signature", "handle", "data"] {
        let mut credential = original.clone();
        match field {
            "id" => credential.id = encode(&[8; 32]),
            "signature" => credential.response.signature = encode(&[0; 70]),
            "handle" => {
                credential.response.user_handle =
                    Some(routing_user_handle("other:tenant", b"subject:lee").unwrap())
            }
            "data" => {
                let mut bytes = decode(&credential.response.authenticator_data, 16384).unwrap();
                bytes[36] ^= 1;
                credential.response.authenticator_data = encode(&bytes);
            }
            _ => unreachable!(),
        }
        assert!(
            verify_authentication(
                &credential,
                &registered,
                &fixture.challenge,
                &fixture.origin,
                &fixture.handle
            )
            .is_err()
        );
    }
    let mut invalid = fixture.credential.clone();
    invalid.raw_id.push('=');
    invalid.id = invalid.raw_id.clone();
    assert!(verify_registration(&invalid, &fixture.challenge, &fixture.origin).is_err());
}

#[test]
fn synchronized_zero_counters_still_require_a_separate_atomic_replay_guard() {
    let zero = AuthenticatorState {
        counter: 0,
        backup_eligible: true,
        backed_up: true,
    };
    zero.follows(&zero).unwrap();
    let advanced = AuthenticatorState { counter: 4, ..zero };
    advanced.follows(&zero).unwrap();
    assert!(zero.follows(&advanced).is_err());
    assert!(advanced.follows(&advanced).is_err());
    assert!(
        AuthenticatorState {
            backup_eligible: false,
            ..advanced
        }
        .follows(&zero)
        .is_err()
    );
}

#[test]
fn user_handle_routing_preserves_long_tenant_names_and_opaque_subject_boundaries() {
    let tenant = "a".repeat(63);
    let handle = routing_user_handle(&tenant, &[3; 31]).unwrap();
    assert_eq!(decode(&handle, 64).unwrap().len(), 64);
    let (fingerprint, subject) = parse_routing_user_handle(&handle).unwrap();
    assert_eq!(fingerprint, tenant_fingerprint(&tenant).unwrap());
    assert_eq!(subject, [3; 31]);
    assert_ne!(fingerprint, tenant_fingerprint("other").unwrap());
    assert!(routing_user_handle(&tenant, &[]).is_err());
    assert!(routing_user_handle(&tenant, &[3; 32]).is_err());
    assert!(parse_routing_user_handle(&encode(&[0; 41])).is_err());
}
