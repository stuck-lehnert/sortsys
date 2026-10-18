import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/client.dart';
import 'package:sortsys_client/api/contract.dart';
import 'package:sortsys_client/api/transport.dart';
import 'package:sortsys_client/api/wire.dart';
import 'package:sortsys_client/domain/instance.dart';

void main() {
  final instance = SortsysInstance.parse('sortsys.example.org');

  group('RPC refactor behavior', () {
    test('preserves query method, endpoint and batch envelope', () async {
      final transport = _RecordingTransport(
        Future.value(_response(403, <String, Object?>{})),
      );
      final SessionApi client = RpcClient(instance, transport: transport);
      addTearDown(client.close);

      await expectLater(
        client.query('auth.sessionInfo'),
        throwsA(
          isA<RpcException>().having((error) => error.httpCode, 'status', 403),
        ),
      );

      final request = transport.requests.single;
      final encodedInput = request.uri.queryParameters['input']!;

      expect(request.method, 'GET');
      expect(request.uri.path, '/api/v2/auth.sessionInfo');
      expect(request.uri.queryParameters['batch'], '1');
      expect(jsonDecode(encodedInput), {'0': serializeWire(rpcUndefined)});
      expect(request.body, isNull);
      expect(request.timeout, const Duration(seconds: 20));
    });

    test('preserves mutation body, headers and explicit timeout', () async {
      final transport = _RecordingTransport(
        Future.value(_response(400, <String, Object?>{})),
      );
      final SessionApi client = RpcClient(instance, transport: transport);
      const timeout = Duration(minutes: 10);
      final input = <String, Object?>{
        'tenant': 'tenant',
        'username': 'employee',
        'password': 'test-only-password',
      };
      addTearDown(client.close);

      client.setToken('test-only-token');
      await expectLater(
        client.mutate('auth.login', input, timeout: timeout),
        throwsA(
          isA<RpcException>().having((error) => error.httpCode, 'status', 400),
        ),
      );

      final request = transport.requests.single;

      expect(request.method, 'POST');
      expect(request.uri.path, '/api/v2/auth.login');
      expect(request.uri.queryParameters, {'batch': '1'});
      expect(request.headers['accept'], 'application/json');
      expect(request.headers['content-type'], 'application/json');
      expect(request.headers['authorization'], 'Bearer test-only-token');
      expect(jsonDecode(request.body!), {'0': serializeWire(input)});
      expect(request.timeout, timeout);
    });

    test('decodes and validates a successful list result', () async {
      final transport = _RecordingTransport(
        Future.value(
          _response(200, [
            {
              'result': {
                'data': {'json': <Object?>[]},
              },
            },
          ]),
        ),
      );
      final SessionApi client = RpcClient(instance, transport: transport);
      addTearDown(client.close);

      final value = await client.query('products.list', <String, Object?>{});

      expect(value, isEmpty);
      expect(transport.requests.length, 1);
    });

    test(
      'continues rejecting a result with the wrong contract shape',
      () async {
        final transport = _RecordingTransport(
          Future.value(
            _response(200, [
              {
                'result': {
                  'data': {'json': null},
                },
              },
            ]),
          ),
        );
        final SessionApi client = RpcClient(instance, transport: transport);
        addTearDown(client.close);

        await expectLater(
          client.query('products.list', <String, Object?>{}),
          throwsFormatException,
        );

        expect(transport.requests.length, 1);
      },
    );

    test('rejects invalid input before sending a request', () async {
      final transport = _RecordingTransport(
        Future.value(_response(200, <Object?>[])),
      );
      final SessionApi client = RpcClient(instance, transport: transport);
      addTearDown(client.close);

      await expectLater(
        client.mutate('auth.login', null),
        throwsFormatException,
      );

      expect(transport.requests, isEmpty);
    });

    test('retains the HTTP unauthorized callback', () async {
      final transport = _RecordingTransport(
        Future.value(_response(401, <String, Object?>{})),
      );
      var unauthorizedCalls = 0;
      final SessionApi client = RpcClient(
        instance,
        transport: transport,
        onUnauthorized: () {
          unauthorizedCalls++;
        },
      );
      addTearDown(client.close);

      await expectLater(
        client.query('auth.sessionInfo'),
        throwsA(
          isA<RpcException>().having((error) => error.httpCode, 'status', 401),
        ),
      );

      expect(unauthorizedCalls, 1);
      expect(transport.requests.length, 1);
    });

    test('preserves SuperJSON RPC error decoding', () async {
      final transport = _RecordingTransport(
        Future.value(
          _response(200, [
            {
              'error': {
                'json': {
                  'data': {'httpCode': 403, 'code': 'RPC_ERROR'},
                },
              },
            },
          ]),
        ),
      );
      final SessionApi client = RpcClient(instance, transport: transport);
      addTearDown(client.close);

      await expectLater(
        client.query('auth.sessionInfo'),
        throwsA(
          isA<RpcException>()
              .having((error) => error.httpCode, 'status', 403)
              .having((error) => error.code, 'code', 'RPC_ERROR'),
        ),
      );

      expect(transport.requests.length, 1);
    });

    test('rejects malformed batches and missing result data', () async {
      final bodies = <Object?>[
        <Object?>[],
        [<String, Object?>{}, <String, Object?>{}],
        [null],
        [
          {'result': <String, Object?>{}},
        ],
      ];

      for (final body in bodies) {
        final transport = _RecordingTransport(
          Future.value(_response(200, body)),
        );
        final SessionApi client = RpcClient(instance, transport: transport);

        try {
          await expectLater(
            client.query('auth.sessionInfo'),
            throwsFormatException,
          );

          expect(transport.requests.length, 1);
        } finally {
          client.close();
        }
      }
    });

    test('rejects a response arriving after client disposal', () async {
      final completion = Completer<TransportResponse>();
      final transport = _RecordingTransport(completion.future);
      final SessionApi client = RpcClient(instance, transport: transport);
      addTearDown(client.close);

      final pending = client.query('auth.sessionInfo');
      client.close();
      completion.complete(_response(200, <Object?>[]));

      await expectLater(pending, throwsStateError);

      expect(transport.closed, isTrue);
      expect(transport.requests.length, 1);
    });

    test('rejects new operations after client disposal', () async {
      final transport = _RecordingTransport(
        Future.value(_response(200, <Object?>[])),
      );
      final SessionApi client = RpcClient(instance, transport: transport);

      client.close();

      expect(() => client.setToken('test-only-token'), throwsStateError);
      await expectLater(client.query('auth.sessionInfo'), throwsStateError);

      expect(transport.closed, isTrue);
      expect(transport.requests, isEmpty);
    });
  });
}

TransportResponse _response(int status, Object? body) {
  final encoded = utf8.encode(jsonEncode(body));

  return TransportResponse(status, Uint8List.fromList(encoded));
}

final class _RecordedRequest {
  _RecordedRequest(
    this.uri,
    this.method,
    this.headers,
    this.body,
    this.timeout,
  );

  final Uri uri;
  final String method;
  final Map<String, String> headers;
  final String? body;
  final Duration timeout;
}

final class _RecordingTransport implements RpcTransport {
  _RecordingTransport(this.response);

  final Future<TransportResponse> response;
  final requests = <_RecordedRequest>[];

  bool closed = false;

  @override
  Future<TransportResponse> send(
    Uri uri,
    String method,
    Map<String, String> headers,
    String? body,
    Duration timeout,
  ) {
    if (closed) {
      throw StateError('CLOSED_TEST_TRANSPORT');
    }

    requests.add(
      _RecordedRequest(
        uri,
        method,
        Map<String, String>.unmodifiable(headers),
        body,
        timeout,
      ),
    );

    return response;
  }

  @override
  void close() {
    closed = true;
  }
}
