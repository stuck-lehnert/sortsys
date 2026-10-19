import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/features/users/user_detail_layout.dart';
import 'package:sortsys_client/ui/entity_external_link.dart';
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
    'user attributes have canonical labels prices and genuine links',
    (tester) async {
      var supervisorOpens = 0;
      final user = _user(
        lastName: 'Lovelace',
        email: 'ada@example.test',
        phone: '+49 123',
        supervisor: ' A&/B ',
        cost: 25.5,
        leave: 0,
      );

      await _pump(
        tester,
        UserDetailLayout(
          user: user,
          supervisor: _user(id: ' A&/B ', firstName: 'Supervisor'),
          onSupervisorPressed: () {
            supervisorOpens++;
          },
        ),
      );

      expect(
        tester.widget<SsPageHeader>(find.byType(SsPageHeader)).title,
        'Ada Lovelace',
      );
      expect(_labels(tester), [
        'First name',
        'Last name',
        'Username',
        'Email',
        'Phone',
        'Contract',
        'Supervisor',
        'Cost per hour',
        'Leave days per year',
      ]);
      expect(find.text('€25.50'), findsOneWidget);
      expect(find.text('0'), findsOneWidget);

      final external = tester
          .widgetList<EntityExternalLink>(find.byType(EntityExternalLink))
          .toList();
      final supervisorLink = find.byWidgetPredicate((widget) {
        return widget is SsLink &&
            widget.uri?.path.startsWith('/users/') == true;
      });

      expect(
        external.map((link) {
          return link.uri.toString();
        }),
        ['mailto:ada@example.test', 'tel:+49%20123'],
      );
      expect(
        tester.widget<SsLink>(supervisorLink).uri.toString(),
        '/users/%20A%26%2FB%20',
      );
      await tester.tap(supervisorLink);

      final username = tester.widget<Text>(find.text('account'));

      expect(supervisorOpens, 1);
      expect(username.style?.fontFamily, 'monospace');
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('user fields follow truthy cost and nullable leave semantics', (
    tester,
  ) async {
    await _pump(
      tester,
      UserDetailLayout(
        user: _user(firstName: '', lastName: '', email: '', phone: '', cost: 0),
        supervisor: _user(id: 'wrong'),
      ),
    );

    expect(_labels(tester), ['First name', 'Username', 'Contract']);
    await _pump(
      tester,
      UserDetailLayout(
        user: _user(
          firstName: ' ',
          lastName: ' Name ',
          cost: 0,
          leave: 0,
          contract: models.UserContractType.externalValue,
        ),
      ),
      locale: 'de',
    );

    expect(
      tester.widget<SsPageHeader>(find.byType(SsPageHeader)).title,
      '   Name ',
    );
    expect(_labels(tester), [
      'Vorname',
      'Nachname',
      'Anmeldename',
      'Vertrag',
      'Urlaubstage pro Jahr',
    ]);
    expect(find.text('Extern'), findsOneWidget);
    expect(find.text('0'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'unmatched supervisor is omitted and optional sections keep order',
    (tester) async {
      await _pump(
        tester,
        UserDetailLayout(
          user: _user(supervisor: 'expected'),
          supervisor: _user(id: 'wrong'),
          notices: const Text('NOTICE'),
          bookedTools: const Text('BOOKINGS'),
        ),
      );

      expect(_labels(tester), isNot(contains('Supervisor')));
      expect(
        tester.getTopLeft(find.text('NOTICE')).dy,
        lessThan(tester.getTopLeft(find.byType(SsAttributeList)).dy),
      );
      expect(
        tester.getTopLeft(find.text('BOOKINGS')).dy,
        greaterThan(tester.getBottomLeft(find.byType(SsAttributeList)).dy),
      );
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('user details reach final leave field at 320px doubled Ubuntu', (
    tester,
  ) async {
    await _pump(
      tester,
      UserDetailLayout(
        user: _user(
          lastName: 'Lovelace',
          email: 'ada@example.test',
          phone: '+49 123',
          cost: 25.5,
          leave: 24,
        ),
      ),
      width: 320,
      scale: 2,
    );

    await tester.scrollUntilVisible(
      find.text('24'),
      220,
      scrollable: find.byType(Scrollable).first,
    );
    await tester.pumpAndSettle();

    expect(tester.getBottomLeft(find.text('24')).dy, lessThanOrEqualTo(900));
    expect(tester.takeException(), isNull);
  });
}

List<String> _labels(WidgetTester tester) {
  return tester.widgetList<SsAttribute>(find.byType(SsAttribute)).map((field) {
    return field.label;
  }).toList();
}

models.User _user({
  String id = 'owner',
  String firstName = 'Ada',
  String? lastName,
  String? email,
  String? phone,
  String? supervisor,
  num? cost,
  num? leave,
  models.UserContractType contract = models.UserContractType.internal,
}) {
  return models.User(
    id: id,
    firstName: firstName,
    lastName: lastName,
    username: 'account',
    email: email,
    phone: phone,
    supervisorUserId: supervisor,
    costPerHour: cost,
    vacationDaysPerYear: leave,
    contractType: contract,
    createdAt: DateTime.utc(2024),
    modifiedAt: DateTime.utc(2024),
  );
}

Future<void> _pump(
  WidgetTester tester,
  Widget child, {
  double width = 1400,
  double scale = 1,
  String locale = 'en',
}) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = Size(width, 900);
  addTearDown(tester.view.resetDevicePixelRatio);
  addTearDown(tester.view.resetPhysicalSize);

  await tester.pumpWidget(
    MaterialApp(
      locale: Locale(locale),
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
      home: Scaffold(body: child),
    ),
  );
  await tester.pumpAndSettle();
}
