import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/client.dart';
import 'package:sortsys_client/api/contract.dart';
import 'package:sortsys_client/api/generated/api.g.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as api_models;
import 'package:sortsys_client/api/model.dart';
import 'package:sortsys_client/api/transport.dart';
import 'package:sortsys_client/api/typed_client.dart';
import 'package:sortsys_client/api/wire.dart';
import 'package:sortsys_client/domain/instance.dart';

JsonMap projectFixture(DateTime timestamp) {
  return {
    'id': 'project-id',
    'title': 'Typed project',
    'address': {
      'city': 'Example city',
      'streetAddress': 'Example street 1',
      'zip': rpcUndefined,
    },
    'customerId': null,
    'responsibleProjectLeaderUserId': null,
    'orderReceivedAt': null,
    'createdByUserId': null,
    'createdAt': timestamp,
    'modifiedAt': timestamp,
    'finishedAt': null,
  };
}

void main() {
  group('Contract-generated API models', () {
    test('decodes a project and nested address into typed classes', () {
      final timestamp = DateTime.utc(2026, 3, 2, 8);
      final source = projectFixture(timestamp);

      final project = api_models.Project.fromWire(source);

      expect(project.id, 'project-id');
      expect(project.address, isA<api_models.ProjectAddress>());
      expect(project.address!.city, 'Example city');
      expect(project.address!.zip.isUndefined, isTrue);
      expect(project.address!.country.isAbsent, isTrue);
      expect(project.createdAt, timestamp);
      expect(encodeRpcValue(project), source);
    });

    test('defaults nullable constructor fields while preserving wire keys', () {
      final created = DateTime.utc(2026, 3, 2);
      final user = api_models.SessionInfoUser(
        id: 'employee',
        username: 'employee',
        firstName: 'Employee',
        contractType: api_models.UserContractType.values.first,
        locale: api_models.AssistantLocale.en,
      );
      const tenant = api_models.SessionInfoTenant(objectStorageEnabled: false);
      final session = api_models.SessionInfoSession(
        id: 'session',
        createdAt: created,
        expiresAt: created.add(const Duration(days: 1)),
      );

      expect(user.salutation, isNull);
      expect(user.lastName, isNull);
      expect(user.phone, isNull);
      expect(user.email, isNull);
      expect(tenant.companyName, isNull);
      expect(session.inetAddr, isNull);
      expect(session.userAgent, isNull);
      expect(user.toWire()['salutation'], isNull);
      expect(user.toWire().containsKey('salutation'), isTrue);

      final missingWireKey = user.toWire()..remove('salutation');

      expect(
        () => api_models.SessionInfoUser.fromWire(missingWireKey),
        throwsFormatException,
      );
    });

    test('keeps missing, explicit undefined and null fields distinct', () {
      const missing = api_models.ProductsListInput();
      const undefined = api_models.ProductsListInput(
        search: RpcOptional.undefined(),
      );
      const nullable = api_models.ProductsListInput(
        search: RpcOptional.value(null),
      );

      expect(missing.toWire(), isEmpty);
      expect(undefined.toWire(), {'search': rpcUndefined});
      expect(nullable.toWire(), {'search': null});

      final decodedMissing = api_models.ProductsListInput.fromWire(
        const <String, Object?>{},
      );
      final decodedUndefined = api_models.ProductsListInput.fromWire({
        'search': rpcUndefined,
      });
      final decodedNull = api_models.ProductsListInput.fromWire({
        'search': null,
      });

      expect(decodedMissing.search.isAbsent, isTrue);
      expect(decodedUndefined.search.isUndefined, isTrue);
      expect(decodedNull.search.hasValue, isTrue);
      expect(decodedNull.search.value, isNull);
    });

    test('rejects missing required fields and wrong typed values', () {
      final timestamp = DateTime.utc(2026, 3, 2);
      final missing = projectFixture(timestamp)..remove('title');
      final wrong = projectFixture(timestamp)..['createdAt'] = 'not-a-date';
      final extra = projectFixture(timestamp)..['unexpected'] = true;

      expect(() => api_models.Project.fromWire(missing), throwsFormatException);
      expect(() => api_models.Project.fromWire(wrong), throwsFormatException);
      expect(() => api_models.Project.fromWire(extra), throwsFormatException);
    });

    test(
      'preserves exact bigint and date values across the real wire codec',
      () {
        final version = BigInt.parse('9007199254740993');
        final saved = DateTime.utc(2026, 3, 2, 8, 15);
        final raw = {'version': version, 'savedAt': saved};

        final result = ApiMutations.projectsFilesDrawioSave.decodeOutput(raw);
        final envelope = serializeWire(encodeRpcValue(result));
        final decoded = ApiMutations.projectsFilesDrawioSave.decodeOutput(
          deserializeWire(envelope),
        );

        expect(result.version, version);
        expect(result.savedAt, saved);
        expect(decoded.version, version);
        expect(decoded.savedAt, saved);
      },
    );

    test('models recursive JSON arrays and records without losing values', () {
      final source = {
        'text': 'example',
        'number': 12.5,
        'flag': true,
        'empty': null,
        'nested': [
          {'value': 3},
          'item',
        ],
      };

      final value = api_models.JsonValue.fromWire(source);

      expect(encodeRpcValue(value), source);
      expect(
        () => api_models.JsonValue.fromWire(DateTime.utc(2026, 3, 2)),
        throwsFormatException,
      );
    });

    test('encodes the generated delivery-note ID lookup union branch', () {
      const id = api_models.ProjectsGetInput(id: 'delivery-note-id');
      const input = api_models.DeliveryNotesGetRequestObject(id);

      final encoded = ApiQueries.deliveryNotesGet.encodeInput(input);

      expect(encoded, {'id': 'delivery-note-id'});
    });

    test('does not invent a date type for contract unknown inputs', () {
      final request = api_models.ProjectsDeploymentsListInput.fromWire({
        'from': 'opaque-contract-value',
        'to': null,
      });

      expect(request.from, 'opaque-contract-value');
      expect(request.to, isNull);
      expect(request.toWire(), {'from': 'opaque-contract-value', 'to': null});
    });

    test(
      'returns Future<Project> while preserving the query wire envelope',
      () async {
        final timestamp = DateTime.utc(2026, 3, 2);
        final response = projectFixture(timestamp);
        final transport = _RecordingTransport(response);
        final client = RpcClient(
          SortsysInstance.parse('https://instance.example'),
          transport: transport,
        );
        addTearDown(client.close);

        final Future<api_models.Project> pending = client.read(
          ApiQueries.projectsGet,
          const api_models.ProjectsGetInput(id: 'project-id'),
        );
        final project = await pending;

        expect(project.title, 'Typed project');
        expect(transport.method, 'GET');
        expect(transport.uri!.path, '/api/v2/projects.get');
        expect(transport.uri!.queryParameters['batch'], '1');
        final envelope = jsonDecode(transport.uri!.queryParameters['input']!);
        expect(envelope, {
          '0': {
            'json': {'id': 'project-id'},
          },
        });
        expect(transport.body, isNull);
        expect(transport.timeout, const Duration(seconds: 20));
      },
    );
  });
}

final class _RecordingTransport implements RpcTransport {
  _RecordingTransport(Object? output)
    : response = TransportResponse(
        200,
        Uint8List.fromList(
          utf8.encode(
            jsonEncode([
              {
                'result': {'data': serializeWire(output)},
              },
            ]),
          ),
        ),
      );

  final TransportResponse response;
  Uri? uri;
  String? method;
  String? body;
  Duration? timeout;

  @override
  Future<TransportResponse> send(
    Uri requestUri,
    String requestMethod,
    Map<String, String> headers,
    String? requestBody,
    Duration requestTimeout,
  ) async {
    uri = requestUri;
    method = requestMethod;
    body = requestBody;
    timeout = requestTimeout;

    return response;
  }

  @override
  void close() {
    // The recording transport owns no external resources.
  }
}
