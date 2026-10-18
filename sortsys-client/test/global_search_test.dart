import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/api/procedure.dart';
import 'package:sortsys_client/features/search/command_palette.dart';
import 'package:sortsys_client/features/search/command_palette_controller.dart';
import 'package:sortsys_client/features/search/global_search.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

final _date = DateTime.utc(2026, 10, 11);

models.Project _project(String id, {bool finished = false}) {
  return models.Project(
    id: id,
    title: 'Project $id',
    createdAt: _date,
    modifiedAt: _date,
    finishedAt: finished ? _date : null,
  );
}

const _commands = [
  PaletteCommand(
    id: 'projects.create',
    label: 'Create project',
    description: 'Create a new project.',
    icon: 'building',
    group: PaletteGroup.create,
    role: 'manage:projects',
  ),
  PaletteCommand(
    id: 'deployments.open',
    label: 'Open resource planning',
    description: 'Plan project assignments and absences.',
    icon: 'calendar',
    group: PaletteGroup.navigate,
    role: 'view:projectDeployments',
    href: '/deployments',
  ),
];

class _SearchReads {
  final requests = <({String path, Object? input})>[];
  final responses = <String, Object?>{};

  Future<O> read<I, O>(RpcQuery<I, O> query, I input) async {
    requests.add((path: query.path, input: query.encodeInput(input)));
    final response = responses[query.path];

    if (response is Exception) {
      throw response;
    }

    if (response is Error) {
      throw response;
    }

    final Object? value;

    if (response is Future<Object?>) {
      value = await response;
    } else {
      value = response ?? const <Object?>[];
    }

    return query.decodeOutput(value);
  }

  GlobalSearchRepository repository({
    bool Function(String)? can,
    bool Function()? isCurrent,
  }) {
    return GlobalSearchRepository(
      read: read,
      can:
          can ??
          (_) {
            return true;
          },

      isCurrent:
          isCurrent ??
          () {
            return true;
          },
    );
  }
}

Future<void> _openPalette(
  WidgetTester tester, {
  required GlobalSearchRepository repository,
  required ChangeNotifier scope,
  required ValueChanged<PaletteEntry?> selected,
  double scale = 1,
}) async {
  await tester.pumpWidget(
    MaterialApp(
      builder: (context, child) {
        return MediaQuery(
          data: MediaQuery.of(
            context,
          ).copyWith(textScaler: TextScaler.linear(scale)),
          child: SsTheme(colors: SsColors.light, child: child!),
        );
      },

      home: Scaffold(
        body: Builder(
          builder: (context) {
            return SsButton(
              onPressed: () {
                unawaited(
                  showGeneralDialog<PaletteEntry>(
                    context: context,
                    barrierDismissible: true,
                    barrierLabel: 'Close',
                    pageBuilder: (context, animation, secondaryAnimation) {
                      return CommandPaletteDialog(
                        repository: repository,
                        commands: _commands,
                        scopeChanges: scope,
                      );
                    },
                  ).then(selected),
                );
              },

              child: const Text('Open search'),
            );
          },
        ),
      ),
    ),
  );
  await tester.tap(find.text('Open search'));
  await tester.pumpAndSettle();
}

