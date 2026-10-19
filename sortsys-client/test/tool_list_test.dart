import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/features/tools/tool_list_screen.dart';
import 'package:sortsys_client/features/tools/tool_list_state.dart';
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

  test('Tools URL state reads first values and rejects invalid sorting', () {
    final uri = Uri(
      path: '/tools',
      queryParameters: {
        'pageTools': ['2', '8'],
        'pageSizeTools': '50',
        'sortTools': '[3,"DESC"]',
      },
    );
    final state = ToolListState.fromUri(uri);

    expect(state.page, 2);
    expect(state.pageSize, 50);
    expect(state.column, ToolSortColumn.category);
    expect(state.descending, isTrue);

    for (final sorting in ['invalid', '[9,"ASC"]', '[0,"asc"]', '{}']) {
      final invalid = ToolListState.fromUri(
        Uri(queryParameters: {
          'pageTools': '-3',
          'pageSizeTools': '7',
          'sortTools': sorting,
        }),
      );

      expect(invalid.page, 0);
      expect(invalid.pageSize, 25);
      expect(invalid.column, isNull);
      expect(invalid.descending, isFalse);
    }
  });

  test('Tools sort cycle preserves filters, repeated values and fragments', () {
    var uri = Uri.parse(
      '/tools?brand=A&brand=B&archived=yes&pageTools=3#context',
    );

    for (final expected in ['[2,"ASC"]', '[2,"DESC"]', null]) {
      uri = ToolListState.fromUri(uri).apply(
        uri,
        toggleColumn: ToolSortColumn.brand,
      );

      expect(uri.queryParameters['sortTools'], expected);
      expect(uri.queryParametersAll['brand'], ['A', 'B']);
      expect(uri.queryParameters['archived'], 'yes');
      expect(uri.fragment, 'context');
    }

    final resized = ToolListState.fromUri(uri).apply(
      uri,
      page: 0,
      pageSize: 100,
    );

    expect(resized.queryParameters.containsKey('pageTools'), isFalse);
    expect(resized.queryParameters['pageSizeTools'], '100');
    expect(resized.queryParametersAll['brand'], ['A', 'B']);
  });

  test('tool sorting is numeric, stable, empty-last and nonmutating', () {
    final rows = [
      _tool('ten', number: 10, label: null),
      _tool('two', number: 2, label: 'Alpha'),
      _tool('two-again', number: 2, label: 'ALPHA'),
    ];
    final original = List.of(rows);

    expect(
      sortedTools(
        rows,
        const ToolListState(column: ToolSortColumn.number),
        german: false,
      ).map((tool) => tool.id),
      ['two', 'two-again', 'ten'],
    );
    expect(
      sortedTools(
        rows,
        const ToolListState(column: ToolSortColumn.model, descending: true),
        german: false,
      ).map((tool) => tool.id),
      ['two', 'two-again', 'ten'],
    );
    expect(rows, orderedEquals(original));
    expect(
      sortedTools(rows, const ToolListState(), german: false),
      orderedEquals(original),
    );
  });

  test('tool status sorting uses canonical localized status labels', () {
    final rows = [
      _tool('available'),
      _tool('booked', available: false),
      _tool('missing', status: models.ToolStatus.lost),
      _tool('broken', status: models.ToolStatus.broken),
    ];
    const state = ToolListState(column: ToolSortColumn.status);

    expect(
      sortedTools(rows, state, german: true).map((tool) => tool.id),
      ['missing', 'broken', 'booked', 'available'],
    );
    expect(
      sortedTools(rows, state, german: false).map((tool) => tool.id),
      ['available', 'booked', 'broken', 'missing'],
    );
  });

  testWidgets('desktop tools use five canonical columns and medium tags', (
    tester,
  ) async {
    Uri? changed;
    models.Tool? selected;
    final tool = _tool('one');
    await _pump(
      tester,
      [tool],
      onStateChanged: (value) {
        changed = value;
      },
      onSelected: (value) {
        selected = value;
      },
    );
    final table = tester.widget<SsDataTable<models.Tool>>(
      find.byType(SsDataTable<models.Tool>),
    );

    expect(
      table.columns.map((column) => column.label),
      ['Number', 'Status', 'Brand', 'Category', 'Model'],
    );
    expect(tester.widget<SsTag>(find.byType(SsTag)).size, SsTagSize.medium);
    expect(find.text('41'), findsOneWidget);
    await tester.tap(find.text('Number'));
    await tester.pumpAndSettle();

    expect(changed!.queryParameters['sortTools'], '[0,"ASC"]');
    expect(changed!.queryParametersAll['brand'], ['A', 'B']);
    table.onSelected!(tool);
    expect(selected, same(tool));
    expect(tester.takeException(), isNull);
  });

  testWidgets('tool pagination clamps stale pages and resets size to first', (
    tester,
  ) async {
    Uri? changed;
    final rows = List.generate(60, (index) {
      return _tool('$index', number: index);
    });
    await _pump(
      tester,
      rows,
      state: const ToolListState(page: 99),
      onStateChanged: (value) {
        changed = value;
      },
    );
    final pagination = tester.widget<SsPagination>(find.byType(SsPagination));

    expect(pagination.page, 3);
    expect(pagination.pageSizes, [25, 50, 100]);
    pagination.onPageSize(100);
    expect(changed!.queryParameters.containsKey('pageTools'), isFalse);
    expect(changed!.queryParameters['pageSizeTools'], '100');
    expect(changed!.queryParametersAll['brand'], ['A', 'B']);
    expect(tester.takeException(), isNull);
  });

  testWidgets('compact tools retain encoded links and small status tags', (
    tester,
  ) async {
    final tool = _tool(' A&/B ', status: models.ToolStatus.lost);
    models.Tool? selected;
    await _pump(
      tester,
      [tool],
      width: 900,
      onSelected: (value) {
        selected = value;
      },
    );
    final link = tester.widget<SsLink>(find.byType(SsLink));
    final tag = tester.widget<SsTag>(find.byType(SsTag));

    expect(link.uri.toString(), '/tools/%20A%26%2FB%20');
    expect(tag.size, SsTagSize.small);
    expect(tag.tone, SsTagTone.red);
    expect(find.text('missing'), findsOneWidget);
    expect(find.text('41 Makita Bohrer HP 42'), findsOneWidget);
    expect(find.byType(SsDataTable<models.Tool>), findsNothing);
    await tester.tap(find.text('41 Makita Bohrer HP 42'));
    await tester.pumpAndSettle();

    expect(selected, same(tool));
    expect(tester.takeException(), isNull);
  });

  testWidgets('tool empty state and 320px doubled-font scrolling work', (
    tester,
  ) async {
    await _pump(tester, const []);

    expect(find.text('No entries available.'), findsOneWidget);
    expect(find.byType(SsPagination), findsNothing);
    final rows = List.generate(10, (index) {
      return _tool('$index', label: 'Werkzeuge für den Industriebedarf $index');
    });
    await _pump(tester, rows, width: 320, height: 380, scale: 2);
    final scroll = tester.state<ScrollableState>(
      find.descendant(
        of: find.byType(ListView),
        matching: find.byType(Scrollable),
      ),
    );

    expect(scroll.position.maxScrollExtent, greaterThan(0));
    expect(tester.takeException(), isNull);
    await tester.drag(find.byType(ListView), const Offset(0, -500));
    await tester.pumpAndSettle();

    expect(scroll.position.pixels, greaterThan(0));
    expect(tester.takeException(), isNull);
  });
}

