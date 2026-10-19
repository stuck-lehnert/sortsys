import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/features/products/product_filter_dialog.dart';
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

  testWidgets(
    'product filters preserve original scalar previews and reselect',
    (tester) async {
      ProductListFilter? applied;

      await _pump(
        tester,
        initial: const ProductListFilter(
          brand: ' ACME ',
          category: 'Dry goods',
        ),
        onApplied: (filter) {
          applied = filter;
        },
      );

      expect(find.text(' ACME '), findsOneWidget);
      expect(find.byType(SsAutocompleteField<String>), findsNothing);
      await tester.tap(find.text('Filter anwenden'));
      await tester.pumpAndSettle();

      expect(applied?.brand, ' ACME ');
      expect(applied?.category, 'Dry goods');

      final remove = tester
          .widgetList<SsIconButton>(find.byType(SsIconButton))
          .first;
      remove.onPressed!();
      await tester.pumpAndSettle();

      final field = tester.widget<SsAutocompleteField<String>>(
        find.byType(SsAutocompleteField<String>),
      );
      field.onChanged!('New brand');
      await tester.pumpAndSettle();

      expect(find.text('New brand'), findsOneWidget);
      expect(find.byType(SsAutocompleteField<String>), findsNothing);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('unresolved product filter text cannot be submitted', (
    tester,
  ) async {
    var applied = false;

    await _pump(
      tester,
      onApplied: (filter) {
        applied = true;
      },
    );
    await tester.enterText(find.byType(TextField).first, 'Unselected brand');
    await tester.pump(const Duration(milliseconds: 300));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Filter anwenden'));
    await tester.pumpAndSettle();

    expect(applied, isFalse);
    expect(find.text('Eintrag aus der Liste auswählen.'), findsWidgets);
    expect(tester.takeException(), isNull);
  });

  testWidgets('changed product filter scope resets draft and validation', (
    tester,
  ) async {
    await _pump(
      tester,
      initial: const ProductListFilter(brand: 'Previous brand'),
    );

    final previous = tester.widget<Form>(find.byType(Form)).key;

    await _pump(
      tester,
      identity: 'next-scope',
      initial: const ProductListFilter(
        brand: 'Current brand',
        category: 'Current category',
      ),
    );

    expect(find.text('Previous brand'), findsNothing);
    expect(find.text('Current brand'), findsOneWidget);
    expect(find.text('Current category'), findsOneWidget);
    expect(tester.widget<Form>(find.byType(Form)).key, isNot(previous));
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'disabled product filter stays cancellable at 320px doubled text',
    (tester) async {
      var cancelled = false;

      await _pump(
        tester,
        enabled: false,
        width: 320,
        scale: 2,
        onCancel: () {
          cancelled = true;
        },
      );

      final apply = tester.widget<SsButton>(
        find.ancestor(
          of: find.text('Filter anwenden'),
          matching: find.byType(SsButton),
        ),
      );

      expect(apply.onPressed, isNull);
      expect(
        tester
            .widgetList<SsAutocompleteField<String>>(
              find.byType(SsAutocompleteField<String>),
            )
            .every((field) => !field.enabled),
        isTrue,
      );
      await tester.tap(find.text('Abbrechen'));
      await tester.pumpAndSettle();

      expect(cancelled, isTrue);
      expect(find.byType(SingleChildScrollView), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );
}

Future<void> _pump(
  WidgetTester tester, {
  ProductListFilter initial = const ProductListFilter(),
  Object identity = 'test-scope',
  bool enabled = true,
  double width = 1000,
  double scale = 1,
  ValueChanged<ProductListFilter>? onApplied,
  VoidCallback? onCancel,
}) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = Size(width, 700);
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
            data: MediaQuery.of(context)
                .copyWith(textScaler: TextScaler.linear(scale)),
            child: child!,
          ),
        );
      },
      home: Scaffold(
        body: ProductFilterDialog(
          initialFilter: initial,
          queryIdentity: identity,
          enabled: enabled,
          loadBrands: (query) async {
            return ['ACME', 'New brand'];
          },
          loadCategories: (query) async {
            return ['Dry goods'];
          },
          onApplied: onApplied ?? (filter) {},
          onCancel: onCancel ?? () {},
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}
