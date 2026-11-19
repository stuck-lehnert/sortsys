//! Conversion of generated TypeScript contracts into JSON Schema.
//!
//! The generated contract is the one source of truth shared with the web client.
//! Parsing it here avoids maintaining a second, gradually diverging schema just
//! for LLM tools and lets us validate proposed inputs before they reach a user.

use serde_json::{Map, Value, json};

#[derive(Debug, Clone)]
enum ContractType {
    Any,
    Undefined,
    Null,
    Boolean,
    Number,
    String,
    Date,
    Literal(Value),
    Array(Box<ContractType>),
    Object(Vec<Field>),
    Record(Box<ContractType>),
    Union(Vec<ContractType>),
}

#[derive(Debug, Clone)]
struct Field {
    name: String,
    optional: bool,
    value_type: ContractType,
}

type Aliases<'a> = dyn Fn(&str) -> Option<&'a str> + 'a;

pub fn json_schema<'a>(source: &'a str, aliases: &'a Aliases<'a>) -> Result<Value, String> {
    Ok(Parser::parse(source, aliases, 0)?.to_json_schema())
}

struct Parser<'a> {
    source: &'a str,
    offset: usize,
    aliases: &'a Aliases<'a>,
    alias_depth: usize,
}

impl<'a> Parser<'a> {
    fn parse(
        source: &'a str,
        aliases: &'a Aliases<'a>,
        alias_depth: usize,
    ) -> Result<ContractType, String> {
        let mut parser = Self {
            source,
            offset: 0,
            aliases,
            alias_depth,
        };
        let value_type = parser.parse_union()?;

        parser.skip_whitespace();
        if !parser.is_finished() {
            return Err(parser.error("unexpected trailing input"));
        }

        Ok(value_type)
    }

    fn parse_union(&mut self) -> Result<ContractType, String> {
        let mut members = vec![self.parse_postfix()?];

        loop {
            self.skip_whitespace();
            if !self.consume('|') {
                break;
            }

            members.push(self.parse_postfix()?);
        }

        if members.len() == 1 {
            Ok(members.pop().expect("the union has one member"))
        } else {
            Ok(ContractType::Union(members))
        }
    }

    fn parse_postfix(&mut self) -> Result<ContractType, String> {
        let mut value_type = self.parse_primary()?;

        loop {
            self.skip_whitespace();
            if !self.consume('[') {
                break;
            }

            self.expect(']')?;
            value_type = ContractType::Array(Box::new(value_type));
        }

        Ok(value_type)
    }

    fn parse_primary(&mut self) -> Result<ContractType, String> {
        self.skip_whitespace();

        if self.consume('{') {
            if self.consume_after_whitespace('[') {
                return self.parse_mapped_record();
            }
            return self.parse_object();
        }

        if self.consume('(') {
            let value_type = self.parse_union()?;
            self.expect(')')?;
            return Ok(value_type);
        }

        if matches!(self.peek(), Some('"' | '\'')) {
            return Ok(ContractType::Literal(Value::String(
                self.parse_quoted_string()?,
            )));
        }

        let identifier = self.parse_identifier()?;
        match identifier.as_str() {
            // The generated JSON value alias is recursive and permits any JSON value.
            "any" | "unknown" | "JsonValue" => Ok(ContractType::Any),
            "undefined" | "void" => Ok(ContractType::Undefined),
            "null" => Ok(ContractType::Null),
            "boolean" => Ok(ContractType::Boolean),
            "number" => Ok(ContractType::Number),
            "string" | "bigint" => Ok(ContractType::String),
            "Date" => Ok(ContractType::Date),
            "true" => Ok(ContractType::Literal(Value::Bool(true))),
            "false" => Ok(ContractType::Literal(Value::Bool(false))),
            "Record" => self.parse_record(),
            "Array" => {
                self.expect('<')?;
                let items = self.parse_union()?;
                self.expect('>')?;
                Ok(ContractType::Array(Box::new(items)))
            }
            _ => {
                let source = (self.aliases)(&identifier)
                    .ok_or_else(|| self.error(format!("unsupported type {identifier}")))?;
                if self.alias_depth >= 24 {
                    return Err(
                        self.error(format!("type alias expansion is too deep at {identifier}"))
                    );
                }
                Self::parse(source, self.aliases, self.alias_depth + 1)
            }
        }
    }

