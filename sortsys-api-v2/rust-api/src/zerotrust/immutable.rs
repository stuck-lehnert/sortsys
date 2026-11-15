//! Permanent records are identified by signed public names. Their write lock
//! does not depend on encrypted contents or an external timestamp service.
use super::{
    crypto::invalid,
    objects::SaveInput,
    wire::{Action, EncryptedObject},
};
use crate::error::RpcResult;

pub(super) fn binding(envelope: &EncryptedObject) -> RpcResult<bool> {
    Ok(sortsys_zerotrust::immutable::binding(envelope)?.is_some())
}

pub(super) fn write_action(envelope: &EncryptedObject) -> RpcResult<Option<Action>> {
    sortsys_zerotrust::immutable::write_action(envelope).map_err(Into::into)
}

pub(super) fn validate_packet(input: &SaveInput) -> RpcResult<()> {
    if write_action(&input.envelope)?.is_some()
        && input.domain != format!("{}:{}", input.envelope.scope, input.envelope.facet.name())
    {
        return Err(invalid());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::zerotrust::crypto::sized;
    use serde_json::Value;

    #[test]
    fn browser_vectors_bind_permanent_records_and_reject_all_later_writes() {
        let source: Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/zerotrust-immutable-records.json"
        ))
        .unwrap();
        let signer = sized::<32>(source["signer"].as_str().unwrap()).unwrap();
        for case in source["cases"].as_array().unwrap() {
            let envelope: EncryptedObject =
                serde_json::from_value(case["envelope"].clone()).unwrap();
            envelope.verify(&signer).unwrap();
            if case["action"].is_null() {
                assert!(write_action(&envelope).is_err(), "{}", envelope.object);
                continue;
            }
            let permanent = case["permanent"].as_bool().unwrap();
            assert_eq!(binding(&envelope).unwrap(), permanent);
            assert_eq!(write_action(&envelope).unwrap().is_some(), permanent);
            let input = serde_json::json!({
                "domain": format!("{}:{}", envelope.scope, envelope.facet.name()),
                "messageId": "permanent-vector", "envelope": envelope,
            });
            let mut packet: SaveInput = serde_json::from_value(input).unwrap();
            validate_packet(&packet).unwrap();
            if permanent {
                packet.domain = "alias-domain".into();
                assert!(validate_packet(&packet).is_err());
            }
        }
    }
}
