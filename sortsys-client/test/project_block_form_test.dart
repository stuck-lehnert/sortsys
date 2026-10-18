import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/features/planning/planning_data.dart';
import 'package:sortsys_client/features/planning/project_block_form_fields.dart';
import 'package:sortsys_client/features/planning/project_block_write_input.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

final _day = DateTime.utc(2026, 10, 12);
final _project = models.Project(
  id: 'project',
  title: 'Workshop',
  createdAt: _day,
  modifiedAt: _day,
);

void main() {
  setUpAll(() async {
    final loader = FontLoader('packages/sortsys_ui/Ubuntu');

    for (final weight in ['Regular', 'Medium', 'Bold']) {
      loader.addFont(
        rootBundle.load(
          'packages/sortsys_ui/assets/fonts/ubuntu/Ubuntu-$weight.ttf',
        ),
      );
    }

    await loader.load();
  });

  testWidgets('real reason/comment fields produce trimmed changed-only input', (
    tester,
  ) async {
    _viewport(tester);
    final values = _values();
    final form = GlobalKey<FormState>();

    try {
      await tester.pumpWidget(_host(values, form));
      await tester.pumpAndSettle();

      final reason = _text(values.reason);
      await tester.enterText(reason, '  Maintenance  ');
      await tester.enterText(_text(values.note), '  Inspect crane  ');
      expect(form.currentState!.validate(), isTrue);

      final input = projectBlockWriteInput(values.draft(), _baseline())!;
      expect(input.data.reason.value, 'Maintenance');
      expect(input.data.note.value, 'Inspect crane');
      expect(input.data.projectId.isAbsent, isTrue);
      expect(input.data.from.isAbsent, isTrue);
      expect(input.data.to.isAbsent, isTrue);
      expect(values.fromDay!.year, 2026);
      expect(values.fromDay!.month, 10);
      expect(values.fromDay!.day, 12);

      final editable = find.descendant(
        of: reason,
        matching: find.byType(EditableText),
      );
      final frame = InputDecorator.containerOf(tester.element(editable))!;
      expect(frame.size.height, greaterThanOrEqualTo(44));
      expect(tester.takeException(), isNull);
    } finally {
      await tester.pumpWidget(const SizedBox.shrink());
      values.dispose();
    }
  });

  testWidgets('project must be selected from actual scoped options', (
    tester,
  ) async {
    _viewport(tester);
    final values = _values(selectProject: false);
    final form = GlobalKey<FormState>();
    var current = true;
    var checks = 0;

    void checkCurrent() {
      checks++;

      if (!current) {
        throw StateError('TEST_BLOCK_SCOPE_CLOSED');
      }
    }

    try {
      await tester.pumpWidget(_host(values, form, checkCurrent: checkCurrent));
      await tester.pumpAndSettle();
      expect(form.currentState!.validate(), isFalse);
      expect(values.draft, throwsFormatException);

      final selector = find.byType(SsAutocompleteField<models.Project>);
      final input = find.descendant(
        of: selector,
        matching: find.byType(TextField),
      );
      await tester.enterText(input, 'Work');
      await tester.pump(const Duration(milliseconds: 500));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Workshop').last);
      await tester.pumpAndSettle();

      expect(checks, greaterThanOrEqualTo(2));
      expect(values.project, same(_project));
      expect(form.currentState!.validate(), isTrue);
      expect(values.draft().projectId, _project.id);

      final field = tester.widget<SsAutocompleteField<models.Project>>(
        selector,
      );
      current = false;
      await expectLater(
        Future.sync(() {
          return field.loadOptions('Workshop');
        }),
        throwsStateError,
      );

      await tester.pumpWidget(
        _host(values, form, enabled: false, checkCurrent: checkCurrent),
      );
      await tester.pumpAndSettle();
      expect(
        tester.widget<SsAutocompleteField<models.Project>>(selector).enabled,
        isFalse,
      );
      expect(values.project, same(_project));
      expect(tester.takeException(), isNull);
    } finally {
      await tester.pumpWidget(const SizedBox.shrink());
      values.dispose();
    }
  });

  testWidgets('320px scale2 allows one day and rejects ranges/UTF8 overflow', (
    tester,
  ) async {
    _viewport(tester, width: 320);
    final values = _values();
    var form = GlobalKey<FormState>();
    values.reason.text = '${List.filled(63, 'ä').join()}a';
    values.note.text = '${List.filled(63, '🙂').join()}abc';

    try {
      await tester.pumpWidget(_host(values, form, scale: 2));
      await tester.pumpAndSettle();
      expect(form.currentState!.validate(), isTrue);
      expect(values.draft().from.day, 12);
      expect(values.draft().to.day, 12);
      expect(tester.takeException(), isNull);

      for (final last in <DateTime?>[DateTime.utc(2026, 10, 11), null]) {
        values.toDay = last;
        form = GlobalKey<FormState>();
        await tester.pumpWidget(_host(values, form, scale: 2));
        await tester.pumpAndSettle();

        expect(form.currentState!.validate(), isFalse);
        expect(values.draft, throwsFormatException);
      }

      values.toDay = _day;
      final longReason = List.filled(64, 'ä').join();
      final longNote = List.filled(64, '🙂').join();
      values.reason.text = longReason;
      values.note.text = longNote;
      form = GlobalKey<FormState>();
      await tester.pumpWidget(_host(values, form, scale: 2));
      await tester.pumpAndSettle();

      expect(form.currentState!.validate(), isFalse);
      await tester.pump();

      expect(values.draft, throwsFormatException);
      expect(find.text('Reason is too long.'), findsOneWidget);
      expect(find.text('Comment is too long.'), findsOneWidget);
      expect(values.reason.text, longReason);
      expect(values.note.text, longNote);
      expect(tester.takeException(), isNull);
    } finally {
      await tester.pumpWidget(const SizedBox.shrink());
      values.dispose();
    }
  });
}

ProjectBlockFormValues _values({bool selectProject = true}) {
  return ProjectBlockFormValues(
    from: _day,
    to: _day,
    project: selectProject ? _project : null,
    reason: 'Closed',
    note: 'Old comment',
  );
}

Finder _text(TextEditingController controller) {
  return find.byWidgetPredicate((widget) {
    return widget is SsTextField && widget.controller == controller;
  });
}

Widget _host(
  ProjectBlockFormValues values,
  GlobalKey<FormState> form, {
  double scale = 1,
  bool enabled = true,
  VoidCallback? checkCurrent,
}) {
  return MaterialApp(
    locale: const Locale('en'),
    supportedLocales: const [Locale('de'), Locale('en')],
    localizationsDelegates: GlobalMaterialLocalizations.delegates,
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
      body: SingleChildScrollView(
        child: Form(
          key: form,
          child: ProjectBlockFormFields(
            values: values,
            data: PlanningData(identity: 'scope', projects: [_project]),
            identity: 'scope',
            enabled: enabled,
            checkCurrent: checkCurrent ?? () {},
          ),
        ),
      ),
    ),
  );
}

models.ProjectsUnavailabilityListResultItem _baseline() {
  return models.ProjectsUnavailabilityListResultItem(
    id: 'block',
    projectId: _project.id,
    from: _day,
    to: _day,
    reason: 'Closed',
    note: 'Old comment',
    createdAt: _day,
    modifiedAt: _day,
  );
}

void _viewport(WidgetTester tester, {double width = 640}) {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = Size(width, 1000);
  addTearDown(tester.view.resetDevicePixelRatio);
  addTearDown(tester.view.resetPhysicalSize);
}
