import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/features/delivery_notes/delivery_note_products.dart';
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

  testWidgets('delivery products render canonical quantities costs and links', (
    tester,
  ) async {
    final navigation = <Uri>[];
    final records = [_record('known', product: ' A&/B ', quantity: 10)];
    await _pump(
      tester,
      records,
      products: {' A&/B ': _product(' A&/B ')},
      costs: _costs(records),
      navigation: navigation,
    );
    final table = tester.widget<SsDataTable<DeliveryProductRecord>>(
      find.byType(SsDataTable<DeliveryProductRecord>),
    );

    expect(table.columns.map((column) => column.label), [
      'Name',
      'Quantity',
      'Base quantity',
      'average unit price',
      'Costs',
    ]);
    expect(find.byType(SsTableSortHeader), findsNWidgets(2));
    expect(find.text('ACME Cement'), findsOneWidget);
    expect(find.text('2.50 bag'), findsOneWidget);
    expect(find.text('10.00 kg'), findsOneWidget);
    expect(find.text('€3.00/kg'), findsOneWidget);
    expect(find.text('€30.00'), findsOneWidget);
    await tester.tap(find.text('ACME Cement'));

    expect(navigation.single.toString(), '/products/%20A%26%2FB%20');
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'delivery products retain null zero and reference-owner fallbacks',
    (tester) async {
      final records = [
        _record('zero', product: 'zero', quantity: 0),
        _record('missing', product: 'missing', quantity: 2),
        _record('foreign', product: 'foreign', quantity: 9, owner: 'other'),
      ];
      await _pump(
        tester,
        records,
        products: {'missing': _product('wrong')},
        costs: _costs(records.take(1).toList(), price: 0),
      );
      final table = tester.widget<SsDataTable<DeliveryProductRecord>>(
        find.byType(SsDataTable<DeliveryProductRecord>),
      );

      expect(table.rows.map((row) => row.id), ['zero', 'missing']);
      expect(find.byType(SsLink), findsNothing);
      expect(find.text('Unknown'), findsNWidgets(2));
      expect(find.text('€0.00'), findsOneWidget);
      expect(find.text('-'), findsNWidgets(2));
      expect(find.text('2.00 ???'), findsOneWidget);
      expect(find.text('2.00'), findsOneWidget);
      await _pump(tester, records, costs: _costs(records, owner: 'wrong'));

      expect(find.text('€0.00'), findsNothing);
      expect(find.text('€6.00'), findsNothing);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('delivery product sorting and pagination update canonical URL', (
    tester,
  ) async {
    final records = List.generate(60, (index) {
      return _record('$index', product: 'product', quantity: index);
    });
    final navigation = <Uri>[];
    await _pump(
      tester,
      records,
      costs: _costs(records),
      navigation: navigation,
    );

    SsDataTable<DeliveryProductRecord> table() {
      return tester.widget<SsDataTable<DeliveryProductRecord>>(
        find.byType(SsDataTable<DeliveryProductRecord>),
      );
    }

    SsPagination pagination() {
      return tester.widget<SsPagination>(find.byType(SsPagination));
    }

    expect(table().rows, orderedEquals(records.take(25)));
    await tester.tap(find.text('Costs'));
    await tester.pumpAndSettle();

    expect(navigation.last.queryParameters['sortProducts'], '[4,"ASC"]');
    await tester.tap(find.text('Costs'));
    await tester.pumpAndSettle();

    expect(table().rows.first.id, '59');
    expect(navigation.last.queryParametersAll['keep'], ['a', 'b']);
    expect(navigation.last.fragment, 'records');
    pagination().onPage(2);
    await tester.pumpAndSettle();

    expect(pagination().page, 2);
    pagination().onPageSize(50);
    await tester.pumpAndSettle();

    expect(pagination().page, 2);
    expect(
      table().rows.map((row) => row.id),
      records.take(10).toList().reversed.map((row) => row.id),
    );
    expect(navigation.last.queryParameters['pageProducts'], '1');
    expect(navigation.last.queryParameters['pageSizeProducts'], '50');
    expect(tester.takeException(), isNull);
  });

  testWidgets('German compact product cards scroll with doubled Ubuntu', (
    tester,
  ) async {
    final records = List.generate(10, (index) {
      return _record('$index', product: 'product', quantity: 10);
    });
    await _pump(
      tester,
      records,
      products: {'product': _product('product')},
      costs: _costs(records),
      width: 320,
      scale: 2,
      locale: 'de',
    );
    final labels = tester.widgetList<SsAttribute>(find.byType(SsAttribute)).map(
      (field) {
        return field.label;
      },
    );

    expect(labels.take(5), [
      'Bezeichnung',
      'Menge',
      'Basismenge',
      'mittlerer EP',
      'Kosten',
    ]);
    expect(find.text('2,50 bag'), findsWidgets);
    final scroll = tester.state<ScrollableState>(
      find.descendant(
        of: find.byType(ListView),
        matching: find.byType(Scrollable),
      ),
    );

    expect(scroll.position.maxScrollExtent, greaterThan(0));
    await tester.drag(find.byType(ListView), const Offset(0, -500));
    await tester.pumpAndSettle();

    expect(scroll.position.pixels, greaterThan(0));
    expect(tester.takeException(), isNull);
  });
}

DeliveryProductRecord _record(
  String id, {
  required String product,
  required num quantity,
  String owner = 'note',
}) {
  return DeliveryProductRecord(
    id: id,
    noteId: owner,
    productId: product,
    quantity: quantity,
    unit: 'bag',
  );
}

models.Product _product(String id) {
  return models.Product(
    id: id,
    customId: 0,
    name: 'Cement',
    brand: 'ACME',
    baseUnit: 'kg',
    otherUnits: models.ApplyPriceImportRowOtherUnits(const {'bag': 4}),
    categories: const [],
  );
}

models.DeliveryNotesCostsGetOutput _costs(
  List<DeliveryProductRecord> records, {
  String owner = 'note',
  num price = 3,
}) {
  return models.DeliveryNotesCostsGetOutput(
    noteId: owner,
    totalCost: 0,
    specialRecords: const [],
    records: [
      for (final record in records)
        models.DeliveryNotesCostsGetResultRecordsItem(
          recordId: record.id,
          productId: record.productId,
          quantity: record.quantity,
          priceRecord: models.ProductsPriceRecordsListResultItem(
            id: 'price-${record.id}',
            productId: record.productId,
            timestamp: DateTime.utc(2024),
            price: price,
            isRealPurchase: true,
          ),
        ),
    ],
  );
}

Future<void> _pump(
  WidgetTester tester,
  List<DeliveryProductRecord> records, {
  Map<String, models.Product> products = const {},
  models.DeliveryNotesCostsGetOutput? costs,
  List<Uri>? navigation,
  double width = 1200,
  double scale = 1,
  String locale = 'en',
}) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = Size(width, 900);
  addTearDown(tester.view.resetDevicePixelRatio);
  addTearDown(tester.view.resetPhysicalSize);
  var uri = Uri.parse('/products/deliveryNotes/n?keep=a&keep=b#records');

  await tester.pumpWidget(
    MaterialApp(
      locale: Locale(locale),
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
        body: StatefulBuilder(
          builder: (context, setState) {
            return DeliveryNoteProducts(
              noteId: 'note',
              records: records,
              products: products,
              uri: uri,
              costs: costs,
              onNavigate: (target) {
                navigation?.add(target);

                if (target.path == uri.path) {
                  setState(() {
                    uri = target;
                  });
                }
              },
            );
          },
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}
