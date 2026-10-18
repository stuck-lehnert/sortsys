import 'dart:convert';

import 'generated/contract.g.dart';

const rpcUndefined = RpcUndefined();

typedef JsonMap = Map<String, Object?>;

enum RpcKind { query, mutation }

final class RpcUndefined {
  const RpcUndefined();
}

JsonMap jsonMap(Object? value) {
  if (value is! Map<String, Object?>) {
    throw const FormatException('INVALID_RPC_OBJECT');
  }

  return value;
}

final class RpcProcedure {
  RpcProcedure(this.name, this.kind, this.input, this.output);

  final String name;
  final RpcKind kind;
  final JsonMap input;
  final JsonMap output;
}

final class ApiContract {
  ApiContract() {
    final Object? decoded = jsonDecode(contractJson);
    final data = jsonMap(decoded);
    final rows = data['procedures'];

    if (rows is! List<Object?>) {
      throw const FormatException('INVALID_CONTRACT');
    }

    sha256 = data['contractSha256']! as String;
    _types = jsonMap(data['types']);

    for (final row in rows) {
      final entry = jsonMap(row);
      final name = entry['name']! as String;
      final kind = entry['kind'] == 'query' ? RpcKind.query : RpcKind.mutation;

      procedures[name] = RpcProcedure(
        name,
        kind,
        jsonMap(entry['input']),
        jsonMap(entry['output']),
      );
    }
  }

  late final String sha256;
  late final JsonMap _types;
  final procedures = <String, RpcProcedure>{};

  RpcProcedure require(String name, RpcKind kind) {
    final procedure = procedures[name];
    if (procedure == null || procedure.kind != kind) {
      throw const FormatException('UNKNOWN_RPC_PROCEDURE');
    }

    return procedure;
  }

  void validate(JsonMap shape, Object? value, [int depth = 0]) {
    if (depth > 100) {
      throw const FormatException('RPC_DEPTH_LIMIT');
    }

    final valid = switch (shape['kind']) {
      'unknown' => _isWireValue(value),
      'undefined' => value is RpcUndefined,
      'null' => value == null,
      'string' => value is String,
      'boolean' => value is bool,
      'number' => value is num && value.isFinite,
      'bigint' => value is BigInt,
      'date' => value is DateTime,
      'literal' => value == shape['value'],
      'ref' => _validateReference(shape, value, depth),
      'union' => _validateUnion(shape, value, depth),
      'array' => _validateArray(shape, value, depth),
      'record' => _validateRecord(shape, value, depth),
      'object' => _validateObject(shape, value, depth),
      _ => throw const FormatException('INVALID_CONTRACT_SHAPE'),
    };

    if (!valid) {
      throw const FormatException('INVALID_RPC_VALUE');
    }
  }

  bool _isWireValue(Object? value) {
    return value == null ||
        value is RpcUndefined ||
        value is String ||
        value is bool ||
        value is num ||
        value is BigInt ||
        value is DateTime ||
        value is List<Object?> ||
        value is JsonMap;
  }

  bool _validateReference(JsonMap shape, Object? value, int depth) {
    validate(jsonMap(_types[shape['name']]), value, depth + 1);

    return true;
  }

  bool _validateUnion(JsonMap shape, Object? value, int depth) {
    final variants = shape['variants']! as List<Object?>;

    for (final variant in variants) {
      try {
        validate(jsonMap(variant), value, depth + 1);

        return true;
      } on FormatException {
        continue;
      }
    }

    return false;
  }

  bool _validateArray(JsonMap shape, Object? value, int depth) {
    if (value is! List<Object?>) {
      return false;
    }

    final itemShape = jsonMap(shape['item']);
    for (final item in value) {
      validate(itemShape, item, depth + 1);
    }

    return true;
  }

  bool _validateRecord(JsonMap shape, Object? value, int depth) {
    if (value is! JsonMap) {
      return false;
    }

    final itemShape = jsonMap(shape['item']);
    for (final item in value.values) {
      validate(itemShape, item, depth + 1);
    }

    return true;
  }

  bool _validateObject(JsonMap shape, Object? value, int depth) {
    if (value is! JsonMap) {
      return false;
    }

    final fields = jsonMap(shape['fields']);
    for (final entry in fields.entries) {
      final field = jsonMap(entry.value);
      final present = value.containsKey(entry.key);
      if (!present && field['optional'] == true) {
        continue;
      }

      validate(
        jsonMap(field['type']),
        present ? value[entry.key] : rpcUndefined,
        depth + 1,
      );
    }

    if (value.keys.any((key) => !fields.containsKey(key))) {
      throw const FormatException('UNEXPECTED_RPC_FIELD');
    }

    return true;
  }
}
