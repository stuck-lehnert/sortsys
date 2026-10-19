import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/features/products/product_list_screen.dart';
import 'package:sortsys_client/features/products/product_list_state.dart';
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

  testWidgets('product desktop columns retain names and genuine selection', (
    tester,
  ) async {
    final product = _product('A&/B', 12, ' Cement ', brand: ' ACME ');
    models.Product? selected;
    Uri? changed;

    await _pump(
      tester,
      [product],
      onSelected: (value) {
        selected = value;
      },
      onChanged: (value) {
        changed = value;
      },
    );

    final table = tester.widget<SsDataTable<models.Product>>(
      find.byType(SsDataTable<models.Product>),
    );

    expect(table.columns.map((column) => column.label), [
      'Number',
      'Name',
      'Manufacturer',
    ]);
    expect(find.text(' Cement '), findsOneWidget);
    expect(find.text(' ACME '), findsOneWidget);
    table.onSelected!(product);

    expect(selected, same(product));
    await tester.tap(find.text('Number'));
    await tester.pumpAndSettle();

    expect(changed?.queryParameters['sortProducts'], '[0,"ASC"]');
    expect(changed?.queryParametersAll['keep'], ['one', 'two']);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'product pagination clamps and size changes reset to first page',
    (tester) async {
      final rows = List.generate(60, (index) {
        return _product('$index', index, 'Product $index');
      });
      Uri? changed;

      await _pump(
        tester,
        rows,
        state: const ProductListState(page: 99),
        onChanged: (value) {
          changed = value;
        },
      );

      final pagination = tester.widget<SsPagination>(find.byType(SsPagination));
      final table = tester.widget<SsDataTable<models.Product>>(
        find.byType(SsDataTable<models.Product>),
      );

      expect(pagination.page, 3);
      expect(pagination.pageSizes, [25, 50, 100]);
      expect(table.rows, hasLength(10));
      expect(
        tester.getTopLeft(find.byType(SsPagination)).dy,
        lessThan(
          tester.getTopLeft(find.byType(SsDataTable<models.Product>)).dy,
        ),
      );
      pagination.onPageSize(50);

      expect(changed?.queryParameters.containsKey('pageProducts'), isFalse);
      expect(changed?.queryParameters['pageSizeProducts'], '50');
      expect(changed?.fragment, 'part');
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('compact product title preserves truthiness and encoded link', (
    tester,
  ) async {
    final product = _product(' A&/B ', 12.0, 'Cement', brand: ' ');
    models.Product? selected;

    await _pump(
      tester,
      [product],
      width: 800,
      onSelected: (value) {
        selected = value;
      },
    );

    final link = tester.widget<SsLink>(find.byType(SsLink));

    expect(find.text('12   Cement'), findsOneWidget);
    expect(link.uri.toString(), '/products/%20A%26%2FB%20');
    expect(find.byType(SsDataTable<models.Product>), findsNothing);
    link.onPressed!();

    expect(selected, same(product));
    expect(tester.takeException(), isNull);
  });

  testWidgets('product cards scroll at 320px with doubled actual-font text', (
    tester,
  ) async {
    final rows = List.generate(25, (index) {
      return _product(
        '$index',
        index,
        'A long original product designation for compact cards',
      );
    });

    await _pump(tester, rows, width: 320, scale: 2);

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
  List<models.Product> rows, {
  double width = 1200,
  double scale = 1,
  ProductListState state = const ProductListState(),
  ValueChanged<models.Product>? onSelected,
  ValueChanged<Uri>? onChanged,
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
        body: ProductListRows(
          rows: rows,
          state: state,
          uri: Uri.parse('/products?keep=one&keep=two#part'),
          onStateChanged: onChanged ?? (value) {},
          onSelected: onSelected ?? (value) {},
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

models.Product _product(String id, num number, String name, {String? brand}) {
  return models.Product(
    id: id,
    customId: number,
    name: name,
    brand: brand,
    baseUnit: 'kg',
    otherUnits: const models.ApplyPriceImportRowOtherUnits({}),
    categories: const [],
  );
}
