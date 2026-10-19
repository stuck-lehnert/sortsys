import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/features/vendors/vendor_list_screen.dart';
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

  test('vendor sorting is stable, empty-last and does not mutate input', () {
    final rows = [
      _vendor('b', 'Beta', 'Zulu'),
      _vendor('empty', '', null),
      _vendor('a', 'alpha', 'Able'),
      _vendor('a2', 'ALPHA', 'able'),
    ];
    final original = List.of(rows);

    expect(sortedVendors(rows, null), orderedEquals(original));
    expect(
      sortedVendors(rows, VendorSortColumn.name).map((row) => row.id),
      ['a', 'a2', 'b', 'empty'],
    );
    expect(
      sortedVendors(
        rows,
        VendorSortColumn.description,
        descending: true,
      ).map((row) => row.id),
      ['b', 'a', 'a2', 'empty'],
    );
    expect(rows, orderedEquals(original));
  });

  testWidgets('desktop vendors expose canonical columns and sort cycle', (
    tester,
  ) async {
    final rows = [
      _vendor('b', 'Beta', 'Second'),
      _vendor('a', 'Alpha', 'First'),
    ];
    models.ProductVendor? selected;
    await _pump(tester, rows, onSelected: (vendor) {
      selected = vendor;
    });

    SsDataTable<models.ProductVendor> table() {
      return tester.widget<SsDataTable<models.ProductVendor>>(
        find.byType(SsDataTable<models.ProductVendor>),
      );
    }

    expect(
      table().columns.map((column) => column.label),
      ['Name', 'Beschreibung'],
    );
    expect(table().rows.first.id, 'b');
    expect(find.byType(SsTextField), findsNothing);
    expect(find.text('Erstellt'), findsNothing);
    await tester.tap(find.text('Name'));
    await tester.pumpAndSettle();

    expect(table().rows.first.id, 'a');
    await tester.tap(find.text('Name'));
    await tester.pumpAndSettle();

    expect(table().rows.first.id, 'b');
    await tester.tap(find.text('Name'));
    await tester.pumpAndSettle();

    expect(table().rows.first.id, 'b');
    expect(
      tester.widgetList<SsTableSortHeader>(
        find.byType(SsTableSortHeader),
      ).first.ascending,
      isNull,
    );
    table().onSelected!(rows.last);
    expect(selected, same(rows.last));
    expect(tester.takeException(), isNull);
  });

  testWidgets('vendor pagination is local and page-size changes reset it', (
    tester,
  ) async {
    final rows = List.generate(60, (index) {
      return _vendor('$index', 'Vendor $index', null);
    });
    await _pump(tester, rows);

    SsPagination pagination() {
      return tester.widget<SsPagination>(find.byType(SsPagination));
    }

    expect(pagination().pageSizes, [25, 50, 100]);
    pagination().onPage(3);
    await tester.pumpAndSettle();

    expect(pagination().page, 3);
    pagination().onPageSize(50);
    await tester.pumpAndSettle();

    expect(pagination().page, 1);
    expect(pagination().pageSize, 50);
    final table = tester.widget<SsDataTable<models.ProductVendor>>(
      find.byType(SsDataTable<models.ProductVendor>),
    );
    expect(table.rows.length, 50);
    expect(table.rows.first.id, '0');
    expect(tester.takeException(), isNull);
  });

  testWidgets('compact vendor cards retain genuine encoded detail links', (
    tester,
  ) async {
    final vendor = _vendor(' A&/B ', ' Nord & Süd ', 'No compact subtitle');
    models.ProductVendor? selected;
    await _pump(tester, [vendor], width: 900, onSelected: (value) {
      selected = value;
    });
    final link = tester.widget<SsLink>(find.byType(SsLink));

    expect(link.uri.toString(), '/products/vendors/%20A%26%2FB%20');
    expect(find.text(vendor.name), findsOneWidget);
    expect(find.text(vendor.description!), findsNothing);
    expect(find.byType(SsDataTable<models.ProductVendor>), findsNothing);
    await tester.tap(find.text(vendor.name));
    await tester.pumpAndSettle();

    expect(selected, same(vendor));
    expect(tester.takeException(), isNull);
  });

  testWidgets('empty vendor lists use canonical bilingual messages', (
    tester,
  ) async {
    await _pump(tester, const []);

    expect(find.text('Keine Einträge vorhanden.'), findsOneWidget);
    expect(find.byType(SsPagination), findsNothing);
    await _pump(tester, const [], locale: const Locale('en'));

    expect(find.text('No entries available.'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('vendor cards scroll at 320px with doubled actual-font text', (
    tester,
  ) async {
    final rows = List.generate(10, (index) {
      return _vendor(
        '$index',
        'Baustoffhandel für Werkzeuge und Industriebedarf $index',
        null,
      );
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
  List<models.ProductVendor> rows, {
  double width = 1200,
  double height = 900,
  double scale = 1,
  Locale locale = const Locale('de'),
  ValueChanged<models.ProductVendor>? onSelected,
}) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = Size(width, height);
  addTearDown(tester.view.resetDevicePixelRatio);
  addTearDown(tester.view.resetPhysicalSize);

  await tester.pumpWidget(
    MaterialApp(
      locale: locale,
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
        body: VendorListRows(
          rows: rows,
          onSelected: onSelected ?? (_) {},
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

models.ProductVendor _vendor(String id, String name, String? description) {
  return models.ProductVendor(
    id: id,
    name: name,
    description: description,
    createdAt: DateTime.utc(2026, 1, 1),
    modifiedAt: DateTime.utc(2026, 1, 2),
  );
}
