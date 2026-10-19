import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/features/projects/project_tool_bookings.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

void main() {
  setUpAll(() async {
    final fonts = FontLoader('packages/sortsys_ui/Ubuntu');

    for (final weight in ['Regular', 'Medium', 'Bold']) {
      fonts.addFont(
        rootBundle.load(
          'packages/sortsys_ui/assets/fonts/ubuntu/Ubuntu-$weight.ttf',
        ),
      );
    }

    await fonts.load();
  });

  test(
    'active bookings request preserves canonical filters and server bounds',
    () {
      expect(projectBookingsInput('project-1').toWire(), {
        'projectId': 'project-1',
        'finished': false,
      });
    },
  );

  test('date sorting is stable immutable and resets to newest-first input', () {
    final rows = [
      _row('old', day: 10),
      _row('new', day: 12),
      _row('same', day: 12),
    ];
    final initial = sortedProjectBookings(rows);
    final ascending = sortedProjectBookings(
      rows,
      sort: ProjectBookingSort.started,
    );
    final descending = sortedProjectBookings(
      rows,
      sort: ProjectBookingSort.started,
      descending: true,
    );

    expect(
      initial.map((row) {
        return row.id;
      }),
      ['new', 'same', 'old'],
    );
    expect(
      ascending.map((row) {
        return row.id;
      }),
      ['old', 'new', 'same'],
    );
    expect(
      descending.map((row) {
        return row.id;
      }),
      ['new', 'same', 'old'],
    );
    expect(
      rows.map((row) {
        return row.id;
      }),
      ['old', 'new', 'same'],
    );
    expect(() {
      initial.add(_row('extra'));
    }, throwsUnsupportedError);

    final ended = _row('ended', ended: DateTime.utc(2026, 10, 15));
    final open = _row('open');
    expect(
      sortedProjectBookings([open, ended], sort: ProjectBookingSort.ended).map((
        row,
      ) {
        return row.id;
      }),
      ['ended', 'open'],
    );
    expect(
      sortedProjectBookings(
        [open, ended],
        sort: ProjectBookingSort.ended,
        descending: true,
      ).map((row) {
        return row.id;
      }),
      ['open', 'ended'],
    );
  });

  testWidgets(
    'desktop keeps five canonical columns and local date sort cycling',
    (tester) async {
      await _pump(
        tester,
        _content([_row('older', day: 10), _row('newer', day: 12)]),
      );
      expect(find.text('Tool'), findsOneWidget);
      expect(find.text('Responsible'), findsOneWidget);
      expect(find.text('Issuer'), findsOneWidget);
      expect(find.text('From'), findsOneWidget);
      expect(find.text('Until'), findsOneWidget);
      expect(find.byType(SsTableSortHeader), findsNWidgets(2));
      expect(find.text('Project'), findsNothing);
      expect(find.text('open'), findsNWidgets(2));

      List<String> order() {
        return tester
            .widgetList<SsLink>(find.byType(SsLink))
            .where((link) {
              return link.uri?.path.startsWith('/tools/') == true;
            })
            .map((link) {
              return link.uri!.path;
            })
            .toList();
      }

      expect(order(), ['/tools/newer', '/tools/older']);
      await tester.tap(find.text('From'));
      await tester.pumpAndSettle();
      expect(order(), ['/tools/older', '/tools/newer']);
      await tester.tap(find.text('From'));
      await tester.pumpAndSettle();
      expect(order(), ['/tools/newer', '/tools/older']);
      await tester.tap(find.text('From'));
      await tester.pumpAndSettle();
      expect(order(), ['/tools/newer', '/tools/older']);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'local pagination resets on size change and stays below viewport',
    (tester) async {
      await _pump(
        tester,
        _content([
          for (var index = 0; index < 70; index++) _row('tool-$index'),
        ]),
      );
      var pagination = tester.widget<SsPagination>(find.byType(SsPagination));
      expect(pagination.pageSizes, [25, 50, 100]);
      pagination.onPage(3);
      await tester.pumpAndSettle();
      pagination = tester.widget<SsPagination>(find.byType(SsPagination));
      expect(pagination.page, 3);
      pagination.onPageSize(50);
      await tester.pumpAndSettle();
      pagination = tester.widget<SsPagination>(find.byType(SsPagination));
      expect(pagination.page, 1);
      expect(pagination.pageSize, 50);
      expect(
        tester.getTopLeft(find.byType(SsPagination)).dy,
        greaterThanOrEqualTo(320),
      );
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'compact card preserves conditional fields and inline targets at scale2',
    (tester) async {
      await _pump(
        tester,
        _content([
          _row(
            'drill',
            responsible: 'worker',
            author: 'issuer',
            deadline: DateTime.utc(2026, 10, 20),
          ),
        ]),
        width: 320,
        scale: 2,
      );
      expect(
        find.byType(SsDataTable<models.ToolsTrackingsListResultItem>),
        findsNothing,
      );
      final labels = tester
          .widgetList<SsAttribute>(find.byType(SsAttribute))
          .map((attribute) {
            return attribute.label;
          })
          .toList();
      expect(labels, ['Tool', 'Responsible', 'Issuer', 'Since', 'Deadline']);
      expect(find.text('worker'), findsOneWidget);
      expect(find.text('issuer'), findsOneWidget);
      expect(find.text('Project'), findsNothing);
      final links = tester.widgetList<SsLink>(find.byType(SsLink)).map((link) {
        return link.uri.toString();
      }).toList();
      expect(links, ['/tools/drill', '/users/worker', '/users/issuer']);

      await tester.scrollUntilVisible(
        find.text('10/20/2026'),
        120,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.pumpAndSettle();
      expect(
        tester.getRect(find.text('10/20/2026')).bottom,
        lessThanOrEqualTo(320),
      );
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'loading error and empty keep desktop headers and genuine retry',
    (tester) async {
      var retries = 0;
      await _pump(tester, _content([], loading: true), settle: false);
      expect(find.text('Loading entries …'), findsOneWidget);
      expect(find.byType(SsTableSortHeader), findsNWidgets(2));
      expect(find.byType(SsPagination), findsNothing);
      await _pump(
        tester,
        _content(
          [],
          error: StateError('Unavailable'),
          onRetry: () {
            retries++;
          },
        ),
      );
      expect(find.text('Entries could not be loaded.'), findsOneWidget);
      expect(find.byType(SsTableSortHeader), findsNWidgets(2));
      await tester.tap(find.text('Reload'));
      await tester.pump();
      expect(retries, 1);
      await _pump(tester, _content([]));
      expect(find.text('No entries available.'), findsOneWidget);
      expect(find.byType(SsTableSortHeader), findsNWidgets(2));
      expect(find.byType(SsPagination), findsNothing);
      expect(tester.takeException(), isNull);
    },
  );
}

ProjectToolBooking _row(
  String id, {
  int day = 12,
  DateTime? ended,
  DateTime? deadline,
  String? responsible,
  String? author,
}) {
  return models.ToolsTrackingsListResultItem(
    id: id,
    toolId: id,
    projectId: 'project-1',
    responsibleUserId: responsible,
    startedByUserId: author,
    startedAt: DateTime.utc(2026, 10, day, 12),
    endedAt: ended,
    deadlineAt: deadline,
  );
}

Widget _content(
  List<ProjectToolBooking> rows, {
  bool loading = false,
  Object? error,
  VoidCallback? onRetry,
}) {
  return ProjectToolBookingsContent(
    rows: rows,
    loading: loading,
    error: error,
    onRetry: onRetry,
    toolBuilder: (context, id) {
      return SsLink(
        uri: Uri.parse('/tools/${Uri.encodeComponent(id)}'),
        onPressed: () {},
        child: Text(id),
      );
    },
    userBuilder: (context, id, comma) {
      return SsLink(
        uri: Uri.parse('/users/${Uri.encodeComponent(id)}'),
        onPressed: () {},
        child: Text(comma ? '$id, Name' : id),
      );
    },
  );
}

Future<void> _pump(
  WidgetTester tester,
  Widget content, {
  double width = 1500,
  double scale = 1,
  bool settle = true,
}) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = Size(width, 800);
  addTearDown(tester.view.resetDevicePixelRatio);
  addTearDown(tester.view.resetPhysicalSize);

  await tester.pumpWidget(
    MaterialApp(
      locale: const Locale('en'),
      builder: (context, child) {
        return SsTheme(
          colors: SsColors.light,
          child: MediaQuery(
            data: MediaQuery.of(context)
                .copyWith(textScaler: TextScaler.linear(scale)),
            child: child!,
          ),
        );
      },
      home: Scaffold(
        body: Align(
          alignment: Alignment.topLeft,
          child: SingleChildScrollView(child: content),
        ),
      ),
    ),
  );
  if (settle) {
    await tester.pumpAndSettle();
  } else {
    await tester.pump(const Duration(milliseconds: 100));
  }
}
