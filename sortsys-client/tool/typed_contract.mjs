import crypto from "node:crypto";

const primitives = new Map([
  ["string", ["String", "rpcString"]],
  ["number", ["num", "rpcNumber"]],
  ["boolean", ["bool", "rpcBoolean"]],
  ["bigint", ["BigInt", "rpcBigInt"]],
  ["date", ["DateTime", "rpcDate"]],
  ["unknown", ["Object?", "rpcUnknown"]],
  ["null", ["Null", "rpcNull"]],
  ["undefined", ["RpcUndefined", "rpcUndefinedCodec"]],
]);

const reserved = new Set([
  "abstract",
  "as",
  "assert",
  "async",
  "await",
  "base",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "covariant",
  "default",
  "deferred",
  "do",
  "dynamic",
  "else",
  "enum",
  "export",
  "extends",
  "extension",
  "external",
  "factory",
  "false",
  "final",
  "finally",
  "for",
  "Function",
  "get",
  "hide",
  "if",
  "implements",
  "import",
  "in",
  "interface",
  "is",
  "late",
  "library",
  "mixin",
  "new",
  "null",
  "of",
  "on",
  "operator",
  "part",
  "required",
  "rethrow",
  "return",
  "sealed",
  "set",
  "show",
  "static",
  "super",
  "switch",
  "sync",
  "this",
  "throw",
  "true",
  "try",
  "typedef",
  "var",
  "void",
  "when",
  "while",
  "with",
  "yield",
  "codec",
  "fromWire",
  "toWire",
  "wireValue",
]);

const resourceNames = new Map([
  ["auth.sessionInfo", "SessionInfo"],
  ["projects.get", "Project"],
  ["products.get", "Product"],
  ["tools.get", "Tool"],
  ["users.get", "User"],
  ["customers.get", "Customer"],
  ["contacts.get", "Contact"],
  ["products.vendors.get", "ProductVendor"],
  ["deliveryNotes.get", "DeliveryNote"],
  ["regieReports.get", "RegieReport"],
  ["projects.deployments.list", "Deployment"],
  ["personalization.activity.list", "ResourceActivity"],
]);

function quote(value) {
  return JSON.stringify(value).replaceAll("$", "\\$");
}

function signature(shape) {
  if (Array.isArray(shape)) {
    return `[${shape.map(signature).join(",")}]`;
  }

  if (shape !== null && typeof shape === "object") {
    const fields = Object.keys(shape)
      .sort()
      .map((key) => {
        return `${JSON.stringify(key)}:${signature(shape[key])}`;
      });

    return `{${fields.join(",")}}`;
  }

  return JSON.stringify(shape);
}

function pascal(value) {
  const words = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  const result = words
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join("");

  if (!result) {
    return "Value";
  }

  if (/^[0-9]/.test(result)) {
    return `Value${result}`;
  }

  return result;
}

function member(value) {
  const name = pascal(value);
  const lower = name[0].toLowerCase() + name.slice(1);

  if (reserved.has(lower)) {
    return `${lower}Value`;
  }

  return lower;
}

function variants(shape) {
  const expanded = [];

  for (const variant of shape.variants) {
    if (variant.kind === "union") {
      expanded.push(...variants(variant));
    } else {
      expanded.push(variant);
    }
  }

  return [
    ...new Map(
      expanded.map((variant) => [signature(variant), variant]),
    ).values(),
  ];
}

function withoutUndefined(shape) {
  if (shape.kind !== "union") {
    return shape;
  }

  const values = variants(shape).filter((value) => value.kind !== "undefined");

  if (values.length === 1) {
    return values[0];
  }

  return { kind: "union", variants: values };
}

function enumShape(shape) {
  return (
    shape.kind === "union" &&
    variants(shape).every((variant) => {
      return variant.kind === "literal" && typeof variant.value === "string";
    })
  );
}

function walk(shape, visit) {
  visit(shape);

  if (shape.kind === "object") {
    for (const field of Object.values(shape.fields)) {
      walk(field.type, visit);
    }
  } else if (shape.kind === "array" || shape.kind === "record") {
    walk(shape.item, visit);
  } else if (shape.kind === "union") {
    for (const variant of shape.variants) {
      walk(variant, visit);
    }
  }
}

