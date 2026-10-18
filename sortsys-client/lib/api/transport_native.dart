import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'transport.dart';

final class PlatformTransport implements RpcTransport {
  final HttpClient _client = HttpClient()
    ..connectionTimeout = const Duration(seconds: 20);
  final _active = <HttpClientRequest>{};

  bool _closed = false;

  @override
  Future<TransportResponse> send(
    Uri uri,
    String method,
    Map<String, String> headers,
    String? body,
    Duration timeout,
  ) async {
    if (_closed) {
      throw StateError('DISPOSED_SESSION');
    }

    HttpClientRequest? request;
    final timer = Timer(timeout, () {
      request?.abort(const SocketException('NETWORK_TIMEOUT'));
    });

    try {
      request = await _client.openUrl(method, uri).timeout(timeout);
      if (_closed) {
        request.abort();
        throw StateError('DISPOSED_SESSION');
      }

      _active.add(request);
      request.followRedirects = false;
      headers.forEach(request.headers.set);

      if (body != null) {
        request.add(utf8.encode(body));
      }

      final response = await request.close();
      final bytes = await _readResponse(request, response);

      return TransportResponse(response.statusCode, bytes);
    } finally {
      timer.cancel();

      if (request != null) {
        _active.remove(request);
      }
    }
  }

  Future<Uint8List> _readResponse(
    HttpClientRequest request,
    HttpClientResponse response,
  ) async {
    if (response.isRedirect) {
      throw const HttpException('UNEXPECTED_REDIRECT');
    }

    if (response.contentLength > maxRpcBytes) {
      throw const HttpException('RPC_SIZE_LIMIT');
    }

    final bytes = BytesBuilder(copy: false);
    var total = 0;

    await for (final chunk in response) {
      total += chunk.length;
      if (total > maxRpcBytes) {
        request.abort();
        throw const HttpException('RPC_SIZE_LIMIT');
      }

      bytes.add(chunk);
    }

    return bytes.takeBytes();
  }

  @override
  void close() {
    _closed = true;

    for (final request in _active) {
      request.abort();
    }

    _active.clear();
    _client.close(force: true);
  }
}
