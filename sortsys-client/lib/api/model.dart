import 'contract.dart';

abstract interface class RpcValue {
  Object? toWire();
}

enum RpcPresence { absent, undefined, value }

final class RpcOptional<T> implements RpcValue {
  const RpcOptional.absent() : presence = RpcPresence.absent, _value = null;

  const RpcOptional.undefined()
    : presence = RpcPresence.undefined,
      _value = null;

  const RpcOptional.value(T value)
    : presence = RpcPresence.value,
      _value = value;

  final RpcPresence presence;
  final T? _value;

  bool get isAbsent => presence == RpcPresence.absent;
  bool get isUndefined => presence == RpcPresence.undefined;
  bool get hasValue => presence == RpcPresence.value;
  T? get valueOrNull => _value;

  T get value {
    if (!hasValue) {
      throw StateError('RPC_OPTIONAL_HAS_NO_VALUE');
    }

    return _value as T;
  }

  @override
  Object? toWire() {
    if (isAbsent) {
      throw const FormatException('ABSENT_RPC_ROOT_VALUE');
    }

    if (isUndefined) {
      return rpcUndefined;
    }

    return encodeRpcValue(value);
  }
}

Object? encodeRpcValue(Object? value) {
  if (value is RpcValue) {
    return value.toWire();
  }

  if (value is List<Object?>) {
    return value.map(encodeRpcValue).toList(growable: false);
  }

  if (value is JsonMap) {
    return {
      for (final entry in value.entries) entry.key: encodeRpcValue(entry.value),
    };
  }

  return value;
}

String readRpcString(Object? value) {
  if (value is! String) {
    throw const FormatException('INVALID_RPC_STRING');
  }

  return value;
}

num readRpcNumber(Object? value) {
  if (value is! num || !value.isFinite) {
    throw const FormatException('INVALID_RPC_NUMBER');
  }

  return value;
}

bool readRpcBoolean(Object? value) {
  if (value is! bool) {
    throw const FormatException('INVALID_RPC_BOOLEAN');
  }

  return value;
}

DateTime readRpcDate(Object? value) {
  if (value is! DateTime) {
    throw const FormatException('INVALID_RPC_DATE');
  }

  return value;
}

BigInt readRpcBigInt(Object? value) {
  if (value is! BigInt) {
    throw const FormatException('INVALID_RPC_BIGINT');
  }

  return value;
}

RpcUndefined readRpcUndefined(Object? value) {
  if (value is! RpcUndefined) {
    throw const FormatException('INVALID_RPC_UNDEFINED');
  }

  return value;
}

Null readRpcNull(Object? value) {
  if (value != null) {
    throw const FormatException('INVALID_RPC_NULL');
  }

  return null;
}

Object? readRpcUnknown(Object? value) {
  return value;
}

T readRpcLiteral<T>(Object? value, T literal) {
  if (value != literal) {
    throw const FormatException('INVALID_RPC_LITERAL');
  }

  return literal;
}

T? readRpcNullable<T>(Object? value, T Function(Object?) decode) {
  if (value == null) {
    return null;
  }

  return decode(value);
}

RpcOptional<T> readRpcMaybe<T>(Object? value, T Function(Object?) decode) {
  if (value is RpcUndefined) {
    return const RpcOptional.undefined();
  }

  return RpcOptional.value(decode(value));
}

RpcOptional<T> readRpcOptionalField<T>(
  JsonMap object,
  String key,
  T Function(Object?) decode,
) {
  if (!object.containsKey(key)) {
    return const RpcOptional.absent();
  }

  return readRpcMaybe(object[key], decode);
}

List<T> readRpcList<T>(Object? value, T Function(Object?) decode) {
  if (value is! List<Object?>) {
    throw const FormatException('INVALID_RPC_ARRAY');
  }

  return List<T>.unmodifiable(value.map(decode));
}

JsonMap readRpcObject(Object? value, Set<String> fields) {
  final object = jsonMap(value);

  if (object.keys.any((key) => !fields.contains(key))) {
    throw const FormatException('UNEXPECTED_RPC_FIELD');
  }

  return object;
}

Object? readRpcField(JsonMap object, String key) {
  if (!object.containsKey(key)) {
    return rpcUndefined;
  }

  return object[key];
}

Map<String, T> readRpcRecord<T>(Object? value, T Function(Object?) decode) {
  final object = jsonMap(value);
  final decoded = <String, T>{};

  for (final entry in object.entries) {
    decoded[entry.key] = decode(entry.value);
  }

  return Map<String, T>.unmodifiable(decoded);
}

final class RpcCodec<T> {
  const RpcCodec(this.decode);

  final T Function(Object?) decode;
}

const rpcString = RpcCodec<String>(readRpcString);
const rpcNumber = RpcCodec<num>(readRpcNumber);
const rpcBoolean = RpcCodec<bool>(readRpcBoolean);
const rpcDate = RpcCodec<DateTime>(readRpcDate);
const rpcBigInt = RpcCodec<BigInt>(readRpcBigInt);
const rpcNull = RpcCodec<Null>(readRpcNull);
const rpcUndefinedCodec = RpcCodec<RpcUndefined>(readRpcUndefined);
const rpcUnknown = RpcCodec<Object?>(readRpcUnknown);

RpcCodec<T> rpcLiteral<T>(T literal) {
  return RpcCodec((value) {
    return readRpcLiteral(value, literal);
  });
}

RpcCodec<T?> rpcNullable<T>(RpcCodec<T> inner) {
  return RpcCodec((value) {
    return readRpcNullable(value, inner.decode);
  });
}

RpcCodec<RpcOptional<T>> rpcMaybe<T>(RpcCodec<T> inner) {
  return RpcCodec((value) {
    return readRpcMaybe(value, inner.decode);
  });
}

RpcCodec<List<T>> rpcArray<T>(RpcCodec<T> item) {
  return RpcCodec((value) {
    return readRpcList(value, item.decode);
  });
}

RpcCodec<O> rpcVariant<I, O>(RpcCodec<I> inner, O Function(I) wrap) {
  return RpcCodec((value) {
    final decoded = inner.decode(value);

    return wrap(decoded);
  });
}

RpcCodec<T> rpcUnion<T>(List<RpcCodec<T>> variants) {
  return RpcCodec((value) {
    for (final variant in variants) {
      try {
        return variant.decode(value);
      } on FormatException {
        // Only a shape mismatch advances to another contract union variant.
        continue;
      }
    }

    throw const FormatException('INVALID_RPC_UNION');
  });
}
