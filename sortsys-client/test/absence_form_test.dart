import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/api/model.dart';
import 'package:sortsys_client/features/planning/absence_form_fields.dart';
import 'package:sortsys_client/features/planning/planning_data.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

final _day = DateTime(2026, 10, 12);
final _user = models.User(
  id: 'other',
  firstName: 'Ada',
  username: 'ada',
  contractType: models.UserContractType.values.first,
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

  testWidgets('own inclusive absence drops hidden label after type change', (
    tester,
  ) async {
    _viewport(tester);
    final values = _values();
    final form = GlobalKey<FormState>();
    values.note.text = '  Bring documents  ';

    try {
      await tester.pumpWidget(_host(values, form));
      await tester.pumpAndSettle();

      expect(form.currentState!.validate(), isTrue);
      final initial = values.draft().createInput();
      expect(initial.userId.valueOrNull, 'actor');
      expect(readRpcDate(initial.from), _day);
      expect(readRpcDate(initial.to), _day);
      expect(initial.note.valueOrNull, 'Bring documents');
      expect(find.byType(SsMultiAutocompleteField<models.User>), findsNothing);

      final select = find.byType(
        SsSelectField<models.UsersVacationsListResultItemType>,
      );
      tester
          .widget<SsSelectField<models.UsersVacationsListResultItemType>>(
            select,
          )
          .onChanged!(models.UsersVacationsListResultItemType.other);
      await tester.pumpAndSettle();

      expect(form.currentState!.validate(), isFalse);
      final label = find.byWidgetPredicate((widget) {
        return widget is SsTextField && widget.controller == values.label;
      });
      await tester.enterText(label, '  Training  ');
      expect(form.currentState!.validate(), isTrue);
      expect(values.draft().createInput().label.valueOrNull, 'Training');

      tester
          .widget<SsSelectField<models.UsersVacationsListResultItemType>>(
            select,
          )
          .onChanged!(models.UsersVacationsListResultItemType.vacation);
      await tester.pumpAndSettle();

      expect(find.text('Label'), findsNothing);
      expect(values.label.text, '  Training  ');
      expect(values.draft().createInput().label.valueOrNull, isNull);
      expect(tester.takeException(), isNull);
    } finally {
      await tester.pumpWidget(const SizedBox.shrink());
      values.dispose();
    }
  });

  testWidgets('manager must select one genuine scoped user through options', (
    tester,
  ) async {
    _viewport(tester);
    final values = _values(manage: true);
    final form = GlobalKey<FormState>();
    var scopeChecks = 0;

    try {
      await tester.pumpWidget(
        _host(
          values,
          form,
          checkCurrent: () {
            scopeChecks++;
          },
        ),
      );
      await tester.pumpAndSettle();

      expect(form.currentState!.validate(), isFalse);
      final input = find.descendant(
        of: find.byType(SsMultiAutocompleteField<models.User>),
        matching: find.byType(TextField),
      );
      await tester.enterText(input, 'Ada');
      await tester.pump(const Duration(milliseconds: 500));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Ada').last);
      await tester.pumpAndSettle();

      expect(scopeChecks, greaterThan(0));
      expect(form.currentState!.validate(), isTrue);
      expect(values.users.single.id, _user.id);
      expect(values.draft().createInput().userId.valueOrNull, _user.id);
      expect(() {
        values.users.add(_user);
      }, throwsUnsupportedError);
      expect(tester.takeException(), isNull);
    } finally {
      await tester.pumpWidget(const SizedBox.shrink());
      values.dispose();
    }
  });

  testWidgets('320px scale2 fields allow one day and reject reversed draft', (
    tester,
  ) async {
    _viewport(tester, width: 320);
    final values = _values();
    final form = GlobalKey<FormState>();

    try {
      await tester.pumpWidget(_host(values, form, scale: 2));
      await tester.pumpAndSettle();

      expect(form.currentState!.validate(), isTrue);
      expect(values.draft().createInput().from, _day);
      expect(values.draft().createInput().to, _day);
      expect(tester.takeException(), isNull);

      values.toDay = _day.subtract(const Duration(days: 1));
      expect(values.draft, throwsFormatException);
      values.toDay = null;
      expect(values.draft, throwsFormatException);
    } finally {
      await tester.pumpWidget(const SizedBox.shrink());
      values.dispose();
    }
  });
}

AbsenceFormValues _values({bool manage = false}) {
  return AbsenceFormValues(
    currentUserId: 'actor',
    canManage: manage,
    initialDay: _day,
  );
}

Widget _host(
  AbsenceFormValues values,
  GlobalKey<FormState> form, {
  double scale = 1,
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
          child: AbsenceFormFields(
            values: values,
            data: PlanningData(identity: 'scope', users: [_user]),
            identity: 'scope',
            checkCurrent: checkCurrent ?? () {},
          ),
        ),
      ),
    ),
  );
}

void _viewport(WidgetTester tester, {double width = 640}) {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = Size(width, 1000);
  addTearDown(tester.view.resetDevicePixelRatio);
  addTearDown(tester.view.resetPhysicalSize);
}