void main() {
  test(
    'search preserves canonical order, caps each source and includes finished projects',
    () async {
      final reads = _SearchReads();
      reads.responses['projects.list'] = [
        for (var index = 0; index < 12; index += 1)
          _project('$index', finished: true).toWire(),
      ];

      final batch = await reads.repository().search('  Crane  ');

      expect(
        reads.requests.map((request) {
          return request.path;
        }),

        [
          'projects.list',
          'tools.list',
          'users.list',
          'products.list',
          'customers.list',
          'contacts.list',
          'products.vendors.list',
        ],
      );
      expect(reads.requests.first.input, {'search': 'crane'});
      expect(
        batch.hits.map((hit) {
          return hit.id;
        }),

        List.generate(8, (index) {
          return '$index';
        }),
      );
      expect(batch.failures, isEmpty);
    },
  );

  test(
    'role gating, empty text and command-only input dispatch no unauthorized query',
    () async {
      final reads = _SearchReads();
      final repository = reads.repository(
        can: (role) {
          return role == 'view:projects';
        },
      );

      await repository.search('');
      await repository.search(' > create');
      expect(reads.requests, isEmpty);

      await repository.search('Crane');
      expect(reads.requests.single.path, 'projects.list');
    },
  );

  test(
    'numeric search uses the generated autoId lookup union and actual note link',
    () async {
      final reads = _SearchReads();
      final note = models.DeliveryNote(
        id: 'note/12',
        autoId: 12,
        projectId: 'project',
        createdAt: _date,
        effectiveTimestamp: _date,
        records: const [],
        specialRecords: const [],
      );
      reads.responses['deliveryNotes.get'] = note.toWire();

      final batch = await reads.repository().search('#12suffix');
      final hit = batch.hits.single;

      expect(reads.requests.last.path, 'deliveryNotes.get');
      expect(reads.requests.last.input, {'autoId': 12});
      expect(hit.title, '#12');
      expect(hit.recordedAt, _date);
      expect(hit.href, '/products/deliveryNotes/note%2F12');
    },
  );

  test(
    'delivery number matching follows the canonical decimal-prefix parsing',
    () {
      expect(deliveryNoteSearchNumber(' # 12abc '), 12);
      expect(deliveryNoteSearchNumber('3.25'), 3);
      expect(deliveryNoteSearchNumber('+42 extra'), 42);
      expect(deliveryNoteSearchNumber('abc12'), isNull);
      expect(deliveryNoteSearchNumber('#'), isNull);
      expect(deliveryNoteSearchNumber('9' * 400), isNull);
    },
  );

  test('one failed source keeps real hits and reports the failure', () async {
    final reads = _SearchReads();
    reads.responses['projects.list'] = [_project('one').toWire()];
    reads.responses['tools.list'] = StateError('unavailable');

    final batch = await reads.repository().search('one');

    expect(batch.hits.single.id, 'one');
    expect(batch.failures.keys, [SearchResource.tool]);
  });

  test('a changed session rejects every old-scope result', () async {
    final reads = _SearchReads();
    final pending = Completer<Object?>();
    reads.responses['projects.list'] = pending.future;
    var current = true;
    final repository = reads.repository(
      isCurrent: () {
        return current;
      },
    );

    final request = repository.search('one');
    current = false;
    pending.complete([_project('one').toWire()]);

    await expectLater(request, throwsStateError);
  });

  test(
    'result titles use actual Webapp domain formatting, not generic detail fallbacks',
    () {
      final tool = models.Tool(
        id: 'tool',
        customId: 42,
        brand: 'Hilti',
        category: 'Hammer',
        label: 'TE 6',
        available: true,
        createdAt: _date,
        modifiedAt: _date,
      );
      final product = models.Product(
        id: 'product',
        customId: 7,
        name: 'Bolt',
        brand: 'Acme',
        description: 'Not the title',
        baseUnit: 'piece',
        categories: const [],
        otherUnits: models.ApplyPriceImportRowOtherUnits.fromWire(
          const <String, Object?>{},
        ),
      );
      final customer = models.Customer(
        id: 'customer',
        name: 'Lehnert',
        salutation: 'Firma',
        phoneNumbers: const [],
        emailAddresses: const [],
        createdAt: _date,
        modifiedAt: _date,
      );
      final contact = models.Contact(
        id: 'contact',
        salutation: 'Dr.',
        firstName: 'Ada',
        lastName: 'Lovelace',
        phoneNumbers: const [],
        emailAddresses: const [],
        createdAt: _date,
        modifiedAt: _date,
      );

      expect(SearchHit.fromResource(tool).title, '42 Hilti Hammer TE 6');
      expect(SearchHit.fromResource(product).title, '7 Acme Bolt');
      expect(SearchHit.fromResource(customer).title, 'Firma Lehnert');
      expect(SearchHit.fromResource(contact).title, 'Dr. Ada Lovelace');
    },
  );

  testWidgets(
    '180ms debounce, clearing and stale completions keep only current query hits',
    (tester) async {
      final reads = _SearchReads();
      final old = Completer<Object?>();
      reads.responses['projects.list'] = old.future;
      final controller = CommandPaletteController(
        repository: reads.repository(
          can: (role) {
            return role == 'view:projects';
          },
        ),

        commands: const [],
      );
      addTearDown(controller.dispose);

      controller.setQuery('old');
      await tester.pump(const Duration(milliseconds: 179));
      expect(reads.requests, isEmpty);
      await tester.pump(const Duration(milliseconds: 1));
      expect(reads.requests, hasLength(1));

      reads.responses['projects.list'] = [_project('new').toWire()];
      controller.setQuery('new');
      expect(controller.entries, isEmpty);
      await tester.pump(const Duration(milliseconds: 180));
      expect(controller.entries.single.hit?.id, 'new');

      old.complete([_project('old').toWire()]);
      await tester.pump();
      expect(controller.entries.single.hit?.id, 'new');
      expect(controller.searching, isFalse);
    },
  );

  testWidgets(
    'recent actions are deduplicated, permission-filtered and do not trust stored labels/hrefs',
    (tester) async {
      final reads = _SearchReads();
      reads.responses['personalization.actions.list'] = [
        for (final id in [
          'unknown',
          'deployments.open',
          'projects.create',
          'projects.create',
        ])
          models.PersonalizationActionsListResultItem(
            id: id,
            actionId: id,
            label: 'Untrusted old label',
            href: 'https://untrusted.invalid/',
            usedAt: _date,
          ).toWire(),
      ];
      final controller = CommandPaletteController(
        repository: reads.repository(
          can: (role) {
            return role == 'manage:projects';
          },
        ),

        commands: _commands,
      );
      addTearDown(controller.dispose);

      await controller.loadRecentActions();

      expect(reads.requests.single.input, {'limit': 10});
      expect(controller.entries, hasLength(1));
      expect(controller.entries.single.group, PaletteGroup.recent);
      expect(controller.entries.single.title, 'Create project');
      expect(controller.entries.single.command?.href, isNull);

      controller.setQuery(' > new project');
      expect(controller.entries.single.command?.id, 'projects.create');
      expect(controller.entries.single.group, PaletteGroup.create);
      await tester.pump(const Duration(milliseconds: 200));
      expect(reads.requests, hasLength(1));
    },
  );

  testWidgets(
    'keyboard selection wraps, accepts Enter and returns the actual command',
    (tester) async {
      final scope = ChangeNotifier();
      addTearDown(scope.dispose);
      PaletteEntry? selected;

      await _openPalette(
        tester,
        repository: _SearchReads().repository(),
        scope: scope,
        selected: (entry) {
          selected = entry;
        },
      );
      expect(find.byType(TextField), findsOneWidget);
      await tester.sendKeyEvent(LogicalKeyboardKey.arrowUp);
      await tester.pumpAndSettle();
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();

      expect(selected?.command?.id, 'deployments.open');
      expect(find.byType(CommandPaletteDialog), findsNothing);
      expect(tester.takeException(), isNull);
    },
  );

  for (final scale in [1.0, 2.0]) {
    testWidgets(
      'compact palette supports search and Escape at320px, scale$scale',
      (tester) async {
        tester.view.devicePixelRatio = 1;
        tester.view.physicalSize = const Size(320, 700);
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        addTearDown(() async {
          await tester.binding.setSurfaceSize(null);
        });

        final scope = ChangeNotifier();
        addTearDown(scope.dispose);
        final reads = _SearchReads();
        reads.responses['projects.list'] = [_project('found').toWire()];

        await _openPalette(
          tester,
          repository: reads.repository(),
          scope: scope,
          scale: scale,
          selected: (entry) {
            expect(entry, isNull);
          },
        );
        await tester.enterText(find.byType(TextField), 'found');
        await tester.pump(const Duration(milliseconds: 180));
        await tester.pumpAndSettle();

        expect(find.text('Project found'), findsOneWidget);
        expect(tester.takeException(), isNull);
        await tester.sendKeyEvent(LogicalKeyboardKey.escape);
        await tester.pumpAndSettle();
        expect(find.byType(CommandPaletteDialog), findsNothing);
      },
    );
  }

  testWidgets(
    'scope change removes results and dismisses the palette without activating a hit',
    (tester) async {
      final scope = ChangeNotifier();
      addTearDown(scope.dispose);
      var current = true;
      PaletteEntry? selected;

      await _openPalette(
        tester,
        repository: _SearchReads().repository(
          isCurrent: () {
            return current;
          },
        ),

        scope: scope,
        selected: (entry) {
          selected = entry;
        },
      );
      current = false;
      scope.notifyListeners();
      await tester.pumpAndSettle();

      expect(selected, isNull);
      expect(find.byType(CommandPaletteDialog), findsNothing);
      expect(tester.takeException(), isNull);
    },
  );
}
