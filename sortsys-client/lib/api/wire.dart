import 'contract.dart';

String _escapeSegment(String key) {
  return key.replaceAll(r'\', r'\\').replaceAll('.', r'\.');
}

String _childPath(String parent, String segment) {
  return parent.isEmpty ? segment : '$parent.$segment';
}

List<String> _parsePath(String value) {
  final segments = <String>[];
  final buffer = StringBuffer();
  var escaped = false;

  for (final rune in value.runes) {
    final character = String.fromCharCode(rune);

    if (escaped) {
      buffer.write(character);
      escaped = false;
    } else if (character == r'\') {
      escaped = true;
    } else if (character == '.') {
      segments.add(buffer.toString());
      buffer.clear();
    } else {
      buffer.write(character);
    }
  }

  if (escaped) {
    throw const FormatException('INVALID_WIRE_PATH');
  }

  segments.add(buffer.toString());

  return segments;
}

JsonMap serializeWire(Object? input) {
  final annotations = <String, Object?>{};

  Object? encodeValue(Object? value, String path, int depth) {
    if (depth > 100) {
      throw const FormatException('WIRE_DEPTH_LIMIT');
    }

    if (value is DateTime) {
      annotations[path] = ['Date'];

      return value.toUtc().toIso8601String();
    }

    if (value is BigInt) {
      annotations[path] = ['bigint'];

      return value.toString();
    }

    if (value is RpcUndefined) {
      annotations[path] = ['undefined'];

      return null;
    }

    if (value is List<Object?>) {
      return [
        for (var index = 0; index < value.length; index++)
          encodeValue(value[index], _childPath(path, '$index'), depth + 1),
      ];
    }

    if (value is JsonMap) {
      return {
        for (final entry in value.entries)
          entry.key: encodeValue(
            entry.value,
            _childPath(path, _escapeSegment(entry.key)),
            depth + 1,
          ),
      };
    }

    final plainValue =
        value == null ||
        value is String ||
        value is bool ||
        (value is num && value.isFinite);
    if (plainValue) {
      return value;
    }

    throw const FormatException('UNSUPPORTED_WIRE_VALUE');
  }

  final json = encodeValue(input, '', 0);
  final rootAnnotation = annotations.length == 1 && annotations.containsKey('');

  return {
    'json': json,
    if (annotations.isNotEmpty)
      'meta': {'values': rootAnnotation ? annotations[''] : annotations},
  };
}

Object? deserializeWire(Object? input) {
  final envelope = jsonMap(input);
  if (!envelope.containsKey('json')) {
    throw const FormatException('INVALID_WIRE_ENVELOPE');
  }

  var json = envelope['json'];
  final meta = envelope['meta'];
  if (meta == null) {
    return json;
  }

  final annotations = jsonMap(meta)['values'];
  if (annotations is List<Object?>) {
    return _decodeAnnotation(json, annotations);
  }

  for (final entry in jsonMap(annotations).entries) {
    if (entry.key.isEmpty) {
      json = _decodeAnnotation(json, entry.value);
      continue;
    }

    final segments = _parsePath(entry.key);
    Object? parent = json;

    for (final segment in segments.take(segments.length - 1)) {
      parent = _readPathSegment(parent, segment);
    }

    final key = segments.last;
    final decoded = _decodeAnnotation(
      _readPathSegment(parent, key),
      entry.value,
    );

    if (parent is JsonMap) {
      parent[key] = decoded;
    } else if (parent is List<Object?>) {
      parent[_arrayIndex(key, parent.length)] = decoded;
    } else {
      throw const FormatException('INVALID_WIRE_PATH');
    }
  }

  return json;
}

Object? _decodeAnnotation(Object? value, Object? annotation) {
  if (annotation is! List<Object?> || annotation.length != 1) {
    throw const FormatException('UNSUPPORTED_WIRE_ANNOTATION');
  }

  switch (annotation.single) {
    case 'Date':
      if (value is String) {
        return DateTime.parse(value).toUtc();
      }

    case 'bigint':
      if (value is String) {
        return BigInt.parse(value);
      }

    case 'undefined':
      return rpcUndefined;
  }

  throw const FormatException('INVALID_WIRE_ANNOTATION');
}

Object? _readPathSegment(Object? parent, String key) {
  if (parent is JsonMap && parent.containsKey(key)) {
    return parent[key];
  }

  if (parent is List<Object?>) {
    return parent[_arrayIndex(key, parent.length)];
  }

  throw const FormatException('INVALID_WIRE_PATH');
}

int _arrayIndex(String key, int length) {
  final index = int.tryParse(key);
  if (index == null || index < 0 || index >= length) {
    throw const FormatException('INVALID_WIRE_PATH');
  }

  return index;
}
