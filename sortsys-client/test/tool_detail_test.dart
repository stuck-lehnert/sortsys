import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/features/tools/tool_detail_layout.dart';
import 'package:sortsys_client/features/tools/tool_list_filter.dart';
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

  test('tool titles preserve canonical truthiness and whitespace', () {
    expect(toolTitle(_tool()), 'Makita Bohrer HP 42');
    expect(toolTitle(_tool(label: null)), 'Makita Bohrer');
    expect(toolTitle(_tool(label: '')), 'Makita Bohrer');
    expect(toolTitle(_tool(label: ' ')), 'Makita Bohrer  ');
    expect(
      toolTitle(_tool(brand: ' A ', category: ' B ', label: ' X ')),
      ' A   B   X ',
    );
    expect(toolNumber(41.0), '41');
    expect(toolNumber(41.5), '41.5');
  });

  test('tool status preserves canonical priority and tag types', () {
    for (final available in [true, false]) {
      expect(
        toolStatusPresentation(
          _tool(status: models.ToolStatus.lost, available: available),
        ),
        ('abhanden', 'missing', SsTagTone.red),
      );
      expect(
        toolStatusPresentation(
          _tool(status: models.ToolStatus.broken, available: available),
        ),
        ('defekt', 'broken', SsTagTone.magenta),
      );
    }

    expect(
      toolStatusPresentation(_tool()),
      ('verfügbar', 'available', SsTagTone.green),
    );
    expect(
      toolStatusPresentation(_tool(available: false)),
      ('gebucht', 'booked', SsTagTone.cyan),
    );
  });

  testWidgets('tool attributes include canonical prices and actual link URIs', (
    tester,
  ) async {
    await _pump(
      tester,
      _tool(status: models.ToolStatus.broken, available: false),
    );

    expect(_labels(tester), [
      'Number',
      'Brand',
      'Category',
      'Booked',
      'Model',
      'Status',
      'Purchase price',
      'Usage cost per day',
    ]);
    expect(find.text('41 Makita Bohrer HP 42'), findsOneWidget);
    expect(find.text('Yes'), findsOneWidget);
    expect(find.text('€1,234.50'), findsOneWidget);
    expect(find.text('€0.00'), findsOneWidget);
    expect(tester.widget<SsTag>(find.byType(SsTag)).tone, SsTagTone.magenta);

    final titles = find.descendant(
      of: find.byType(ToolDetailLayout),
      matching: find.byType(Title),
    );
    expect(tester.widget<Title>(titles).title, '41 Makita Bohrer HP 42');

    final links = tester.widgetList<SsLink>(find.byType(SsLink)).toList();
    expect(links[0].uri, Uri.parse('/tools?brand=Makita'));
    expect(links[1].uri, Uri.parse('/tools?category=Bohrer'));
    expect(find.text('Created'), findsNothing);
    expect(find.text('Modified'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('absent optional tool values leave only required attributes', (
    tester,
  ) async {
    await _pump(
      tester,
      _tool(label: '', purchasePrice: null, usageCostPerDay: null),
    );

    expect(_labels(tester), ['Number', 'Brand', 'Category', 'Booked']);
    expect(find.text('No'), findsOneWidget);
    expect(find.text('available'), findsOneWidget);
    expect(find.byType(SsAttributeList), findsOneWidget);
    expect(find.text('Unknown'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('German tool labels and EUR formatting follow the Webapp locale', (
    tester,
  ) async {
    await _pump(tester, _tool(available: false), locale: const Locale('de'));

    expect(_labels(tester), [
      'Nummer',
      'Marke',
      'Kategorie',
      'Gebucht',
      'Modell',
      'Kaufpreis',
      'Nutzungskosten pro Tag',
    ]);
    expect(find.text('Ja'), findsOneWidget);
    expect(find.text('gebucht'), findsOneWidget);
    expect(find.text('1.234,50\u00a0€'), findsOneWidget);
    expect(find.text('0,00\u00a0€'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('brand and category links navigate to genuine filter inputs', (
    tester,
  ) async {
    Map<String, Object?>? visitedInput;
    final tool = _tool(brand: ' A&B+ ', category: 'Sägen/Bohrer');
    final router = GoRouter(
      initialLocation: '/tools/tool-1',
      routes: [
        GoRoute(
          path: '/tools/:id',
          builder: (context, state) {
            return Scaffold(
              body: ToolDetailLayout(tool: tool, child: const SizedBox()),
            );
          },
        ),
        GoRoute(
          path: '/tools',
          builder: (context, state) {
            visitedInput = ToolListFilter.fromUri(state.uri).input('').toWire();

            return const Scaffold(body: Text('Filtered tools'));
          },
        ),
      ],
    );
    addTearDown(router.dispose);
    await tester.pumpWidget(
      MaterialApp.router(
        routerConfig: router,
        locale: const Locale('en'),
        supportedLocales: const [Locale('de'), Locale('en')],
        localizationsDelegates: GlobalMaterialLocalizations.delegates,
        builder: (context, child) {
          return SsTheme(colors: SsColors.light, child: child!);
        },
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text(' A&B+ '));
    await tester.pumpAndSettle();

    expect(visitedInput, {
      'status': null,
      'brand': ' A&B+ ',
      'category': null,
    });
    router.go('/tools/tool-1');
    await tester.pumpAndSettle();
    await tester.tap(find.text('Sägen/Bohrer'));
    await tester.pumpAndSettle();

    expect(visitedInput, {
      'status': null,
      'brand': null,
      'category': 'Sägen/Bohrer',
    });
    expect(tester.takeException(), isNull);
  });

  testWidgets('tool detail outer layout scrolls at 320px with doubled text', (
    tester,
  ) async {
    await _pump(
      tester,
      _tool(status: models.ToolStatus.lost),
      width: 320,
      scale: 2,
      colors: SsColors.dark,
    );

    expect(find.text('missing'), findsNWidgets(2));
    expect(tester.takeException(), isNull);
    await tester.scrollUntilVisible(
      find.text('Tool content'),
      300,
      scrollable: find.byType(Scrollable).first,
    );
    await tester.pumpAndSettle();

    expect(find.text('Tool content').hitTestable(), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}

List<String> _labels(WidgetTester tester) {
  return tester.widgetList<SsAttribute>(find.byType(SsAttribute)).map((field) {
    return field.label;
  }).toList();
}

Future<void> _pump(
  WidgetTester tester,
  models.Tool tool, {
  Locale locale = const Locale('en'),
  double width = 1200,
  double scale = 1,
  SsColors colors = SsColors.light,
}) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = Size(width, 900);
  addTearDown(tester.view.resetDevicePixelRatio);
  addTearDown(tester.view.resetPhysicalSize);

  await tester.pumpWidget(
    MaterialApp(
      locale: locale,
      supportedLocales: const [Locale('de'), Locale('en')],
      localizationsDelegates: GlobalMaterialLocalizations.delegates,
      home: Scaffold(
        body: SsTheme(
          colors: colors,
          child: MediaQuery(
            data: MediaQueryData(textScaler: TextScaler.linear(scale)),
            child: ToolDetailLayout(
              tool: tool,
              child: const SizedBox(
                height: 300,
                child: Align(
                  alignment: Alignment.bottomLeft,
                  child: Text('Tool content'),
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

models.Tool _tool({
  String brand = 'Makita',
  String category = 'Bohrer',
  String? label = 'HP 42',
  num? purchasePrice = 1234.5,
  num? usageCostPerDay = 0,
  models.ToolStatus? status,
  bool available = true,
}) {
  return models.Tool(
    id: 'tool-1',
    customId: 41.0,
    brand: brand,
    category: category,
    label: label,
    purchasePrice: purchasePrice,
    usageCostPerDay: usageCostPerDay,
    status: status,
    available: available,
    createdAt: DateTime.utc(2026, 1, 1),
    modifiedAt: DateTime.utc(2026, 1, 1),
  );
}
