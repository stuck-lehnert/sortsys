//! SuperJSON metadata encoding for Date values in RPC responses.

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

    for path in undefined_paths {
        if path.is_empty() {
            value = Value::Null;
        } else {
            remove_undefined(&mut value, &path.split('.').collect::<Vec<_>>());
        }
    }
    value
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
    let mut metadata = Map::new();
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
    fn marks_nested_iso_dates() {
        let output = encode(json!({
            "createdAt": "2026-08-25T10:11:12.000Z",
            "label": "not a date",
        }));
        assert_eq!(output["meta"]["values"]["createdAt"], json!(["Date"]),);
    }
}