    fn parse_object(&mut self) -> Result<ContractType, String> {
        let mut fields = Vec::new();

        loop {
            self.skip_whitespace();
            if self.consume('}') {
                break;
            }

            let name = if matches!(self.peek(), Some('"' | '\'')) {
                self.parse_quoted_string()?
            } else {
                self.parse_identifier()?
            };
            let optional = self.consume_after_whitespace('?');

            self.expect(':')?;
            let mut value_type = self.parse_union()?;

            // Several legacy inputs deliberately use `unknown` because their
            // custom deserializer accepts offset-bearing ISO timestamps. The
            // property name still gives us an unambiguous wire representation.
            if matches!(value_type, ContractType::Any) && is_date_field(&name) {
                value_type = ContractType::Date;
            }

            self.field_separator()?;
            fields.push(Field {
                name,
                optional,
                value_type,
            });
        }

        Ok(ContractType::Object(fields))
    }

    fn field_separator(&mut self) -> Result<(), String> {
        self.skip_whitespace();
        if self.consume(';') || self.consume(',') || self.peek() == Some('}') {
            Ok(())
        } else {
            Err(self.error("expected a field separator or closing brace"))
        }
    }

    fn parse_mapped_record(&mut self) -> Result<ContractType, String> {
        self.parse_identifier()?;
        if self.parse_identifier()? != "in" || self.parse_identifier()? != "string" {
            return Err(self.error("only string-keyed mapped records are supported"));
        }
        self.expect(']')?;
        self.consume_after_whitespace('?');
        self.expect(':')?;
        let value_type = self.parse_union()?;
        self.field_separator()?;
        self.expect('}')?;
        Ok(ContractType::Record(Box::new(value_type)))
    }

    fn parse_record(&mut self) -> Result<ContractType, String> {
        self.expect('<')?;
        let key_type = self.parse_identifier()?;
        if key_type != "string" {
            return Err(self.error("only string-keyed records are supported"));
        }

        self.expect(',')?;
        let value_type = self.parse_union()?;
        self.expect('>')?;

        Ok(ContractType::Record(Box::new(value_type)))
    }

    fn parse_identifier(&mut self) -> Result<String, String> {
        self.skip_whitespace();
        let start = self.offset;

        while self.peek().is_some_and(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '_' | '$')
        }) {
            self.advance();
        }

        if start == self.offset {
            Err(self.error("expected an identifier"))
        } else {
            Ok(self.source[start..self.offset].to_owned())
        }
    }

    fn parse_quoted_string(&mut self) -> Result<String, String> {
        let quote = self
            .advance()
            .ok_or_else(|| self.error("missing opening quote"))?;
        let mut result = String::new();

        loop {
            let Some(character) = self.advance() else {
                return Err(self.error("unterminated string literal"));
            };

            match character {
                closing if closing == quote => return Ok(result),
                '\\' => {
                    let escaped = self
                        .advance()
                        .ok_or_else(|| self.error("unterminated string escape"))?;
                    result.push(escaped);
                }
                _ => result.push(character),
            }
        }
    }

    fn expect(&mut self, expected: char) -> Result<(), String> {
        self.skip_whitespace();
        if self.consume(expected) {
            Ok(())
        } else {
            Err(self.error(format!("expected {expected:?}")))
        }
    }

    fn consume_after_whitespace(&mut self, expected: char) -> bool {
        self.skip_whitespace();
        self.consume(expected)
    }

    fn consume(&mut self, expected: char) -> bool {
        if self.peek() == Some(expected) {
            self.advance();
            true
        } else {
            false
        }
    }

    fn skip_whitespace(&mut self) {
        while self.peek().is_some_and(char::is_whitespace) {
            self.advance();
        }
    }

    fn peek(&self) -> Option<char> {
        self.source[self.offset..].chars().next()
    }

    fn advance(&mut self) -> Option<char> {
        let character = self.peek()?;
        self.offset += character.len_utf8();
        Some(character)
    }

    fn is_finished(&self) -> bool {
        self.offset == self.source.len()
    }

    fn error(&self, message: impl std::fmt::Display) -> String {
        format!("{message} at contract offset {}", self.offset)
    }
}