class DartTypes {
  constructor(catalog) {
    this.catalog = catalog;
    this.definitions = [];
    this.byShape = new Map();
    this.named = new Map();
    this.names = new Set();
    this.aliases = new Map();

    for (const [name, shape] of Object.entries(catalog.types)) {
      if (primitives.has(shape.kind)) {
        const [code, codec] = primitives.get(shape.kind);
        this.names.add(name);
        this.named.set(name, { code: name, codec });
        this.aliases.set(name, code);
      } else {
        this.named.set(name, this.register(shape, name));
      }
    }

    for (const [path, name] of resourceNames) {
      const procedure = catalog.procedures.find((item) => item.name === path);

      if (!procedure) {
        throw new Error(`MISSING_RESOURCE_PROCEDURE:${path}`);
      }

      const output = procedure.output;
      const item = output.kind === "array" ? output.item : output;

      if (item.kind === "object") {
        const type = this.register(item, name);

        if (type.code !== name) {
          this.aliases.set(name, type.code);
        }
      }
    }
  }

  uniqueName(preferred, key) {
    const digest = crypto
      .createHash("sha256")
      .update(key)
      .digest("hex")
      .slice(0, 8);
    let name = pascal(preferred);

    const suffix = `Schema${digest[0].toUpperCase()}${digest.slice(1)}`;

    if (name.length > 52) {
      name = `${name.slice(0, 38)}${suffix}`;
    }

    if (this.names.has(name)) {
      name = `${name}${suffix}`;
    }

    if (this.names.has(name)) {
      throw new Error(`DART_TYPE_NAME_COLLISION:${name}`);
    }

    this.names.add(name);

    return name;
  }

  register(shape, preferred) {
    const key = signature(shape);
    const found = this.byShape.get(key);

    if (found) {
      return found;
    }

    const name = this.uniqueName(preferred, key);
    const definition = {
      name,
      shape,
      kind: enumShape(shape) ? "enum" : shape.kind,
    };
    const type = { code: name, codec: `${name}.codec` };

    this.definitions.push(definition);
    this.byShape.set(key, type);

    return type;
  }

  lower(shape, preferred) {
    if (primitives.has(shape.kind)) {
      const [code, codec] = primitives.get(shape.kind);

      return { code, codec };
    }

    if (shape.kind === "ref") {
      const named = this.named.get(shape.name);

      if (!named) {
        throw new Error(`UNRESOLVED_DART_REFERENCE:${shape.name}`);
      }

      return named;
    }

    if (shape.kind === "literal") {
      const kind = typeof shape.value;
      const type = this.lower({ kind }, preferred);

      return {
        code: type.code,
        codec: `rpcLiteral<${type.code}>(${quote(shape.value)})`,
      };
    }

    if (shape.kind === "array") {
      const item = this.lower(shape.item, `${preferred}Item`);

      return { code: `List<${item.code}>`, codec: `rpcArray(${item.codec})` };
    }

    if (shape.kind === "object" || shape.kind === "record") {
      return this.register(shape, preferred);
    }

    if (shape.kind !== "union") {
      throw new Error(`UNSUPPORTED_DART_SHAPE:${shape.kind}`);
    }

    const all = variants(shape);
    const defined = all.filter((variant) => variant.kind !== "undefined");

    if (defined.length !== all.length) {
      if (!defined.length) {
        return this.lower({ kind: "undefined" }, preferred);
      }

      const core = this.lower({ kind: "union", variants: defined }, preferred);

      return {
        code: `RpcOptional<${core.code}>`,
        codec: `rpcMaybe(${core.codec})`,
      };
    }

    const nonNull = all.filter((variant) => variant.kind !== "null");

    if (nonNull.length !== all.length) {
      if (!nonNull.length) {
        return this.lower({ kind: "null" }, preferred);
      }

      const core = this.lower({ kind: "union", variants: nonNull }, preferred);
      const code = core.code.endsWith("?") ? core.code : `${core.code}?`;

      return { code, codec: `rpcNullable(${core.codec})` };
    }

    if (all.length === 1) {
      return this.lower(all[0], preferred);
    }

    if (!all.length) {
      throw new Error("EMPTY_DART_UNION");
    }

    const booleans = all.every((variant) => {
      return variant.kind === "literal" && typeof variant.value === "boolean";
    });

    if (booleans) {
      return this.lower({ kind: "boolean" }, preferred);
    }

    return this.register({ kind: "union", variants: all }, preferred);
  }

  fieldType(field, preferred) {
    const type = this.lower(withoutUndefined(field.type), preferred);

    if (field.optional) {
      return { ...type, code: `RpcOptional<${type.code}>` };
    }

    return this.lower(field.type, preferred);
  }

