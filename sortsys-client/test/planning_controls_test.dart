import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/features/planning/planning_controls.dart';
import 'package:sortsys_client/features/planning/planning_state.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

final _today = DateTime(2026, 10, 16);
final _initial = Uri.parse('/deployments?day=2026-10-12&tag=one&tag=two#plan');

void main() {
  testWidgets('planning controls merge exact canonical URL values', (
    tester,
  ) async {
    final key = GlobalKey<_ControlsHarnessState>();
    await _mount(tester, key);

    await tester.tap(find.text('Assigned only'));
    await tester.pump();
    await tester.tap(find.text('Mon–Fri'));
    await tester.pump();
    await tester.tap(find.text('Day'));
    await tester.pump();

    final uri = key.currentState!.location;

    expect(uri.queryParameters['all'], 'yes');
    expect(uri.queryParameters['weekend'], 'yes');
    expect(uri.queryParameters['view'], 'day');
    expect(uri.queryParameters['day'], '2026-10-12');
    expect(uri.queryParametersAll['tag'], ['one', 'two']);
    expect(uri.fragment, 'plan');
    expect(find.text('With weekend'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'employee mode and exact search text retain working clear action',
    (tester) async {
      final key = GlobalKey<_ControlsHarnessState>();
      await _mount(tester, key);

      await tester.tap(find.text('Employees'));
      await tester.pump();
      await tester.enterText(find.byType(SsTextField), ' Ada  Project ');
      await tester.pump();

      expect(key.currentState!.rowMode, PlanningRowMode.user);
      expect(key.currentState!.location.queryParameters['q'], ' Ada  Project ');
      expect(find.text('Search employee or project'), findsOneWidget);
      await tester.tap(find.byTooltip('Clear search'));
      await tester.pump();

      expect(
        key.currentState!.location.queryParameters.containsKey('q'),
        isFalse,
      );
      final searchInput = find.descendant(
        of: find.byType(SsTextField),
        matching: find.byType(EditableText),
      );
      final editable = tester.widget<EditableText>(searchInput);

      expect(editable.controller.text, isEmpty);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'date navigation and clearing preserve a real accessible date field',
    (tester) async {
      final key = GlobalKey<_ControlsHarnessState>();
      final semantics = tester.ensureSemantics();

      try {
        await _mount(tester, key);

        expect(find.text('Week 42 2026'), findsOneWidget);
        expect(find.text('Select date'), findsNothing);
        expect(find.bySemanticsLabel('Select date'), findsOneWidget);
        await tester.tap(find.byTooltip('Next week'));
        await tester.pump();

        expect(key.currentState!.location.queryParameters['day'], '2026-10-19');
        await tester.tap(find.byTooltip('Clear date'));
        await tester.pump();

        expect(
          key.currentState!.location.queryParameters.containsKey('day'),
          isFalse,
        );
        expect(find.text('16.10.2026'), findsOneWidget);
        await tester.tap(find.text('Today'));
        await tester.pump();

        expect(key.currentState!.location.queryParameters['day'], '2026-10-16');
        expect(tester.takeException(), isNull);
      } finally {
        semantics.dispose();
      }
    },
  );

  testWidgets(
    'absence action works for members and managers without assignment creation',
    (tester) async {
      final key = GlobalKey<_ControlsHarnessState>();
      await _mount(tester, key, scale: 2);

      key.currentState!.configureAbsenceAction(enabled: true, manager: false);
      await tester.pump();

      expect(find.text('Add assignment'), findsNothing);
      expect(find.text('Add absence'), findsNothing);

      await tester.ensureVisible(find.text('Request absence'));
      await tester.tap(find.text('Request absence'));
      await tester.pump();

      expect(key.currentState!.absenceActionCalls, 1);
      expect(key.currentState!.location, _initial);

      key.currentState!.configureAbsenceAction(enabled: false, manager: true);
      await tester.pump();

      expect(find.text('Request absence'), findsNothing);
      expect(find.text('Add absence'), findsNothing);

      key.currentState!.configureAbsenceAction(enabled: true, manager: true);
      await tester.pump();
      await tester.ensureVisible(find.text('Add absence'));
      await tester.tap(find.text('Add absence'));
      await tester.pump();

      expect(key.currentState!.absenceActionCalls, 2);
      expect(key.currentState!.location, _initial);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'planning controls fit320px at text scale2 with functional segments',
    (tester) async {
      final key = GlobalKey<_ControlsHarnessState>();
      await _mount(tester, key, scale: 2);
      final employees = find.text('Employees');

      await tester.ensureVisible(employees);
      await tester.tap(employees);
      await tester.pump();

      expect(key.currentState!.rowMode, PlanningRowMode.user);
      expect(find.text('Add assignment'), findsNothing);
      expect(find.text('Request absence'), findsNothing);
      expect(tester.takeException(), isNull);
    },
  );
}

Future<void> _mount(
  WidgetTester tester,
  GlobalKey<_ControlsHarnessState> key, {
  double scale = 1,
}) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = const Size(320, 900);
  addTearDown(tester.view.resetDevicePixelRatio);
  addTearDown(tester.view.resetPhysicalSize);
  final fonts = FontLoader('packages/sortsys_ui/Ubuntu');

  for (final weight in ['Regular', 'Medium', 'Bold']) {
    fonts.addFont(
      rootBundle.load(
        'packages/sortsys_ui/assets/fonts/ubuntu/Ubuntu-$weight.ttf',
      ),
    );
  }

  await fonts.load();
  await tester.pumpWidget(
    MaterialApp(
      locale: const Locale('en'),
      supportedLocales: const [Locale('de'), Locale('en')],
      localizationsDelegates: GlobalMaterialLocalizations.delegates,
      home: SsTheme(
        colors: SsColors.light,
        child: Builder(
          builder: (context) {
            final media = MediaQuery.of(context);

            return MediaQuery(
              data: media.copyWith(textScaler: TextScaler.linear(scale)),
              child: Scaffold(
                body: SingleChildScrollView(child: _ControlsHarness(key: key)),
              ),
            );
          },
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

class _ControlsHarness extends StatefulWidget {
  const _ControlsHarness({super.key});

  @override
  State<_ControlsHarness> createState() {
    return _ControlsHarnessState();
  }
}

class _ControlsHarnessState extends State<_ControlsHarness> {
  Uri location = _initial;
  PlanningRowMode rowMode = PlanningRowMode.project;
  bool absenceActionEnabled = false;
  bool managesAbsences = false;
  int absenceActionCalls = 0;

  void configureAbsenceAction({required bool enabled, required bool manager}) {
    setState(() {
      absenceActionEnabled = enabled;
      managesAbsences = manager;
    });
  }

  @override
  Widget build(BuildContext context) {
    final state = PlanningState(location, today: _today);

    return PlanningControls(
      state: state,
      today: _today,
      rowMode: rowMode,
      canManageAbsences: managesAbsences,
      onAbsence: absenceActionEnabled
          ? () {
              absenceActionCalls++;
            }
          : null,
      onLocation: (change) {
        setState(() {
          location = change(PlanningState(location, today: _today));
        });
      },
      onRowMode: (value) {
        setState(() {
          rowMode = value;
        });
      },
    );
  }
}
