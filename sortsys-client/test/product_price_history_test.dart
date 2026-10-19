import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/features/products/product_price_history.dart';
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
    'price history ordering is stable and does not mutate source records',
    () {
      final old = _record('old', day: 1, price: 10);
      final recent = _record('recent', day: 3, price: 0);
      final tied = _record('tie', day: 3, price: 0);
      final records = [old, recent, tied];

      expect(sortedProductPrices(records), [recent, tied, old]);
      expect(
        sortedProductPrices(
          records,
          column: ProductPriceSort.price,
          descending: false,
        ),
        [recent, tied, old],
      );
      expect(records, [old, recent, tied]);
    },
  );

  testWidgets('desktop history has canonical columns, dates and sort cycle', (
    tester,
  ) async {
    final rows = [
      _record('old', day: 1, price: 10),
      _record('new', day: 3, price: 0, vendorId: 'vendor-1'),
    ];
    await _pump(tester, rows);

    SsDataTable<ProductPriceRecord> table() {
      return tester.widget<SsDataTable<ProductPriceRecord>>(
        find.byType(SsDataTable<ProductPriceRecord>),
      );
    }

    expect(table().columns.map((column) => column.label), [
      'Date',
      'Price',
      'Vendor',
    ]);
    expect(table().rows.first.id, 'new');
    expect(find.text('03/02/2026'), findsOneWidget);
    expect(find.text('€0.00 / kg'), findsOneWidget);
    expect(
      tester.widget<SsLink>(find.byType(SsLink)).uri.toString(),
      '/products/vendors/vendor-1',
    );
    await tester.tap(find.text('Date'));
    await tester.pumpAndSettle();

    expect(table().rows.first.id, 'old');
    await tester.tap(find.text('Date'));
    await tester.pumpAndSettle();

    expect(table().rows.first.id, 'new');
    await tester.tap(find.text('Date'));
    await tester.pumpAndSettle();

    expect(table().rows.first.id, 'new');
    expect(tester.takeException(), isNull);
  });

  testWidgets('history pagination stays below the table and resets page size', (
    tester,
  ) async {
    final rows = List.generate(60, (index) {
      return _record('$index', day: 1, price: index);
    });
    await _pump(tester, rows);

    SsPagination pagination() {
      return tester.widget<SsPagination>(find.byType(SsPagination));
    }

    expect(pagination().pageSizes, [25, 50, 100]);
    expect(
      tester.getTopLeft(find.byType(SsPagination)).dy,
      greaterThanOrEqualTo(320),
    );
    pagination().onPage(3);
    await tester.pumpAndSettle();

    expect(pagination().page, 3);
    pagination().onPageSize(100);
    await tester.pumpAndSettle();

    expect(pagination().page, 1);
    expect(pagination().pageSize, 100);
    expect(find.text('Rows 1–60 of 60'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('compact history omits missing vendors and scrolls at 320px', (
    tester,
  ) async {
    final rows = List.generate(10, (index) {
      return _record(
        '$index',
        day: index + 1,
        price: index,
        vendorId: index == 9 ? ' A&/B ' : null,
      );
    });
    await _pump(tester, rows, width: 320, scale: 2);
    final labels = tester.widgetList<SsAttribute>(find.byType(SsAttribute)).map(
      (attribute) {
        return attribute.label;
      },
    );

    expect(labels.where((label) => label == 'Vendor'), hasLength(1));
    expect(labels, isNot(contains('Produkt')));
    final link = tester.widget<SsLink>(find.byType(SsLink));

    expect(link.uri.toString(), '/products/vendors/%20A%26%2FB%20');
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
  List<ProductPriceRecord> records, {
  double width = 1200,
  double scale = 1,
}) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = Size(width, 900);
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
            data: MediaQuery.of(context)
                .copyWith(textScaler: TextScaler.linear(scale)),
            child: child!,
          ),
        );
      },
      home: Scaffold(
        body: ProductPriceHistoryContent(
          records: records,
          baseUnit: 'kg',
          vendorBuilder: (context, id, compact) {
            return SsLink(
              uri: Uri.parse('/products/vendors/${Uri.encodeComponent(id)}'),
              onPressed: () {},
              child: Text('Vendor $id'),
            );
          },
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

ProductPriceRecord _record(
  String id, {
  required int day,
  required num price,
  String? vendorId,
}) {
  return ProductPriceRecord(
    id: id,
    productId: 'product-1',
    vendorId: vendorId,
    timestamp: DateTime.utc(2026, 2, day),
    price: price,
    isRealPurchase: true,
  );
}
