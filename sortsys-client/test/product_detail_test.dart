import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/features/products/product_detail_layout.dart';
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

  test('product titles preserve canonical truthiness and whitespace', () {
    expect(productTitle(_product(brand: null)), 'Cement');
    expect(productTitle(_product(brand: '')), 'Cement');
    expect(productTitle(_product(brand: ' Harbor ')), ' Harbor  Cement');
    expect(productTitle(_product(name: '', brand: null)), '');
  });

  test('unit overview is stable, nonmutating and uses exact divisible units', () {
    final values = {'pallet': 1000, 'bag': 25, 'case': 100, 'zero': 0};
    final product = _product(units: values);
    final overview = productUnitsOverview(product);

    expect(overview.map((unit) => unit.unit), ['zero', 'bag', 'case', 'pallet']);
    expect(overview.last.equivalents, [
      (amount: 10, unit: 'case'),
      (amount: 40, unit: 'bag'),
      (amount: 1000, unit: 'kg'),
    ]);
    expect(overview[1].equivalents, [(amount: 25, unit: 'kg')]);
    expect(values.keys, ['pallet', 'bag', 'case', 'zero']);
    expect(() => overview.clear(), throwsUnsupportedError);
    expect(() => overview.last.equivalents.clear(), throwsUnsupportedError);
  });

  test('latest product price is stable and does not reorder source records', () {
    final older = _price('old', DateTime.utc(2026, 1, 1), 10);
    final newest = _price('new', DateTime.utc(2026, 2, 1), 0);
    final tied = _price('tie', DateTime.utc(2026, 2, 1), 12);
    final records = [older, newest, tied];

    expect(latestProductPrice(records), same(newest));
    expect(records, [older, newest, tied]);
    expect(latestProductPrice(const []), isNull);
  });

  testWidgets('product attributes and categories match canonical content', (
    tester,
  ) async {
    final product = _product(
      description: ' Ready for use ',
      regieReportName: ' Special designation ',
    );
    await _pump(
      tester,
      product,
      records: [_price('zero', DateTime.utc(2026, 1, 1), 0)],
    );

    expect(tester.widget<SsPageHeader>(find.byType(SsPageHeader)).title,
        'Harbor Cement');
    final labels = tester.widgetList<SsAttribute>(
      find.byType(SsAttribute),
    ).map((attribute) {
      return attribute.label;
    });

    expect(labels, containsAll(['Bezeichnung', 'Hersteller', 'Basiseinheit']));
    expect(find.text('BEZEICHNUNG'), findsOneWidget);
    expect(find.text('HERSTELLER'), findsOneWidget);
    expect(find.text('BASISEINHEIT'), findsOneWidget);
    expect(find.text(' Ready for use '), findsOneWidget);
    expect(find.text(' Special designation '), findsOneWidget);
    expect(find.text('0,00 € / kg'), findsOneWidget);
    expect(find.text('Erstellt'), findsNothing);
    expect(find.text('Geändert'), findsNothing);
    expect(tester.widget<SsTag>(find.byType(SsTag)).tone, SsTagTone.outline);
    expect(tester.widget<SsDisclosure>(find.byType(SsDisclosure))
        .initiallyExpanded, isTrue);
    expect(find.text('25,00 kg'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('empty optional product fields and title have no invented fallback', (
    tester,
  ) async {
    await _pump(tester, _product(name: '', brand: null, categories: const []));

    expect(tester.widget<SsPageHeader>(find.byType(SsPageHeader)).title, '');
    expect(find.byType(SsTag), findsNothing);
    final labels = tester.widgetList<SsAttribute>(
      find.byType(SsAttribute),
    ).map((attribute) {
      return attribute.label;
    });

    expect(labels, isNot(contains('Hersteller')));
    expect(labels, isNot(contains('Letzer EK-Preis')));
    expect(find.text('Unbekannt'), findsNothing);
    expect(find.descendant(
      of: find.byType(ProductDetailLayout),
      matching: find.byType(Title),
    ), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('price failure retains product content and exposes actual retry', (
    tester,
  ) async {
    var retried = false;
    await _pump(
      tester,
      _product(),
      priceError: StateError('PRICE_READ_FAILED'),
      onRetry: () {
        retried = true;
      },
    );

    expect(find.text('Harbor Cement'), findsOneWidget);
    expect(find.text('Preise konnten nicht geladen werden.'), findsOneWidget);
    await tester.tap(find.text('Erneut laden'));
    await tester.pumpAndSettle();

    expect(retried, isTrue);
    expect(tester.takeException(), isNull);
  });

  testWidgets('product units scroll at 320px with doubled actual-font text', (
    tester,
  ) async {
    await _pump(
      tester,
      _product(description: 'Baustoffe für den Industriebedarf und Hochbau'),
      width: 320,
      height: 380,
      scale: 2,
    );
    final scroll = tester.state<ScrollableState>(find.byType(Scrollable));

    expect(scroll.position.maxScrollExtent, greaterThan(0));
    expect(tester.takeException(), isNull);
    await tester.drag(find.byType(ListView), const Offset(0, -1000));
    await tester.pumpAndSettle();

    expect(scroll.position.pixels, greaterThan(0));
    expect(tester.takeException(), isNull);
  });
}

Future<void> _pump(
  WidgetTester tester,
  models.Product product, {
  List<models.ProductsPriceRecordsListResultItem> records = const [],
  Object? priceError,
  VoidCallback? onRetry,
  double width = 1200,
  double height = 900,
  double scale = 1,
}) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = Size(width, height);
  addTearDown(tester.view.resetDevicePixelRatio);
  addTearDown(tester.view.resetPhysicalSize);

  await tester.pumpWidget(
    MaterialApp(
      locale: const Locale('de'),
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
        body: ProductDetailLayout(
          product: product,
          priceRecords: records,
          priceError: priceError,
          onRetryPrices: onRetry,
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

models.Product _product({
  String name = 'Cement',
  String? brand = 'Harbor',
  String? description,
  String? regieReportName,
  Map<String, num> units = const {'bag': 25},
  List<String> categories = const ['Building materials'],
}) {
  return models.Product(
    id: 'product-1',
    customId: 12,
    name: name,
    brand: brand,
    description: description,
    regieReportName: regieReportName,
    baseUnit: 'kg',
    otherUnits: models.ApplyPriceImportRowOtherUnits(units),
    categories: categories,
  );
}

models.ProductsPriceRecordsListResultItem _price(
  String id,
  DateTime timestamp,
  num price,
) {
  return models.ProductsPriceRecordsListResultItem(
    id: id,
    productId: 'product-1',
    timestamp: timestamp,
    price: price,
    isRealPurchase: true,
  );
}
