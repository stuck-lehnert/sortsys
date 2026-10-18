import 'dart:async';
import 'dart:js_interop';
import 'dart:typed_data';

import 'package:web/web.dart' as web;

import 'transport.dart';

final class PlatformTransport implements RpcTransport {
  final _active = <web.AbortController>{};

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

    final controller = web.AbortController();
    final timer = Timer(timeout, () {
      controller.abort();
    });

    final requestHeaders = web.Headers();
    headers.forEach((name, value) {
      requestHeaders.set(name, value);
    });

    _active.add(controller);

    final request = web.RequestInit(
      method: method,
      headers: requestHeaders,
      body: body?.toJS,
      credentials: 'omit',
      redirect: 'error',
      signal: controller.signal,
    );

    try {
      final response = await web.window
          .fetch(uri.toString().toJS, request)
          .toDart;
      if (response.redirected) {
        throw StateError('UNEXPECTED_REDIRECT');
      }

      final length = int.tryParse(response.headers.get('content-length') ?? '');
      if (length != null && length > maxRpcBytes) {
        throw StateError('RPC_SIZE_LIMIT');
      }

      final bytes = await _readResponse(response, controller);

      return TransportResponse(response.status, bytes);
    } finally {
      timer.cancel();
      _active.remove(controller);
    }
  }

  Future<Uint8List> _readResponse(
    web.Response response,
    web.AbortController controller,
  ) async {
    final stream = response.body;
    if (stream == null) {
      return Uint8List(0);
    }

    final reader = stream.getReader() as web.ReadableStreamDefaultReader;
    final bytes = BytesBuilder(copy: false);
    var total = 0;

    try {
      while (true) {
        final chunk = await reader.read().toDart;
        if (chunk.done) {
          break;
        }

        final value = chunk.value;
        if (value == null || !value.isA<JSUint8Array>()) {
          throw StateError('INVALID_RPC_STREAM');
        }

        final data = (value as JSUint8Array).toDart;
        total += data.length;
        if (total > maxRpcBytes) {
          controller.abort();
          throw StateError('RPC_SIZE_LIMIT');
        }

        bytes.add(data);
      }
    } finally {
      reader.releaseLock();
    }

    return bytes.takeBytes();
  }

  @override
  void close() {
    _closed = true;

    for (final controller in _active) {
      controller.abort();
    }

    _active.clear();
  }
}
