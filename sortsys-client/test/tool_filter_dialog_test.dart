import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/features/tools/tool_filter_dialog.dart';
import 'package:sortsys_client/features/tools/tool_list_filter.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

void main() {
  test('filter URLs preserve unrelated repeated values, paging and fragment', () {
    final uri = Uri.parse(
      '/tools?brand=A&brand=B&status=lost&archived=yes&x=1&x=2'
      '&pageTools=3#context',
    );
    final changed = applyToolFilters(
      uri,
      const ToolListFilter(brand: ' A&/B ', category: 'Bohrer'),
    );

    expect(changed.queryParametersAll['brand'], [' A&/B ']);
    expect(changed.queryParameters['category'], 'Bohrer');
    expect(changed.queryParameters.containsKey('status'), isFalse);
    expect(changed.queryParameters['archived'], 'yes');
    expect(changed.queryParametersAll['x'], ['1', '2']);
    expect(changed.queryParameters['pageTools'], '3');
    expect(changed.fragment, 'context');

    final cleared = applyToolFilters(changed, const ToolListFilter());
    final active = toolArchiveUri(cleared, archivedOnly: false);
    final archived = toolArchiveUri(active, archivedOnly: true);

    expect(cleared.queryParameters.containsKey('brand'), isFalse);
    expect(cleared.queryParameters.containsKey('category'), isFalse);
    expect(active.queryParameters.containsKey('archived'), isFalse);
    expect(archived.queryParameters['archived'], 'yes');
    expect(archived.queryParametersAll['x'], ['1', '2']);
    expect(archived.fragment, 'context');
  });

  testWidgets('filter dialog preserves status and one unchanged selection', (
    tester,
  ) async {
    ToolListFilter? applied;
    await _pump(
      tester,
      initial: const ToolListFilter(
        status: models.ToolsListRequestStatus.lost,
        brand: ' Makita ',
        category: 'Bohrer',
        archivedOnly: true,
      ),
      onApplied: (value) {
        applied = value;
      },
    );
    final status = tester.widget<SsSelectField<String>>(
      find.byType(SsSelectField<String>),
    );

    expect(status.value, 'lost');
    expect(status.options.map((option) => option.value), [
      'none', 'available', 'unavailable', 'lost', 'broken',
    ]);
    expect(find.text(' Makita '), findsOneWidget);
    expect(find.byType(SsAutocompleteField<String>), findsNothing);
    await tester.tap(find.text('Filter anwenden'));
    await tester.pumpAndSettle();

    expect(applied!.brand, ' Makita ');
    expect(applied!.category, 'Bohrer');
    expect(applied!.status, models.ToolsListRequestStatus.lost);
    expect(applied!.archivedOnly, isTrue);

    final remove = tester.widgetList<SsIconButton>(
      find.byType(SsIconButton),
    ).first;
    remove.onPressed!();
    await tester.pumpAndSettle();

    final brand = tester.widget<SsAutocompleteField<String>>(
      find.byType(SsAutocompleteField<String>),
    );
    brand.onChanged!('Bosch');
    await tester.pumpAndSettle();
    expect(find.text('Bosch'), findsOneWidget);
    expect(find.byType(SsAutocompleteField<String>), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('unresolved filter text cannot become a selected brand', (
    tester,
  ) async {
    var applied = false;
    await _pump(tester, onApplied: (_) {
      applied = true;
    });
    await tester.enterText(find.byType(TextField).first, 'Unselected brand');
    await tester.pump(const Duration(milliseconds: 300));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Filter anwenden'));
    await tester.pumpAndSettle();

    expect(applied, isFalse);
    expect(find.text('Eintrag aus der Liste auswählen.'), findsWidgets);
    expect(tester.takeException(), isNull);
  });

  testWidgets('changed filter scope replaces draft and validation state', (
    tester,
  ) async {
    await _pump(
      tester,
      initial: const ToolListFilter(
        status: models.ToolsListRequestStatus.lost,
        brand: 'Previous brand',
      ),
    );
    final previousForm = tester.widget<Form>(find.byType(Form)).key;

    await _pump(
      tester,
      queryIdentity: 'next-session',
      initial: const ToolListFilter(
        status: models.ToolsListRequestStatus.available,
        brand: 'Current brand',
        category: 'Current category',
      ),
    );
    final status = tester.widget<SsSelectField<String>>(
      find.byType(SsSelectField<String>),
    );

    expect(status.value, 'available');
    expect(find.text('Previous brand'), findsNothing);
    expect(find.text('Current brand'), findsOneWidget);
    expect(find.text('Current category'), findsOneWidget);
    expect(tester.widget<Form>(find.byType(Form)).key, isNot(previousForm));
    expect(tester.takeException(), isNull);
  });

  testWidgets('disabled narrow filter dialog keeps cancel and scroll usable', (
    tester,
  ) async {
    var cancelled = false;
    await _pump(
      tester,
      enabled: false,
      width: 320,
      height: 600,
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
    expect(tester.widgetList<SsAutocompleteField<String>>(
      find.byType(SsAutocompleteField<String>),
    ).every((field) {
      return !field.enabled;
    }), isTrue);
    await tester.tap(find.text('Abbrechen'));
    await tester.pumpAndSettle();

    expect(cancelled, isTrue);
    expect(find.byType(SingleChildScrollView), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}

Future<void> _pump(
  WidgetTester tester, {
  ToolListFilter initial = const ToolListFilter(),
  Object queryIdentity = 'test-session',
  bool enabled = true,
  double width = 1000,
  double height = 900,
  double scale = 1,
  ValueChanged<ToolListFilter>? onApplied,
  VoidCallback? onCancel,
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
        body: ToolFilterDialog(
          initialFilter: initial,
          queryIdentity: queryIdentity,
          enabled: enabled,
          loadBrands: (query) async {
            return ['Makita', 'Bosch'];
          },
          loadCategories: (query) async {
            return ['Bohrer'];
          },
          onApplied: onApplied ?? (_) {},
          onCancel: onCancel ?? () {},
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}
