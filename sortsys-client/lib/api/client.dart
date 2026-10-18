import 'dart:convert';

import '../domain/instance.dart';
import 'contract.dart';
import 'transport.dart';
import 'wire.dart';

final class RpcException implements Exception {
  const RpcException(this.code, {this.httpCode});

  final String code;
  final int? httpCode;

  @override
  String toString() => 'RpcException($code)';
}

abstract interface class SessionApi {
  void setToken(String? token);

  Future<Object?> query(String name, [Object? input = rpcUndefined]);

  Future<Object?> mutate(
    String name,
    Object? input, {
    Duration timeout = const Duration(seconds: 20),
  });

  void close();
}

final class RpcClient implements SessionApi {
  RpcClient(this.instance, {RpcTransport? transport, this.onUnauthorized})
    : _transport = transport ?? createTransport();

  final SortsysInstance instance;
  final RpcTransport _transport;
  final void Function()? onUnauthorized;
  final _contract = ApiContract();

  bool _closed = false;
  String? _token;

  @override
  void setToken(String? token) {
    _ensureOpen();
    _token = token;
  }

  @override
  Future<Object?> query(String name, [Object? input = rpcUndefined]) {
    return _call(name, RpcKind.query, input, const Duration(seconds: 20));
  }

  @override
  Future<Object?> mutate(
    String name,
    Object? input, {
    Duration timeout = const Duration(seconds: 20),
  }) {
    return _call(name, RpcKind.mutation, input, timeout);
  }

  Future<Object?> _call(
    String name,
    RpcKind kind,
    Object? input,
    Duration timeout,
  ) async {
    _ensureOpen();
    final procedure = _contract.require(name, kind);
    _contract.validate(procedure.input, input);

    final envelope = jsonEncode({'0': serializeWire(input)});
    final isQuery = kind == RpcKind.query;
    final headers = <String, String>{
      'accept': 'application/json',
      if (_token != null) 'authorization': 'Bearer $_token',
      if (!isQuery) 'content-type': 'application/json',
    };

    final endpoint = instance.endpoint;
    final uri = endpoint.replace(
      path: '${endpoint.path}/$name',
      queryParameters: {'batch': '1', if (isQuery) 'input': envelope},
    );

    final response = await _transport.send(
      uri,
      isQuery ? 'GET' : 'POST',
      headers,
      isQuery ? null : envelope,
      timeout,
    );
    _ensureOpen();

    final value = _decodeResponse(response);
    _contract.validate(procedure.output, value);

    return value;
  }

  Object? _decodeResponse(TransportResponse response) {
    if (response.status == 401) {
      onUnauthorized?.call();
    }

    if (response.status < 200 || response.status >= 300) {
      throw RpcException('HTTP_ERROR', httpCode: response.status);
    }

    final Object? decoded = jsonDecode(utf8.decode(response.body));
    if (decoded is! List<Object?> || decoded.length != 1) {
      throw const FormatException('INVALID_RPC_BATCH');
    }

    final entry = jsonMap(decoded.single);
    if (entry.containsKey('error')) {
      _throwRpcError(entry['error']);
    }

    final result = jsonMap(entry['result']);
    if (!result.containsKey('data')) {
      throw const FormatException('MISSING_RPC_RESULT');
    }

    return deserializeWire(result['data']);
  }

  Never _throwRpcError(Object? envelope) {
    final error = jsonMap(deserializeWire(envelope));
    final data = error['data'] == null
        ? <String, Object?>{}
        : jsonMap(error['data']);
    final status = data['httpCode'];
    final code = data['code'];

    if (status == 401) {
      onUnauthorized?.call();
    }

    throw RpcException(
      code is String ? code : 'RPC_ERROR',
      httpCode: status is int ? status : null,
    );
  }

  void _ensureOpen() {
    if (_closed) {
      throw StateError('DISPOSED_SESSION');
    }
  }

  @override
  void close() {
    _closed = true;
    _token = null;

    _transport.close();
  }
}