Future<void> _pump(
  WidgetTester tester,
  List<models.Tool> rows, {
  ToolListState state = const ToolListState(),
  double width = 1200,
  double height = 900,
  double scale = 1,
  ValueChanged<Uri>? onStateChanged,
  ValueChanged<models.Tool>? onSelected,
}) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = Size(width, height);
  addTearDown(tester.view.resetDevicePixelRatio);
  addTearDown(tester.view.resetPhysicalSize);

  await tester.pumpWidget(
    MaterialApp(
      locale: const Locale('en'),
      supportedLocales: const [Locale('de'), Locale('en')],
      localizationsDelegates: GlobalMaterialLocalizations.delegates,
      builder: (context, child) {
        return SsTheme(
          colors: SsColors.light,
          child: MediaQuery(
            data: MediaQuery.of(context).copyWith(
              textScaler: TextScaler.linear(scale),
            ),
            child: child!,
          ),
        );
      },
      home: Scaffold(
        body: ToolListRows(
          rows: rows,
          state: state,
          uri: Uri.parse('/tools?brand=A&brand=B#context'),
          onStateChanged: onStateChanged ?? (_) {},
          onSelected: onSelected ?? (_) {},
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

models.Tool _tool(
  String id, {
  num number = 41,
  String? label = 'HP 42',
  models.ToolStatus? status,
  bool available = true,
}) {
  return models.Tool(
    id: id,
    customId: number,
    brand: 'Makita',
    category: 'Bohrer',
    label: label,
    status: status,
    available: available,
    createdAt: DateTime.utc(2026, 1, 1),
    modifiedAt: DateTime.utc(2026, 1, 1),
  );
}
