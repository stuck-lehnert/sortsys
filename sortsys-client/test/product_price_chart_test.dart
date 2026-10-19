import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/features/products/product_price_chart.dart';
import 'package:sortsys_client/features/products/product_price_history.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

void main() {
  test('price chart uses canonical domain, margins and green', () {
    final painter = ProductPricePainter(
      prices: [10, 20],
      gridColor: Colors.grey,
    );
    final points = painter.points(const Size(320, 150));

    expect(productPriceGreen, const Color(0xff43a047));
    expect(points.first.dx, 8);
    expect(points.last.dx, 312);
    expect(points.first.dy, closeTo(8 + 142 * (1 - 4 / 18), 0.001));
    expect(points.last.dy, closeTo(8 + 142 * (1 - 14 / 18), 0.001));
  });

  test('empty, zero, single and narrow chart geometry stays finite', () {
    for (final prices in <List<num>>[
      [],
      [0],
      [0, 0],
      [12],
    ]) {
      final painter = ProductPricePainter(
        prices: prices,
        gridColor: Colors.grey,
      );
      final points = painter.points(const Size(320, 150));

      expect(points.length, prices.length);
      expect(
        points.every((point) => point.dx.isFinite && point.dy.isFinite),
        isTrue,
      );
      expect(painter.points(const Size(8, 150)), isEmpty);
    }
  });

  testWidgets('chart reverses a copy and exposes the selected EUR price', (
    tester,
  ) async {
    final records = [_record('recent', 3, 20), _record('old', 1, 0)];

    await _pump(tester, records);

    final chart = find.byType(ProductPriceChart);
    final origin = tester.getTopLeft(chart);

    expect(tester.getSize(chart).height, 150);
    await tester.tapAt(origin + const Offset(8, 100));
    await tester.pump();

    expect(find.text('01/02/2026\nPreis : €0.00 / kg'), findsOneWidget);
    expect(records.map((record) => record.id), ['recent', 'old']);
    await tester.tapAt(origin + const Offset(310, 100));
    await tester.pump();

    expect(find.text('03/02/2026\nPreis : €20.00 / kg'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('history displays the chart only for at least two records', (
    tester,
  ) async {
    await _pump(tester, [
      _record('recent', 3, 20),
      _record('old', 1, 0),
    ], history: true);

    expect(
      tester.widget<SsDisclosure>(find.byType(SsDisclosure)).initiallyExpanded,
      isFalse,
    );
    await tester.tap(find.text('Price history'));
    await tester.pumpAndSettle();

    expect(find.byType(ProductPriceChart), findsOneWidget);
    await _pump(tester, [_record('only', 1, 0)], history: true);

    expect(find.byType(ProductPriceChart), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('German chart tooltip remains usable at 320px and doubled text', (
    tester,
  ) async {
    await _pump(
      tester,
      [_record('recent', 3, 20), _record('old', 1, 0)],
      german: true,
      scale: 2,
    );

    final origin = tester.getTopLeft(find.byType(ProductPriceChart));

    await tester.tapAt(origin + const Offset(8, 100));
    await tester.pump();

    expect(find.text('01.02.2026\nPreis : 0,00 € / kg'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}

Future<void> _pump(
  WidgetTester tester,
  List<ProductPriceRecord> records, {
  bool german = false,
  double scale = 1,
  bool history = false,
}) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = const Size(320, 700);
  addTearDown(tester.view.resetDevicePixelRatio);
  addTearDown(tester.view.resetPhysicalSize);

  await tester.pumpWidget(
    MaterialApp(
      locale: Locale(german ? 'de' : 'en'),
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
        body: history
            ? ProductPriceHistory(
                productId: 'product-1',
                baseUnit: 'kg',
                records: records,
                chart: ProductPriceChart(records: records, baseUnit: 'kg'),
              )
            : ProductPriceChart(records: records, baseUnit: 'kg'),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

ProductPriceRecord _record(String id, int day, num price) {
  return ProductPriceRecord(
    id: id,
    productId: 'product-1',
    timestamp: DateTime.utc(2026, 2, day),
    price: price,
    isRealPurchase: true,
  );
}
