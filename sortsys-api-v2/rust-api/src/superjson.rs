//! SuperJSON metadata for dates and explicitly typed integer fields.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Value, json};

static ISO_DATE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$")
        .expect("valid ISO date regex")
});

pub fn decode(envelope: Value) -> Value {
    let Some(object) = envelope.as_object() else {
        return Value::Null;
    };
    let mut value = object.get("json").cloned().unwrap_or(Value::Null);
    let undefined_paths = object
        .get("meta")
        .and_then(|meta| meta.get("values"))
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(|values| values.iter())
        .filter(|(_, marker)| marker.get(0).and_then(Value::as_str) == Some("undefined"))
        .map(|(path, _)| path.clone())
        .collect::<Vec<_>>();

    let bigint_paths = object
        .get("meta")
        .and_then(|meta| meta.get("values"))
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(|values| values.iter())
        .filter(|(_, marker)| marker.get(0).and_then(Value::as_str) == Some("bigint"))
        .map(|(path, _)| path.clone())
        .collect::<Vec<_>>();

    for path in undefined_paths {
        if path.is_empty() {
            value = Value::Null;
        } else {
            remove_undefined(&mut value, &path.split('.').collect::<Vec<_>>());
        }
    }

    for path in bigint_paths {
        restore_bigint(&mut value, &path.split('.').collect::<Vec<_>>());
    }
    value
}

fn restore_bigint(value: &mut Value, path: &[&str]) {
    if path.is_empty() {
        let Value::String(text) = value else {
            return;
        };

        if let Ok(number) = text.parse::<i64>() {
            *value = Value::from(number);
        } else if let Ok(number) = text.parse::<u64>() {
            *value = Value::from(number);
        }

        return;
    }

    let Some((head, tail)) = path.split_first() else {
        return;
    };

    match value {
        Value::Object(object) => {
            if let Some(value) = object.get_mut(*head) {
                restore_bigint(value, tail);
            }
        }
        Value::Array(array) => {
            if let Ok(index) = head.parse::<usize>()
                && let Some(value) = array.get_mut(index)
            {
                restore_bigint(value, tail);
            }
        }
        _ => {}
    }
}

fn remove_undefined(value: &mut Value, path: &[&str]) {
    let Some((head, tail)) = path.split_first() else {
        return;
    };
    if tail.is_empty() {
        match value {
            Value::Object(object) => {
                object.remove(*head);
            }
            Value::Array(array) => {
                if let Ok(index) = head.parse::<usize>()
                    && let Some(value) = array.get_mut(index)
                {
                    *value = Value::Null;
                }
            }
            _ => {}
        }
        return;
    }

    match value {
        Value::Object(object) => {
            if let Some(value) = object.get_mut(*head) {
                remove_undefined(value, tail);
            }
        }
        Value::Array(array) => {
            if let Ok(index) = head.parse::<usize>()
                && let Some(value) = array.get_mut(index)
            {
                remove_undefined(value, tail);
            }
        }
        _ => {}
    }
}

pub fn encode(value: Value) -> Value {
    encode_with_undefined(value, Vec::new())
}

pub fn encode_with_undefined(value: Value, undefined_paths: Vec<String>) -> Value {
    let mut value = value;
    let mut metadata = Map::new();
    extract_bigint_metadata(&mut value, "", &mut metadata);
    collect_date_metadata(&value, "", &mut metadata);
    for path in undefined_paths {
        metadata.insert(path, json!(["undefined"]));
    }

    if metadata.is_empty() {
        json!({ "json": value })
    } else {
        json!({
            "json": value,
            "meta": {
                "values": metadata,
                "v": 1,
            },
        })
    }
}

fn extract_bigint_metadata(value: &mut Value, path: &str, metadata: &mut Map<String, Value>) {
    if value.get("$rpcType").and_then(Value::as_str) == Some("bigint")
        && value.as_object().is_some_and(|fields| fields.len() == 2)
        && let Some(text) = value.get("value").and_then(Value::as_str)
        && text
            .parse::<i64>()
            .is_ok_and(|number| number.to_string() == text)
    {
        *value = Value::String(text.into());
        metadata.insert(path.into(), json!(["bigint"]));
        return;
    }
    match value {
        Value::Array(values) => {
            for (index, value) in values.iter_mut().enumerate() {
                extract_bigint_metadata(value, &join_path(path, &index.to_string()), metadata);
            }
        }
        Value::Object(values) => {
            for (key, value) in values {
                extract_bigint_metadata(value, &join_path(path, key), metadata);
            }
        }
        _ => {}
    }
}