  emitObject(definition) {
    const { name, shape } = definition;
    const fields = Object.entries(shape.fields).map(([key, field]) => {
      return {
        key,
        field,
        member: member(key),
        type: this.fieldType(field, name + pascal(key)),
      };
    });
    const names = fields.map((field) => field.member);

    if (new Set(names).size !== names.length) {
      throw new Error(`DART_FIELD_NAME_COLLISION:${name}`);
    }

    const lines = [`final class ${name} implements RpcValue {`];

    if (fields.length) {
      lines.push(`  const ${name}({`);

      for (const field of fields) {
        let parameter = `required this.${field.member}`;

        if (field.field.optional) {
          parameter = `this.${field.member} = const RpcOptional.absent()`;
        } else if (
          field.type.code.endsWith("?") ||
          field.type.code === "Null"
        ) {
          parameter = `this.${field.member}`;
        }

        lines.push(`    ${parameter},`);
      }

      lines.push("  });", "");
    } else {
      lines.push(`  const ${name}();`, "");
    }

    lines.push(
      `  static const codec = RpcCodec<${name}>(${name}.fromWire);`,
      "",
    );

    for (const field of fields) {
      lines.push(`  final ${field.type.code} ${field.member};`);
    }

    lines.push("", `  factory ${name}.fromWire(Object? value) {`);
    const prefix = fields.length ? "final object = " : "";
    lines.push(`    ${prefix}readRpcObject(value, const {`);

    for (const field of fields) {
      lines.push(`      ${quote(field.key)},`);
    }

    lines.push("    });", "", `    return ${name}(`);

    for (const field of fields) {
      const key = quote(field.key);
      const decoder = `${field.type.codec}.decode`;
      const expression = field.field.optional
        ? `readRpcOptionalField(object, ${key}, ${decoder})`
        : `${decoder}(readRpcField(object, ${key}))`;
      lines.push(`      ${field.member}: ${expression},`);
    }

    lines.push(
      "    );",
      "  }",
      "",
      "  @override",
      "  JsonMap toWire() {",
      "    return {",
    );

    for (const field of fields) {
      if (field.field.optional) {
        lines.push(`      if (!${field.member}.isAbsent)`);
      }

      lines.push(`      ${quote(field.key)}: encodeRpcValue(${field.member}),`);
    }

    lines.push("    };", "  }", "", "}", "");

    return lines;
  }

  emitRecord(definition) {
    const { name, shape } = definition;
    const item = this.lower(shape.item, `${name}Value`);

    return [
      `final class ${name} implements RpcValue {`,
      `  const ${name}(this.values);`,
      "",
      `  static const codec = RpcCodec<${name}>(${name}.fromWire);`,
      "",
      `  final Map<String, ${item.code}> values;`,
      "",
      `  factory ${name}.fromWire(Object? value) {`,
      `    final decoded = readRpcRecord(value, ${item.codec}.decode);`,
      "",
      `    return ${name}(decoded);`,
      "  }",
      "",
      "  @override",
      "  JsonMap toWire() {",
      "    return {",
      "      for (final entry in values.entries)",
      "        entry.key: encodeRpcValue(entry.value),",
      "    };",
      "  }",
      "",
      "}",
      "",
    ];
  }

  emitEnum(definition) {
    const { name, shape } = definition;
    const options = variants(shape);
    const identifiers = new Set();
    const lines = [`enum ${name} implements RpcValue {`];

    for (const [index, option] of options.entries()) {
      let identifier = member(option.value);

      if (identifiers.has(identifier)) {
        identifier += index + 1;
      }

      identifiers.add(identifier);
      const terminator = index === options.length - 1 ? ";" : ",";
      lines.push(`  ${identifier}(${quote(option.value)})${terminator}`);
    }

    lines.push(
      "",
      `  const ${name}(this.wireValue);`,
      "",
      "  final String wireValue;",
      "",
    );
    lines.push(
      `  static const codec = RpcCodec<${name}>(${name}.fromWire);`,
      "",
    );
    lines.push(`  factory ${name}.fromWire(Object? value) {`);
    lines.push(
      "    for (final option in values) {",
      "      if (option.wireValue == value) {",
    );
    lines.push("        return option;", "      }", "", "    }", "");
    lines.push(
      "    throw const FormatException('INVALID_RPC_ENUM');",
      "  }",
      "",
    );
    lines.push(
      "  @override",
      "  String toWire() {",
      "    return wireValue;",
      "  }",
      "",
      "}",
      "",
    );

    return lines;
  }

  emitUnion(definition) {
    const { name, shape } = definition;
    const options = variants(shape);
    const members = options.map((shape, index) => {
      const type = this.lower(shape, `${name}Variant${index + 1}`);
      const suffix = shape.kind === "ref" ? shape.name : pascal(shape.kind);
      const child = this.uniqueName(`${name}${suffix}`, `${name}:${index}`);

      return { type, child };
    });
    const lines = [
      `sealed class ${name} implements RpcValue {`,
      `  const ${name}._();`,
      "",
      `  static const codec = RpcCodec<${name}>(${name}.fromWire);`,
      "",
      `  factory ${name}.fromWire(Object? value) {`,
      `    final decoder = rpcUnion<${name}>([`,
    ];

    for (const { type, child } of members) {
      lines.push(
        `      rpcVariant<${type.code}, ${name}>(${type.codec}, ${child}.new),`,
      );
    }

    lines.push(
      "    ]);",
      "",
      "    return decoder.decode(value);",
      "  }",
      "",
      "}",
      "",
    );

    for (const { type, child } of members) {
      lines.push(
        `final class ${child} extends ${name} {`,
        `  const ${child}(this.value) : super._();`,
        "",
        `  final ${type.code} value;`,
        "",
        "  @override",
        "  Object? toWire() {",
        "    return encodeRpcValue(value);",
        "  }",
        "",
        "}",
        "",
      );
    }

    return lines;
  }

