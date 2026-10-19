import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/features/products/product_price_form_fields.dart';
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

  testWidgets(
    'price fields use actual unit vendor date and purchase interactions',
    (tester) async {
      final units = <String, num>{'bag': 4};
      final values = ProductPriceFormValues(
        _product(units),
        date: DateTime(2024, 2, 3, 17),
      );
      final form = GlobalKey<FormState>();
      final queries = <String>[];
      _disposeAfterUnmount(tester, values);
      units['bag'] = 8;

      await _pump(
        tester,
        values,
        form,
        loadVendors: (query) async {
          queries.add(query);

          return [
            models.ProductVendor(
              id: 'vendor',
              name: 'Vendor Alpha',
              createdAt: DateTime.utc(2024),
              modifiedAt: DateTime.utc(2024),
            ),
          ];
        },
      );
      await tester.enterText(_input('Total price (EUR)'), '30');
      await tester.enterText(_input('Quantity'), '1,5');
      await tester.tap(find.text('kg').last);
      await tester.pumpAndSettle();
      await tester.tap(find.text('bag').last);
      await tester.pumpAndSettle();
      await tester.enterText(_input('Comment'), '  invoice  ');
      final date = find.descendant(
        of: find.byType(SsDateField),
        matching: find.byType(TextField),
      );
      await tester.ensureVisible(date);
      await tester.enterText(date, '01.04.2024');
      await tester.testTextInput.receiveAction(TextInputAction.done);
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('Actual purchase?'));
      await tester.tap(find.text('Actual purchase?'));
      await tester.pumpAndSettle();
      await tester.ensureVisible(_input('Vendors'));
      await tester.enterText(_input('Vendors'), '  VEN  ');
      await tester.pump(const Duration(milliseconds: 300));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Vendor Alpha').last);
      await tester.pumpAndSettle();

      expect(queries, ['ven']);
      expect(values.vendor?.id, 'vendor');
      expect(
        find.byType(SsAutocompleteField<models.ProductVendor>),
        findsNothing,
      );
      expect(form.currentState!.validate(), isTrue);
      expect(values.draft().createInput().toWire(), {
        'productId': 'product',
        'pricePerBaseUnit': 5,
        'timestamp': DateTime(2024, 4, 1),
        'isRealPurchase': true,
        'comment': 'invoice',
      });
      await tester.tap(
        find.byKey(const ValueKey('product-price-vendor-clear')),
      );
      await tester.pumpAndSettle();

      expect(values.vendor, isNull);
      expect(
        find.byType(SsAutocompleteField<models.ProductVendor>),
        findsOneWidget,
      );
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'price fields enforce actual required arithmetic and byte limits',
    (tester) async {
      final values = ProductPriceFormValues(_product({}));
      final form = GlobalKey<FormState>();
      _disposeAfterUnmount(tester, values);

      await _pump(tester, values, form);

      expect(form.currentState!.validate(), isFalse);
      await tester.pumpAndSettle();

      expect(find.text('Required field'), findsNWidgets(2));
      await tester.enterText(_input('Total price (EUR)'), '2');
      await tester.enterText(_input('Quantity'), '0');

      expect(form.currentState!.validate(), isFalse);
      await tester.pumpAndSettle();

      expect(find.text('Enter a number'), findsOneWidget);
      await tester.enterText(_input('Quantity'), '2');
      await tester.enterText(_input('Comment'), List.filled(128, 'é').join());

      expect(form.currentState!.validate(), isFalse);
      await tester.pumpAndSettle();

      expect(find.text('Maximum 255 UTF-8 bytes.'), findsOneWidget);
      await tester.enterText(_input('Comment'), 'valid');
      final date = find.descendant(
        of: find.byType(SsDateField),
        matching: find.byType(TextField),
      );
      await tester.ensureVisible(date);
      await tester.enterText(date, '');
      await tester.pumpAndSettle();

      expect(values.date, isNull);
      expect(form.currentState!.validate(), isFalse);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'disabled German price fields scroll at320px with doubled Ubuntu',
    (tester) async {
      final values = ProductPriceFormValues(_product({'bag': 4}));
      final form = GlobalKey<FormState>();
      var queries = 0;
      _disposeAfterUnmount(tester, values);
      values.vendor = models.ProductVendor(
        id: 'vendor',
        name: 'Händler',
        createdAt: DateTime.utc(2024),
        modifiedAt: DateTime.utc(2024),
      );

      await _pump(
        tester,
        values,
        form,
        enabled: false,
        width: 320,
        scale: 2,
        language: 'de',
        loadVendors: (query) async {
          queries++;

          return [];
        },
      );

      expect(queries, 0);
      expect(
        tester
            .widgetList<SsTextField>(find.byType(SsTextField))
            .every((field) => !field.enabled),
        isTrue,
      );
      expect(
        tester.widget<SsCheckbox>(find.byType(SsCheckbox)).onChanged,
        isNull,
      );
      expect(
        tester
            .widget<SsButton>(
              find.byKey(const ValueKey('product-price-vendor-clear')),
            )
            .onPressed,
        isNull,
      );
      await tester.scrollUntilVisible(
        find.text('Echter Einkauf?'),
        160,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.pumpAndSettle();

      expect(
        tester.getRect(find.text('Echter Einkauf?')).bottom,
        lessThanOrEqualTo(800),
      );
      await tester.pumpWidget(const SizedBox.shrink());
      values.price.addListener(_listener);
      values.price.removeListener(_listener);

      expect(tester.takeException(), isNull);
    },
  );
}

models.Product _product(Map<String, num> units) {
  return models.Product(
    id: 'product',
    customId: 1,
    name: 'Cement',
    baseUnit: 'kg',
    otherUnits: models.ApplyPriceImportRowOtherUnits(units),
    categories: const [],
  );
}

Finder _input(String label) {
  return find.descendant(
    of: find.byWidgetPredicate((widget) {
      return widget is SsTextField && widget.label == label;
    }),
    matching: find.byType(TextField),
  );
}

void _listener() {}

void _disposeAfterUnmount(WidgetTester tester, ProductPriceFormValues values) {
  addTearDown(() async {
    await tester.pumpWidget(const SizedBox.shrink());
    values.dispose();
  });
}

Future<void> _pump(
  WidgetTester tester,
  ProductPriceFormValues values,
  GlobalKey<FormState> form, {
  Future<List<models.ProductVendor>> Function(String)? loadVendors,
  bool enabled = true,
  double width = 800,
  double scale = 1,
  String language = 'en',
}) async {
  tester.view.physicalSize = Size(width, 800);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);

  await tester.pumpWidget(
    MaterialApp(
      locale: Locale(language),
      supportedLocales: const [Locale('en'), Locale('de')],
      localizationsDelegates: GlobalMaterialLocalizations.delegates,
      home: SsTheme(
        colors: SsColors.light,
        child: MediaQuery(
          data: MediaQueryData(
            size: Size(width, 800),
            textScaler: TextScaler.linear(scale),
          ),
          child: Scaffold(
            body: SingleChildScrollView(
              child: Form(
                key: form,
                child: ProductPriceFormFields(
                  values: values,
                  queryIdentity: 'scope',
                  loadVendors: loadVendors ?? (query) async => [],
                  enabled: enabled,
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}