impl ContractType {
    fn to_json_schema(&self) -> Value {
        match self {
            Self::Any | Self::Undefined => json!({}),
            Self::Null => json!({ "type": "null" }),
            Self::Boolean => json!({ "type": "boolean" }),
            Self::Number => json!({ "type": "number" }),
            Self::String => json!({ "type": "string" }),
            Self::Date => json!({
                "type": "string",
                "format": "date-time",
                "description": "ISO 8601 timestamp including its timezone offset"
            }),
            Self::Literal(value) => json!({ "const": value }),
            Self::Array(items) => json!({
                "type": "array",
                "items": items.to_json_schema()
            }),
            Self::Record(values) => json!({
                "type": "object",
                "additionalProperties": values.to_json_schema()
            }),
            Self::Object(fields) => object_json_schema(fields),
            Self::Union(members) => union_json_schema(members),
        }
    }
}

fn object_json_schema(fields: &[Field]) -> Value {
    let mut properties = Map::new();
    let mut required = Vec::new();

    for field in fields {
        properties.insert(field.name.clone(), field.value_type.to_json_schema());

        if !field.optional {
            required.push(Value::String(field.name.clone()));
        }
    }

    let mut schema = Map::from_iter([
        ("type".to_owned(), Value::String("object".to_owned())),
        ("properties".to_owned(), Value::Object(properties)),
        ("additionalProperties".to_owned(), Value::Bool(false)),
    ]);

    if !required.is_empty() {
        schema.insert("required".to_owned(), Value::Array(required));
    }

    Value::Object(schema)
}

fn union_json_schema(members: &[ContractType]) -> Value {
    let schemas = members
        .iter()
        .filter(|member| !matches!(member, ContractType::Undefined))
        .map(ContractType::to_json_schema)
        .collect::<Vec<_>>();

    match schemas.as_slice() {
        [] => json!({}),
        [schema] => schema.clone(),
        _ => json!({ "anyOf": schemas }),
    }
}

fn is_date_field(name: &str) -> bool {
    matches!(
        name,
        "day"
            | "from"
            | "to"
            | "timestamp"
            | "effectiveTimestamp"
            | "orderReceivedAt"
            | "startedBefore"
            | "startedAfter"
            | "endedBefore"
            | "endedAfter"
    )
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::json_schema;

    #[test]
    fn nested_objects_remain_objects_in_json_schema() {
        let schema = json_schema(
            "{ title: string; address?: undefined | null | { city: string; streetAddress: string; }; }",
            &|_| None,
        )
        .unwrap();

        assert_eq!(schema["required"], json!(["title"]));
        assert_eq!(
            schema["properties"]["address"]["anyOf"][1]["type"],
            "object"
        );
        assert_eq!(
            schema["properties"]["address"]["anyOf"][1]["required"],
            json!(["city", "streetAddress"])
        );
    }

    #[test]
    fn offset_bearing_dates_are_described_as_iso_strings() {
        let schema = json_schema("{ from: unknown; to: unknown; }", &|_| None).unwrap();

        assert_eq!(schema["properties"]["from"]["format"], "date-time");
        assert!(
            schema["properties"]["from"]["description"]
                .as_str()
                .unwrap()
                .contains("timezone offset")
        );
    }
}