  emitDefinitions() {
    const lines = [];

    for (let index = 0; index < this.definitions.length; index++) {
      const definition = this.definitions[index];

      if (definition.kind === "object") {
        lines.push(...this.emitObject(definition));
      } else if (definition.kind === "record") {
        lines.push(...this.emitRecord(definition));
      } else if (definition.kind === "enum") {
        lines.push(...this.emitEnum(definition));
      } else if (definition.kind === "union") {
        lines.push(...this.emitUnion(definition));
      } else {
        throw new Error(`UNSUPPORTED_DART_DEFINITION:${definition.kind}`);
      }
    }

    return lines;
  }
}

export function generateTypedContract(catalog) {
  const generator = new DartTypes(catalog);
  const endpoints = [];

  for (const procedure of catalog.procedures) {
    const name = pascal(procedure.name);
    const input = generator.lower(procedure.input, `${name}Request`);
    const output = generator.lower(procedure.output, `${name}Result`);
    const inputAlias = `${name}Input`;
    const outputAlias = `${name}Output`;

    if (inputAlias !== input.code) {
      generator.aliases.set(inputAlias, input.code);
    }

    if (outputAlias !== output.code) {
      generator.aliases.set(outputAlias, output.code);
    }

    endpoints.push({ ...procedure, input, output, inputAlias, outputAlias });
  }

  const modelLines = [
    "// Generated from the Rust API contract. Do not edit by hand.",
    "import '../contract.dart';",
    "import '../model.dart';",
    "",
    ...generator.emitDefinitions(),
  ];

  for (const [alias, type] of generator.aliases) {
    modelLines.push(`typedef ${alias} = ${type};`, "");
  }

  const apiLines = [
    "// Generated from the Rust API contract. Do not edit by hand.",
    "import '../model.dart';",
    "import '../procedure.dart';",
    "import 'models.g.dart';",
    "",
  ];

  for (const kind of ["query", "mutation"]) {
    const namespace = kind === "query" ? "ApiQueries" : "ApiMutations";
    const descriptor = kind === "query" ? "RpcQuery" : "RpcMutation";
    apiLines.push(`abstract final class ${namespace} {`);

    for (const endpoint of endpoints.filter((item) => item.kind === kind)) {
      apiLines.push(
        `  static final ${member(endpoint.name)} =`,
        `      ${descriptor}<${endpoint.inputAlias}, ${endpoint.outputAlias}>(`,
        `    path: ${quote(endpoint.name)},`,
        `    decodeOutput: ${endpoint.output.codec}.decode,`,
        "  );",
        "",
      );
    }

    apiLines.push("}", "");
  }

  const requiredObjects = new Set();

  for (const shape of [
    ...Object.values(catalog.types),
    ...catalog.procedures.flatMap((procedure) => [
      procedure.input,
      procedure.output,
    ]),
  ]) {
    walk(shape, (nested) => {
      if (nested.kind === "object") {
        requiredObjects.add(signature(nested));
      }
    });
  }

  const generatedObjects = new Set(
    generator.definitions
      .filter((definition) => definition.kind === "object")
      .map((definition) => signature(definition.shape)),
  );

  if ([...requiredObjects].some((key) => !generatedObjects.has(key))) {
    throw new Error("INCOMPLETE_TYPED_OBJECT_COVERAGE");
  }

  const coverage = {
    contractSha256: catalog.contractSha256,
    objectShapes: requiredObjects.size,
    definitions: generator.definitions.map(({ name, kind }) => ({
      name,
      kind,
    })),
    procedures: endpoints.map((endpoint) => ({
      name: endpoint.name,
      kind: endpoint.kind,
      input: endpoint.inputAlias,
      output: endpoint.outputAlias,
      inputType: endpoint.input.code,
      outputType: endpoint.output.code,
    })),
  };

  return [
    ["models.g.dart", modelLines.join("\n")],
    ["api.g.dart", apiLines.join("\n")],
    ["models.coverage.json", JSON.stringify(coverage, null, 2) + "\n"],
  ];
}
