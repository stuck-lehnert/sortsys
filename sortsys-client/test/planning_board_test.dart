import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/features/planning/planning_board.dart';
import 'package:sortsys_client/features/planning/planning_data.dart';
import 'package:sortsys_client/features/planning/planning_state.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

final _monday = DateTime(2026, 10, 12);

void main() {
  testWidgets('week board shows weekdays and authorized assignment warnings', (
    tester,
  ) async {
    _viewport(tester);
    final absence = models.UsersVacationsListResultItem(
      id: 'absence',
      userId: 'self',
      from: _monday,
      to: _monday,
      type: models.UsersVacationsListResultItemType.vacation,
      status: models.UsersVacationsListResultItemStatus.approved,
      canApprove: false,
      canDeny: false,
      canDelete: false,
      vacationUsage: const [],
      createdAt: _monday,
      modifiedAt: _monday,
    );
    final block = models.ProjectsUnavailabilityListResultItem(
      id: 'block',
      projectId: 'project-0',
      from: _monday,
      to: _monday,
      reason: 'Maintenance',
      createdAt: _monday,
      modifiedAt: _monday,
    );
    final view = _view(absences: [absence], blocks: [block]);

    await tester.pumpWidget(_host(PlanningBoard(view: view, today: _monday)));
    await tester.pumpAndSettle();

    expect(find.text('Mon'), findsOneWidget);
    expect(find.text('Fri'), findsOneWidget);
    expect(find.text('Sat'), findsNothing);
    expect(find.text('Sun'), findsNothing);
    expect(find.text('ABSENCES'), findsOneWidget);
    expect(find.text('Leave'), findsOneWidget);
    expect(find.text('Unavailable: Maintenance'), findsOneWidget);
    expect(find.text('07:00-16:00  !'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'real card and cell interactions pass exact records and date presets',
    (tester) async {
      _viewport(tester);
      final semantics = tester.ensureSemantics();

      try {
        String? edited;
        PlanningPreset? created;

        await tester.pumpWidget(
          _host(
            PlanningBoard(
              view: _view(),
              today: _monday,
              onEdit: (value) {
                edited = value.record.id;
              },
              onCreate: (value) {
                created = value;
              },
            ),
          ),
        );
        await tester.pumpAndSettle();
        await tester.tap(find.text('Alice'));
        await tester.pumpAndSettle();

        expect(edited, 'deployment-0');
        final add = find.bySemanticsLabel(
          'Add another assignment: Unknown project, 10/12/2026',
        );
        await tester.ensureVisible(add);
        await tester.tap(add);
        await tester.pumpAndSettle();

        expect(created?.projectId, 'project-0');
        expect(created?.userId, isNull);
        expect(created?.day, _monday);
        expect(tester.takeException(), isNull);
      } finally {
        semantics.dispose();
      }
    },
  );

  testWidgets('week column labels stay pinned in both scroll directions', (
    tester,
  ) async {
    _viewport(tester);
    await tester.pumpWidget(
      _host(PlanningBoard(view: _view(count: 12), today: _monday)),
    );
    await tester.pumpAndSettle();

    final label = find.descendant(
      of: find.byKey(const ValueKey((false, 'project-0'))),
      matching: find.text('Unknown project'),
    );
    final labelX = tester.getTopLeft(label).dx;
    final header = find.text('Project');
    final headerY = tester.getTopLeft(header).dy;
    final date = find.text('10/12/2026');
    final dateX = tester.getTopLeft(date).dx;

    await tester.drag(
      find.byType(SingleChildScrollView),
      const Offset(-160, 0),
    );
    await tester.pumpAndSettle();

    expect(tester.getTopLeft(label).dx, closeTo(labelX, 0.1));
    expect(tester.getTopLeft(date).dx, lessThan(dateX));
    await tester.drag(find.byType(CustomScrollView), const Offset(0, -160));
    await tester.pumpAndSettle();

    expect(tester.getTopLeft(header).dy, closeTo(headerY, 0.1));
    expect(tester.takeException(), isNull);
  });

  for (final view in ['week', 'day']) {
    testWidgets('$view board fits320px at text scale2', (tester) async {
      _viewport(tester);
      await tester.pumpWidget(
        _host(
          PlanningBoard(
            view: _view(query: 'view=$view'),
            today: _monday,
          ),
          scale: 2,
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Alice'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  }
}

Widget _host(Widget child, {double scale = 1}) {
  return MaterialApp(
    locale: const Locale('en'),
    supportedLocales: const [Locale('de'), Locale('en')],
    localizationsDelegates: GlobalMaterialLocalizations.delegates,
    home: SsTheme(
      colors: SsColors.light,
      child: MediaQuery(
        data: MediaQueryData(
          size: const Size(320, 480),
          textScaler: TextScaler.linear(scale),
        ),
        child: Scaffold(body: child),
      ),
    ),
  );
}

void _viewport(WidgetTester tester) {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = const Size(320, 480);
  addTearDown(tester.view.resetDevicePixelRatio);
  addTearDown(tester.view.resetPhysicalSize);
}

PlanningViewData _view({
  int count = 1,
  String query = '',
  List<models.UsersVacationsListResultItem> absences = const [],
  List<models.ProjectsUnavailabilityListResultItem> blocks = const [],
}) {
  final records = <models.Deployment>[];

  for (var index = 0; index < count; index++) {
    records.add(
      models.Deployment(
        id: 'deployment-$index',
        projectId: 'project-$index',
        userId: 'self',
        from: DateTime(2026, 10, 12, 7),
        to: DateTime(2026, 10, 12, 16),
        createdAt: _monday,
        modifiedAt: _monday,
      ),
    );
  }

  final data = PlanningData(
    identity: 'scope',
    deployments: records,
    absences: absences,
    blocks: blocks,
  );
  final state = PlanningState(Uri.parse('/deployments?$query'), today: _monday);

  return PlanningViewData(
    data: data,
    state: state,
    rowMode: PlanningRowMode.project,
    currentUserId: 'self',
    currentUserName: 'Alice',
    canViewAll: false,
    unknownProject: 'Unknown project',
    unknownUser: 'Unknown user',
  );
}
