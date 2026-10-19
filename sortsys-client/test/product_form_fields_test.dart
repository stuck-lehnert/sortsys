import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/features/products/product_draft.dart';
import 'package:sortsys_client/features/products/product_form_fields.dart';
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
    'product fields keep number create-only and validate zero values',
    (tester) async {
      final values = ProductFormValues(
        ProductDraft(
          customId: '0',
          name: 'Cement',
          baseUnit: 'kg',
          units: const [ProductUnitDraft(name: 'bag', amount: '0')],
        ),
      );
      final form = GlobalKey<FormState>();
      _disposeAfterUnmount(tester, values);

      await _pump(tester, values, form);

      final fields = tester.widgetList<SsTextField>(find.byType(SsTextField));

      expect(find.text('Number'), findsOneWidget);
      expect(find.text('Name'), findsOneWidget);
      expect(
        fields.singleWhere((field) => field.label == 'Number').kind,
        SsTextFieldKind.integer,
      );
      expect(
        fields.singleWhere((field) => field.label == 'Base quantity').kind,
        SsTextFieldKind.decimal,
      );
      expect(form.currentState!.validate(), isTrue);
      expect(values.draft().createInput().toWire()['customId'], 0);

      final editing = ProductFormValues(
        ProductDraft(
          productId: 'product-1',
          customId: '12',
          name: 'Cement',
          baseUnit: 'kg',
        ),
      );
      _disposeAfterUnmount(tester, editing);

      await _pump(tester, editing, GlobalKey<FormState>());

      expect(find.text('Number'), findsNothing);
      expect(find.text('Name'), findsOneWidget);
      expect(
        editing.draft().updateInput().data.toWire().containsKey('customId'),
        isFalse,
      );
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('product fields show actual required and endpoint limit errors', (
    tester,
  ) async {
    final values = ProductFormValues(ProductDraft());
    final form = GlobalKey<FormState>();
    _disposeAfterUnmount(tester, values);

    await _pump(tester, values, form);

    expect(form.currentState!.validate(), isFalse);
    await tester.pumpAndSettle();

    expect(find.text('Required field'), findsNWidgets(3));
    values.customId.text = '1';
    values.name.text = 'Cement';
    values.baseUnit.text = 'abcdefghi';

    expect(form.currentState!.validate(), isFalse);
    await tester.pumpAndSettle();

    expect(find.text('Maximum 8 UTF-8 bytes.'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'product units add with focus and remove without stale controllers',
    (tester) async {
      final values = ProductFormValues(
        ProductDraft(customId: '1', name: 'Cement', baseUnit: 'kg'),
      );
      _disposeAfterUnmount(tester, values);

      await _pump(tester, values, GlobalKey<FormState>());
      await tester.ensureVisible(find.text('Add unit'));
      await tester.tap(find.text('Add unit'));
      await tester.pumpAndSettle();

      expect(values.units, hasLength(1));
      expect(values.units.single.nameFocus.hasFocus, isTrue);
      values.units.single.name.text = 'pallet';
      values.units.single.amount.text = '12,5';

      expect(values.draft().createInput().toWire()['otherUnits'], {
        'pallet': 12.5,
      });
      await tester.ensureVisible(find.text('Remove unit'));
      await tester.tap(find.text('Remove unit'));
      await tester.pumpAndSettle();

      expect(values.units, isEmpty);
      expect(values.draft().createInput().toWire()['otherUnits'], isEmpty);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'disabled product fields scroll at 320px with doubled actual font',
    (tester) async {
      final values = ProductFormValues(
        ProductDraft(
          productId: 'product-1',
          name: 'Cement',
          baseUnit: 'kg',
          units: const [ProductUnitDraft(name: 'pallet', amount: '12,5')],
        ),
      );
      _disposeAfterUnmount(tester, values);

      await _pump(
        tester,
        values,
        GlobalKey<FormState>(),
        width: 320,
        scale: 2,
        enabled: false,
      );

      expect(
        tester
            .widgetList<SsTextField>(find.byType(SsTextField))
            .every((field) => !field.enabled),
        isTrue,
      );
      expect(
        tester
            .widgetList<SsButton>(find.byType(SsButton))
            .every((button) => button.onPressed == null),
        isTrue,
      );
      expect(tester.takeException(), isNull);
      await tester.scrollUntilVisible(
        find.text('Add unit'),
        200,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.pumpAndSettle();

      expect(
        tester.getRect(find.text('Add unit')).bottom,
        lessThanOrEqualTo(800),
      );
      expect(tester.takeException(), isNull);
    },
  );
}

void _disposeAfterUnmount(WidgetTester tester, ProductFormValues values) {
  addTearDown(() async {
    await tester.pumpWidget(const SizedBox.shrink());

    values.dispose();
  });
}

Future<void> _pump(
  WidgetTester tester,
  ProductFormValues values,
  GlobalKey<FormState> form, {
  double width = 1000,
  double scale = 1,
  bool enabled = true,
}) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = Size(width, 800);
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
        body: SingleChildScrollView(
          padding: const EdgeInsets.all(16),
          child: Form(
            key: form,
            child: ProductFormFields(values: values, enabled: enabled),
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}
