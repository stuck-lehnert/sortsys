import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/features/projects/project_draft.dart';
import 'package:sortsys_client/features/projects/project_overview_screen.dart';
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

  testWidgets('overview shows actual title address and project content', (
    tester,
  ) async {
    _viewport(tester);
    await _pump(tester, project: _project());

    expect(find.text('Harbor'), findsOneWidget);
    expect(find.text('Pier 7, 20457 Hamburg'), findsOneWidget);
    expect(find.text('Project details'), findsOneWidget);
    expect(find.text('Created'), findsNothing);
    expect(find.text('Modified'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('project action menu invokes the real edit callback once', (
    tester,
  ) async {
    _viewport(tester);
    var edits = 0;

    await _pump(
      tester,
      onEdit: () {
        edits++;
      },
    );
    await tester.tap(find.byTooltip('Project actions'));
    await tester.pumpAndSettle();

    expect(find.text('Edit'), findsOneWidget);
    await tester.tap(find.text('Edit'));
    await tester.pumpAndSettle();

    expect(edits, 1);
    expect(find.text('Edit'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('Ctrl E invokes edit while busy and read-only states reject it', (
    tester,
  ) async {
    _viewport(tester);
    var edits = 0;

    void edit() {
      edits++;
    }

    await _pump(tester, onEdit: edit);
    await _editShortcut(tester);
    expect(edits, 1);

    await _pump(tester, onEdit: edit, editing: true);
    await _editShortcut(tester);
    final button = tester.widget<SsIconButton>(find.byType(SsIconButton).first);
    expect(button.onPressed, isNull);
    expect(edits, 1);

    await _pump(tester);
    await _editShortcut(tester);
    expect(find.byTooltip('Project actions'), findsNothing);
    expect(edits, 1);
    expect(tester.takeException(), isNull);
  });

  testWidgets('finished project has the canonical completion notice', (
    tester,
  ) async {
    _viewport(tester);
    await _pump(tester, project: _project(finished: true));

    expect(find.byType(SsInfoCallout), findsOneWidget);
    final icon = tester.widget<SsIcon>(find.byType(SsIcon));
    expect(icon.name, 'task-complete');

    expect(
      find.text('Project has been completed since 12.10.2026.'),
      findsOneWidget,
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('320px doubled text retains project actions and menu selection', (
    tester,
  ) async {
    _viewport(tester, width: 320);
    var edits = 0;

    await _pump(
      tester,
      scale: 2,
      onEdit: () {
        edits++;
      },
    );
    await tester.tap(find.byTooltip('Project actions'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Edit'));
    await tester.pumpAndSettle();

    expect(edits, 1);
    expect(find.text('Harbor'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}

Future<void> _editShortcut(WidgetTester tester) async {
  await tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
  await tester.sendKeyEvent(LogicalKeyboardKey.keyE);
  await tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
  await tester.pump();
}

Future<void> _pump(
  WidgetTester tester, {
  models.Project? project,
  VoidCallback? onEdit,
  bool editing = false,
  double scale = 1,
}) async {
  await tester.pumpWidget(
    MaterialApp(
      locale: const Locale('en'),
      builder: (context, navigator) {
        return SsTheme(
          colors: SsColors.light,
          child: MediaQuery(
            data: MediaQuery.of(
              context,
            ).copyWith(textScaler: TextScaler.linear(scale)),
            child: navigator ?? const SizedBox.shrink(),
          ),
        );
      },
      home: Scaffold(
        body: ProjectOverviewLayout(
          project: project ?? _project(),
          onEdit: onEdit,
          editing: editing,
          child: const Text('Project details'),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void _viewport(WidgetTester tester, {double width = 640}) {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = Size(width, 900);
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
}

models.Project _project({bool finished = false}) {
  final day = DateTime(2026, 10, 12);
  const draft = ProjectDraft(
    title: 'Harbor',
    useAddress: true,
    streetAddress: 'Pier 7',
    zip: '20457',
    city: 'Hamburg',
    country: 'Germany',
  );

  return models.Project(
    id: 'project',
    title: 'Harbor',
    address: draft.createInput().address.value,
    createdAt: day,
    modifiedAt: day,
    finishedAt: finished ? day : null,
  );
}
