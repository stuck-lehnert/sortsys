import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/features/users/user_supervisor_layout.dart';
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
    'supervisor tree expands actual reports and links genuine users',
    (tester) async {
      final selected = <models.User>[];

      await _pump(tester, users: _users(), onUserPressed: selected.add);

      expect(find.text('Default supervisor: Root'), findsOneWidget);
      expect(find.text('Root'), findsOneWidget);
      expect(find.text('Orphan'), findsOneWidget);
      expect(find.text('Child'), findsNothing);

      await tester.tap(find.text('Show direct reports (1)'));
      await tester.pumpAndSettle();

      expect(find.text('Child'), findsOneWidget);
      expect(find.text('Grandchild'), findsNothing);

      await tester.tap(find.text('Expand all'));
      await tester.pumpAndSettle();

      expect(find.text('Grandchild'), findsOneWidget);
      expect(find.text('Collapse all'), findsOneWidget);

      final link = tester.widget<SsLink>(find.widgetWithText(SsLink, 'Root'));

      expect(link.uri.toString(), '/users/root%2F%C3%A4');

      await tester.ensureVisible(find.text('Root'));
      await tester.tap(find.text('Root'));
      await tester.pump();

      expect(selected.single.id, 'root/ä');

      await tester.tap(find.text('Collapse all'));
      await tester.pumpAndSettle();

      expect(find.text('Child'), findsNothing);
      expect(find.text('Grandchild'), findsNothing);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('supervisor tree terminates self cycles after expansion', (
    tester,
  ) async {
    await _pump(tester, users: [_user('self', 'Self', supervisor: 'self')]);

    expect(find.text('Cycles or orphaned entries'), findsOneWidget);
    expect(find.text('Cycle detected'), findsNothing);

    await tester.tap(find.text('Expand all'));
    await tester.pumpAndSettle();

    expect(find.text('Self'), findsNWidgets(2));
    expect(find.text('Cycle detected'), findsOneWidget);
    expect(find.text('Hide direct reports'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'supervisor loading empty and partial errors retain canonical states',
    (tester) async {
      await _pump(tester, users: null, hasError: true);

      expect(find.text('Loading supervisor hierarchy …'), findsOneWidget);
      expect(find.byType(SsSpinner), findsOneWidget);
      expect(_button(tester, 'Expand all').onPressed, isNull);

      await _pump(
        tester,
        users: _users(),
        hasError: true,
        defaultSupervisorId: 'not-in-list',
      );

      expect(find.text('Root'), findsOneWidget);
      expect(find.textContaining('Default supervisor:'), findsNothing);
      expect(
        tester.widget<SsInfoCallout>(find.byType(SsInfoCallout)).kind,
        SsCalloutKind.error,
      );
      expect(
        find.text('The supervisor hierarchy could not be loaded completely'),
        findsOneWidget,
      );

      await _pump(tester, users: []);

      expect(find.text('No users available.'), findsOneWidget);
      expect(find.byType(SsSpinner), findsNothing);
      expect(_button(tester, 'Expand all').onPressed, isNull);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('supervisor expansion survives refresh but not scope changes', (
    tester,
  ) async {
    await _pump(tester, users: _users());
    await tester.tap(find.text('Expand all'));
    await tester.pumpAndSettle();

    await _pump(tester, users: _users());

    expect(find.text('Grandchild'), findsOneWidget);

    await _pump(tester, users: _users(), identity: 'different-owner');

    expect(find.text('Child'), findsNothing);
    expect(find.text('Grandchild'), findsNothing);
    expect(find.text('Expand all'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'supervisor narrow German tree scrolls with doubled text in RTL',
    (tester) async {
      await _pump(
        tester,
        users: _users(),
        language: 'de',
        width: 320,
        scale: 2,
      );

      await tester.tap(find.text('Alle aufklappen'));
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('Grandchild'));

      final scrolling = find.byWidgetPredicate((widget) {
        return widget is SingleChildScrollView &&
            widget.scrollDirection == Axis.horizontal;
      });

      expect(scrolling, findsWidgets);
      expect(find.text('Grandchild'), findsOneWidget);
      expect(find.text('Alle zuklappen'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );
}

SsButton _button(WidgetTester tester, String label) {
  return tester.widget<SsButton>(find.widgetWithText(SsButton, label));
}

Future<void> _pump(
  WidgetTester tester, {
  required List<models.User>? users,
  String identity = 'scope',
  String? defaultSupervisorId = 'root/ä',
  bool hasError = false,
  ValueChanged<models.User>? onUserPressed,
  String language = 'en',
  double width = 800,
  double scale = 1,
}) async {
  await tester.pumpWidget(
    MaterialApp(
      locale: Locale(language),
      supportedLocales: const [Locale('en'), Locale('de')],
      localizationsDelegates: GlobalMaterialLocalizations.delegates,
      home: SsTheme(
        colors: SsColors.light,
        child: Center(
          child: SizedBox(
            width: width,
            height: 600,
            child: MediaQuery(
              data: MediaQueryData(
                size: Size(width, 600),
                textScaler: TextScaler.linear(scale),
              ),
              child: Directionality(
                textDirection: language == 'de'
                    ? TextDirection.rtl
                    : TextDirection.ltr,
                child: Scaffold(
                  body: UserSupervisorLayout(
                    queryIdentity: identity,
                    compareNames: _compare,
                    users: users,
                    defaultSupervisorId: defaultSupervisorId,
                    hasError: hasError,
                    onUserPressed: onUserPressed,
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );

  if (users == null) {
    await tester.pump();

    return;
  }

  await tester.pumpAndSettle();
}

int _compare(String left, String right) {
  return left.compareTo(right);
}

List<models.User> _users() {
  return [
    _user('root/ä', 'Root'),
    _user('child', 'Child', supervisor: 'root/ä'),
    _user('grandchild', 'Grandchild', supervisor: 'child'),
    _user('orphan', 'Orphan', supervisor: 'missing'),
  ];
}

models.User _user(String id, String name, {String? supervisor}) {
  return models.User(
    id: id,
    firstName: name,
    username: id,
    contractType: models.UserContractType.internal,
    supervisorUserId: supervisor,
    createdAt: DateTime.utc(2024),
    modifiedAt: DateTime.utc(2024),
  );
}
