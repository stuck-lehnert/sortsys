import 'dart:typed_data';

import 'transport_native.dart'
    if (dart.library.js_interop) 'transport_web.dart'
    as platform;

const maxRpcBytes = 16 * 1024 * 1024;

final class TransportResponse {
  const TransportResponse(this.status, this.body);

  final int status;
  final Uint8List body;
}

abstract interface class RpcTransport {
  Future<TransportResponse> send(
    Uri uri,
    String method,
    Map<String, String> headers,
    String? body,
    Duration timeout,
  );

  void close();
}

RpcTransport createTransport() => platform.PlatformTransport();
