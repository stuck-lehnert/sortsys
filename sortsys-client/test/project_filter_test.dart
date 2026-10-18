import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/client.dart';
import 'package:sortsys_client/api/generated/api.g.dart';
import 'package:sortsys_client/api/transport.dart';
import 'package:sortsys_client/api/typed_client.dart';
import 'package:sortsys_client/domain/instance.dart';
import 'package:sortsys_client/features/projects/project_filter.dart';
import 'package:sortsys_client/features/projects/project_status_filter.dart';

void main() {
  group('Project status browsing', () {
    test('requests active projects and omits empty search', () {
      final input = projectListInput('', ProjectListStatus.active);

      final encoded = ApiQueries.projectsList.encodeInput(input);

      expect(input.search.isAbsent, isTrue);
      expect(encoded, {'finished': false});
    });

    test('requests completed projects with the exact search text', () {
      final input = projectListInput('Crane 12', ProjectListStatus.completed);

      final encoded = ApiQueries.projectsList.encodeInput(input);

      expect(encoded, {'search': 'Crane 12', 'finished': true});
    });

    test(
      'sends the selected status through the real typed RPC client',
      () async {
        final transport = _ProjectListTransport();
        final client = RpcClient(
          SortsysInstance.parse('https://instance.example'),
          transport: transport,
        );

        addTearDown(client.close);

        final input = projectListInput('Crane 12', ProjectListStatus.completed);

        final projects = await client.read(ApiQueries.projectsList, input);

        expect(projects, isEmpty);
        expect(transport.method, 'GET');
        expect(transport.body, isNull);
        expect(transport.uri!.path, '/api/v2/projects.list');

        final envelope = jsonDecode(transport.uri!.queryParameters['input']!);

        expect(envelope, {
          '0': {
            'json': {'search': 'Crane 12', 'finished': true},
          },
        });
      },
    );

    for (final scale in [1.0, 2.0]) {
      testWidgets('fits a narrow phone with text scale $scale', (tester) async {
        tester.view.physicalSize = const Size(320, 640);
        tester.view.devicePixelRatio = 1;

        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);

        await tester.pumpWidget(
          MaterialApp(
            builder: (context, child) {
              final media = MediaQuery.of(
                context,
              ).copyWith(textScaler: TextScaler.linear(scale));

              return MediaQuery(data: media, child: child!);
            },

            home: Scaffold(
              body: Padding(
                padding: const EdgeInsets.all(16),
                child: ProjectStatusFilter(
                  status: ProjectListStatus.active,
                  onChanged: (_) {},
                ),
              ),
            ),
          ),
        );

        expect(tester.takeException(), isNull);
        expect(find.text('Active'), findsOneWidget);
        expect(find.text('Status'), findsOneWidget);
      });
    }

    testWidgets('selects completed projects', (tester) async {
      var selected = ProjectListStatus.active;

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: ProjectStatusFilter(
              status: selected,
              onChanged: (status) {
                selected = status;
              },
            ),
          ),
        ),
      );

      await tester.tap(find.byType(DropdownButtonFormField<ProjectListStatus>));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Completed').last);
      await tester.pumpAndSettle();

      expect(selected, ProjectListStatus.completed);
      expect(tester.takeException(), isNull);
    });
  });
}

final class _ProjectListTransport implements RpcTransport {
  Uri? uri;
  String? method;
  String? body;

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

    final response = jsonEncode([
      {
        'result': {
          'data': {'json': <Object?>[]},
        },
      },
    ]);
    final bytes = Uint8List.fromList(utf8.encode(response));

    return TransportResponse(200, bytes);
  }

  @override
  void close() {
    // This test-only transport owns no external resources.
  }
}