/// Opt-in serde fields preserve integer precision through the JSON value used
/// by the RPC registry. Ordinary JSON numbers retain their existing encoding.
pub mod bigint {
    use serde::{Deserialize, Deserializer, Serialize, Serializer, de::Error};
    #[derive(Serialize, Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Tagged {
        #[serde(rename = "$rpcType")]
        kind: String,
        value: String,
    }
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Encoded {
        Number(i64),
        Tagged(Tagged),
    }
    pub fn serialize<S: Serializer>(value: &i64, serializer: S) -> Result<S::Ok, S::Error> {
        Tagged {
            kind: "bigint".into(),
            value: value.to_string(),
        }
        .serialize(serializer)
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<i64, D::Error> {
        match Encoded::deserialize(deserializer)? {
            Encoded::Number(value) => Ok(value),
            Encoded::Tagged(tagged) => {
                let value = tagged.value.parse::<i64>().map_err(D::Error::custom)?;
                if tagged.kind != "bigint" || value.to_string() != tagged.value {
                    return Err(D::Error::custom("Invalid integer encoding"));
                }
                Ok(value)
            }
        }
    }
}

pub mod optional_bigint {
    use serde::{Deserialize, Deserializer, Serializer};
    #[derive(Deserialize)]
    struct Integer(#[serde(with = "super::bigint")] i64);
    pub fn serialize<S: Serializer>(value: &Option<i64>, serializer: S) -> Result<S::Ok, S::Error> {
        match value {
            Some(value) => super::bigint::serialize(value, serializer),
            None => serializer.serialize_none(),
        }
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Option<i64>, D::Error> {
        Ok(Option::<Integer>::deserialize(deserializer)?.map(|value| value.0))
    }
}

fn collect_date_metadata(value: &Value, path: &str, metadata: &mut Map<String, Value>) {
    match value {
        Value::String(text) if ISO_DATE.is_match(text) => {
            metadata.insert(path.to_owned(), json!(["Date"]));
        }
        Value::Array(values) => {
            for (index, value) in values.iter().enumerate() {
                collect_date_metadata(value, &join_path(path, &index.to_string()), metadata);
            }
        }
        Value::Object(values) => {
            for (key, value) in values {
                collect_date_metadata(value, &join_path(path, key), metadata);
            }
        }
        _ => {}
    }
}

fn join_path(parent: &str, child: &str) -> String {
    if parent.is_empty() {
        child.to_owned()
    } else {
        format!("{parent}.{child}")
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn typed_integers_round_trip_without_losing_precision_or_changing_numbers() {
        #[derive(serde::Serialize, serde::Deserialize, Debug, PartialEq)]
        struct Counts {
            #[serde(with = "super::bigint")]
            total: i64,
            #[serde(with = "super::optional_bigint")]
            quota: Option<i64>,
            pages: u32,
        }
        for quota in [None, Some(i64::MIN), Some(42)] {
            let counts = Counts {
                total: i64::MAX,
                quota,
                pages: 3,
            };
            let stored = serde_json::to_value(&counts).unwrap();
            assert_eq!(
                serde_json::from_value::<Counts>(stored.clone()).unwrap(),
                counts
            );
            let wire = super::encode(stored);
            assert_eq!(wire["json"]["total"], i64::MAX.to_string());
            assert_eq!(
                wire["meta"]["values"]["total"],
                serde_json::json!(["bigint"])
            );
            assert_eq!(wire["json"]["pages"], 3);
            assert!(wire["meta"]["values"].get("pages").is_none());
            assert_eq!(
                serde_json::from_value::<Counts>(super::decode(wire)).unwrap(),
                counts
            );
        }
    }
    use serde_json::json;

    use super::{decode, encode};

    #[test]
    fn decodes_root_undefined_as_null_input() {
        let input = json!({
            "json": null,
            "meta": { "values": ["undefined"], "v": 1 },
        });
        assert_eq!(decode(input), json!(null));
    }

    #[test]
    fn removes_nested_object_properties_marked_as_undefined() {
        let input = json!({
            "json": { "keep": 1, "omit": null, "nested": { "omit": null } },
            "meta": {
                "values": { "omit": ["undefined"], "nested.omit": ["undefined"] },
                "v": 1
            },
        });

        assert_eq!(decode(input), json!({ "keep": 1, "nested": {} }));
    }

    #[test]
    fn restores_bigints_marked_by_superjson() {
        let input = json!({
            "json": {
                "sizeBytes": "2645483",
                "nested": [{ "quota": "9007199254740991" }]
            },
            "meta": {
                "values": {
                    "sizeBytes": ["bigint"],
                    "nested.0.quota": ["bigint"]
                },
                "v": 1
            }
        });

        assert_eq!(
            decode(input),
            json!({
                "sizeBytes": 2_645_483_i64,
                "nested": [{ "quota": 9_007_199_254_740_991_i64 }]
            }),
        );
    }

    #[test]
    fn marks_nested_iso_dates() {
        let output = encode(json!({
            "createdAt": "2026-08-25T10:11:12.000Z",
            "label": "not a date",
        }));
        assert_eq!(output["meta"]["values"]["createdAt"], json!(["Date"]),);
    }
}
