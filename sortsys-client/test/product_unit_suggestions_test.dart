import 'dart:async';

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

  testWidgets('product units select actual suggestions and retain free input', (
    tester,
  ) async {
    final values = _values();
    final form = GlobalKey<FormState>();
    var loads = 0;
    _disposeAfterUnmount(tester, values);
    await _pump(
      tester,
      values,
      form,
      loadUnits: () async {
        loads++;

        return ['Pallet', 'pallet small', 'box'];
      },
    );
    final field = _unitInput();
    await tester.ensureVisible(field);
    await tester.enterText(field, '  PAL  ');
    await tester.pump(const Duration(milliseconds: 300));
    await tester.pumpAndSettle();

    expect(find.text('Pallet'), findsOneWidget);
    expect(find.text('pallet small'), findsOneWidget);
    expect(find.text('box'), findsNothing);
    expect(loads, 1);
    await tester.tap(find.text('Pallet'));
    await tester.pumpAndSettle();

    expect(values.units.single.name.text, 'Pallet');
    expect(values.draft().createInput().toWire()['otherUnits'], {
      'Pallet': 12.5,
    });
    await tester.enterText(field, 'custom unit');
    await tester.pump(const Duration(milliseconds: 300));
    await tester.pumpAndSettle();

    expect(form.currentState!.validate(), isTrue);
    expect(values.draft().createInput().toWire()['otherUnits'], {
      'custom unit': 12.5,
    });
    expect(loads, 1);
    await tester.ensureVisible(find.text('Add unit'));
    await tester.tap(find.text('Add unit'));
    await tester.pumpAndSettle();

    expect(values.units, hasLength(2));
    expect(values.units.last.nameFocus.hasFocus, isTrue);
    expect(find.byType(SsSuggestionField), findsNWidgets(2));
    expect(loads, 2);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'product unit keyboard navigation scrolls and selects a real option',
    (tester) async {
      final values = _values();
      final form = GlobalKey<FormState>();
      _disposeAfterUnmount(tester, values);
      await _pump(
        tester,
        values,
        form,
        loadUnits: () async {
          return List.generate(30, (index) => 'unit $index');
        },
      );
      await tester.ensureVisible(_unitInput());
      await tester.enterText(_unitInput(), 'unit');
      await tester.pump(const Duration(milliseconds: 300));
      await tester.pumpAndSettle();

      for (var index = 0; index < 12; index++) {
        await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
        await tester.pumpAndSettle();
      }

      final selected = tester
          .widgetList<SsButton>(find.byType(SsButton))
          .singleWhere((button) => button.selected);

      expect((selected.child as Text).data, 'unit 12');
      expect(find.text('unit 12').hitTestable(), findsOneWidget);
      await tester.testTextInput.receiveAction(TextInputAction.done);
      await tester.pumpAndSettle();

      expect(values.units.single.name.text, 'unit 12');
      expect(values.draft().createInput().toWire()['otherUnits'], {
        'unit 12': 12.5,
      });
      expect(form.currentState!.validate(), isTrue);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'product unit scopes reject stale suggestions and late disposal',
    (tester) async {
      final values = _values();
      final form = GlobalKey<FormState>();
      final old = Completer<List<String>>();
      final current = Completer<List<String>>();
      final removed = Completer<List<String>>();
      _disposeAfterUnmount(tester, values);
      await _pump(
        tester,
        values,
        form,
        identity: 'old',
        loadUnits: () => old.future,
      );
      await tester.ensureVisible(_unitInput());
      await tester.enterText(_unitInput(), 'p');
      await tester.pump(const Duration(milliseconds: 300));
      await _pump(
        tester,
        values,
        form,
        identity: 'current',
        loadUnits: () => current.future,
      );
      await tester.ensureVisible(_unitInput());
      await tester.enterText(_unitInput(), 'pa');
      await tester.pump(const Duration(milliseconds: 300));
      old.complete(['Private old unit']);
      await tester.pumpAndSettle();

      expect(find.text('Private old unit'), findsNothing);
      current.complete(['Pallet']);
      await tester.pumpAndSettle();

      expect(find.text('Pallet'), findsOneWidget);
      await tester.tap(find.text('Pallet'));
      await tester.pumpAndSettle();
      await _pump(
        tester,
        values,
        form,
        identity: 'removed',
        loadUnits: () => removed.future,
      );
      await tester.ensureVisible(_unitInput());
      await tester.enterText(_unitInput(), 'bo');
      await tester.pump(const Duration(milliseconds: 300));
      await tester.pumpWidget(const SizedBox.shrink());
      removed.complete(['box']);
      await tester.pumpAndSettle();
      values.units.single.name.addListener(_listener);
      values.units.single.name.removeListener(_listener);
      values.units.single.nameFocus.addListener(_listener);
      values.units.single.nameFocus.removeListener(_listener);

      expect(values.units.single.name.text, 'bo');
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'optional suggestions preserve free text on failure and disable',
    (tester) async {
      final values = _values();
      final form = GlobalKey<FormState>();
      _disposeAfterUnmount(tester, values);
      await _pump(
        tester,
        values,
        form,
        loadUnits: () async {
          throw StateError('unavailable');
        },
      );
      await tester.ensureVisible(_unitInput());
      await tester.enterText(_unitInput(), 'custom');
      await tester.pump(const Duration(milliseconds: 300));
      await tester.pumpAndSettle();

      expect(form.currentState!.validate(), isTrue);
      expect(values.draft().createInput().toWire()['otherUnits'], {
        'custom': 12.5,
      });
      var disabledLoads = 0;
      await _pump(
        tester,
        values,
        form,
        identity: 'disabled',
        enabled: false,
        width: 320,
        scale: 2,
        loadUnits: () async {
          disabledLoads++;

          return ['box'];
        },
      );

      expect(disabledLoads, 0);
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
      expect(values.units.single.name.text, 'custom');
      expect(tester.takeException(), isNull);
    },
  );
}

ProductFormValues _values() {
  return ProductFormValues(
    ProductDraft(
      customId: '1',
      name: 'Cement',
      baseUnit: 'kg',
      units: const [ProductUnitDraft(name: '', amount: '12,5')],
    ),
  );
}

Finder _unitInput() {
  return find
      .descendant(
        of: find.byType(SsSuggestionField),
        matching: find.byType(TextField),
      )
      .first;
}

void _listener() {}

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
  required Future<List<String>> Function() loadUnits,
  String identity = 'scope',
  bool enabled = true,
  double width = 800,
  double scale = 1,
}) async {
  tester.view.physicalSize = Size(width, 800);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  await tester.pumpWidget(
    MaterialApp(
      locale: const Locale('en'),
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
                child: ProductFormFields(
                  values: values,
                  queryIdentity: identity,
                  loadUnits: loadUnits,
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
