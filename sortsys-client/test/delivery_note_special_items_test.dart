import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/features/delivery_notes/delivery_note_special_items.dart';
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

  test('special item sorting is stable case-sensitive empty-last and copied', () {
    final rows = [
      _record('lower', name: 'a', amount: 2, price: 3),
      _record('upper', name: 'B', amount: 1),
      _record('empty', name: '', amount: 0, price: 0),
      _record('tie', name: 'B', amount: 1, price: 0),
    ];

    List<String> ids(DeliverySpecialSort column, {bool descending = false}) {
      return sortedDeliverySpecialItems(
        rows,
        column: column,
        descending: descending,
      ).map((record) => record.id).toList();
    }

    expect(ids(DeliverySpecialSort.name), ['upper', 'tie', 'lower', 'empty']);
    expect(ids(DeliverySpecialSort.name, descending: true),
        ['lower', 'upper', 'tie', 'empty']);
    expect(ids(DeliverySpecialSort.quantity), ['empty', 'upper', 'tie', 'lower']);
    expect(ids(DeliverySpecialSort.price), ['upper', 'empty', 'tie', 'lower']);
    expect(ids(DeliverySpecialSort.total), ['upper', 'empty', 'tie', 'lower']);
    expect(sortedDeliverySpecialItems(rows), orderedEquals(rows));
    expect(identical(sortedDeliverySpecialItems(rows), rows), isFalse);
    expect(rows.map((record) => record.id), ['lower', 'upper', 'empty', 'tie']);
  });

  testWidgets('special item columns preserve zero null prices and sort cycle', (
    tester,
  ) async {
    final rows = [
      _record('a', name: 'Zulu', amount: 0, price: 0),
      _record('b', name: 'Alpha', amount: 2),
    ];
    await _pump(tester, rows);

    SsDataTable<DeliverySpecialItem> table() {
      return tester.widget<SsDataTable<DeliverySpecialItem>>(
        find.byType(SsDataTable<DeliverySpecialItem>),
      );
    }

    expect(table().columns.map((column) => column.label),
        ['Name', 'Quantity', 'Price per unit', 'Total']);
    expect(find.text('€0.00'), findsNWidgets(2));
    expect(find.text('0.00 kg'), findsOneWidget);
    await tester.tap(find.text('Name'));
    await tester.pumpAndSettle();

    expect(table().rows.map((record) => record.id), ['b', 'a']);
    await tester.tap(find.text('Name'));
    await tester.pumpAndSettle();

    expect(table().rows.map((record) => record.id), ['a', 'b']);
    await tester.tap(find.text('Name'));
    await tester.pumpAndSettle();

    expect(table().rows, orderedEquals(rows));
    expect(tester.takeException(), isNull);
  });

  testWidgets('special pagination stays below table keeps page and clamps', (
    tester,
  ) async {
    final rows = List.generate(120, (index) {
      return _record('$index', name: 'Item $index', amount: index);
    });
    await _pump(tester, rows);

    SsPagination pagination() {
      return tester.widget<SsPagination>(find.byType(SsPagination));
    }

    SsDataTable<DeliverySpecialItem> table() {
      return tester.widget<SsDataTable<DeliverySpecialItem>>(
        find.byType(SsDataTable<DeliverySpecialItem>),
      );
    }

    expect(table().rows, orderedEquals(rows.take(25)));
    expect(pagination().pageSizes, [25, 50, 100]);
    expect(tester.getTopLeft(find.byType(SsPagination)).dy,
        greaterThanOrEqualTo(400));
    pagination().onPage(2);
    await tester.pumpAndSettle();

    expect(table().rows.first.id, '25');
    pagination().onPageSize(50);
    await tester.pumpAndSettle();

    expect(pagination().page, 2);
    expect(table().rows.first.id, '50');
    pagination().onPage(3);
    await tester.pumpAndSettle();

    expect(table().rows.first.id, '100');
    pagination().onPageSize(100);
    await tester.pumpAndSettle();

    expect(pagination().page, 2);
    expect(table().rows, orderedEquals(rows.skip(100)));
    expect(tester.takeException(), isNull);
  });

  testWidgets('German compact special items keep every field and scroll', (
    tester,
  ) async {
    final rows = List.generate(10, (index) {
      return _record('$index', name: 'Posten $index', amount: 2.5, price: 0);
    });
    await _pump(tester, rows, width: 320, scale: 2, locale: 'de');
    final labels = tester.widgetList<SsAttribute>(find.byType(SsAttribute)).map(
      (attribute) {
        return attribute.label;
      },
    );

    expect(labels.take(4), ['Bezeichnung', 'Menge', 'Preis pro Einheit', 'Gesamt']);
    final list = tester.widget<ListView>(find.byType(ListView));
    final cards = (list.childrenDelegate as SliverChildListDelegate).children;

    expect(cards, hasLength(10));

    for (var index = 0; index < cards.length; index++) {
      final surface = (cards[index] as Padding).child as SsSurface;
      final attributes = surface.child as SsAttributeList;
      final fields = attributes.children.cast<SsAttribute>().toList();

      expect(fields.map((field) => field.label),
          ['Bezeichnung', 'Menge', 'Preis pro Einheit', 'Gesamt']);
      expect((fields[0].child as Text).data, 'Posten $index');
      expect((fields[1].child as Text).data, '2,50 kg');
      expect((fields[2].child as Text).data, '0,00\u00a0€');
      expect((fields[3].child as Text).data, '0,00\u00a0€');
    }

    expect(find.text('Posten 0').hitTestable(), findsOneWidget);
    final scroll = tester.state<ScrollableState>(
      find.descendant(of: find.byType(ListView), matching: find.byType(Scrollable)),
    );

    expect(scroll.position.maxScrollExtent, greaterThan(0));
    await tester.drag(find.byType(ListView), const Offset(0, -500));
    await tester.pumpAndSettle();

    expect(scroll.position.pixels, greaterThan(0));
    await tester.scrollUntilVisible(
      find.text('Posten 9'),
      200,
      scrollable: find.byType(Scrollable),
    );
    await tester.pumpAndSettle();

    expect(find.text('Posten 9').hitTestable(), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}

DeliverySpecialItem _record(
  String id, {
  required String name,
  required num amount,
  num? price,
}) {
  return DeliverySpecialItem(
    id: id,
    noteId: 'note',
    name: name,
    unit: 'kg',
    amount: amount,
    pricePerUnit: price,
  );
}

Future<void> _pump(
  WidgetTester tester,
  List<DeliverySpecialItem> rows, {
  double width = 1200,
  double scale = 1,
  String locale = 'en',
}) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = Size(width, 900);
  addTearDown(tester.view.resetDevicePixelRatio);
  addTearDown(tester.view.resetPhysicalSize);

  await tester.pumpWidget(
    MaterialApp(
      locale: Locale(locale),
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
      home: Scaffold(body: DeliveryNoteSpecialItems(records: rows)),
    ),
  );
  await tester.pumpAndSettle();
}
