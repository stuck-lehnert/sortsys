import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/features/users/user_detail_layout.dart';
import 'package:sortsys_client/features/users/user_detail_notices.dart';
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

  testWidgets('active unarchived user has no status notice', (tester) async {
    await _pump(tester, UserDetailNotices(user: _user(), now: _now));

    expect(find.byType(SsInfoCallout), findsNothing);
    expect(find.byType(Text), findsNothing);
  });

  testWidgets(
    'deactivation uses strict future boundary and canonical local dates',
    (tester) async {
      for (final difference in [-1, 0, 1]) {
        final date = _now.add(Duration(milliseconds: difference));
        await _pump(
          tester,
          UserDetailNotices(
            user: _user(deactivatedAt: date),
            now: _now,
          ),
        );

        expect(
          find.text(
            difference > 0
                ? 'User will be deactivated on 06/15/2024.'
                : 'User has been deactivated since 06/15/2024.',
          ),
          findsOneWidget,
        );
        expect(
          tester.widget<SsInfoCallout>(find.byType(SsInfoCallout)).kind,
          SsCalloutKind.warning,
        );
        expect(tester.takeException(), isNull);
      }
    },
  );

  testWidgets(
    'deactivation precedes archive and grey resolves to info in both languages',
    (tester) async {
      for (final german in [false, true]) {
        final user = _user(
          deactivatedAt: DateTime(2024, 6, 14),
          archivedAt: DateTime(2024, 5, 1),
        );
        await _pump(
          tester,
          UserDetailNotices(user: user, now: _now),
          locale: german ? 'de' : 'en',
        );
        final notices = find.byType(SsInfoCallout);

        expect(notices, findsNWidgets(2));
        expect(
          tester.widget<SsInfoCallout>(notices.at(0)).kind,
          SsCalloutKind.warning,
        );
        expect(
          tester.widget<SsInfoCallout>(notices.at(1)).kind,
          SsCalloutKind.info,
        );
        expect(
          find.text(
            german
                ? 'Benutzer ist seit 14.06.2024 deaktiviert.'
                : 'User has been deactivated since 06/14/2024.',
          ),
          findsOneWidget,
        );
        expect(
          find.text(
            german
                ? 'Benutzer ist seit 01.05.2024 archiviert.'
                : 'User has been archived since 05/01/2024.',
          ),
          findsOneWidget,
        );
        expect(
          tester.getTopLeft(notices.at(1)).dy,
          tester.getBottomLeft(notices.at(0)).dy,
        );
        expect(
          tester.widgetList<SsIcon>(find.byType(SsIcon)).map((icon) {
            return icon.name;
          }),
          ['lock', 'archive'],
        );
        expect(tester.takeException(), isNull);
      }
    },
  );

  testWidgets(
    'real user detail scrolls German notices at320px with doubled Ubuntu and RTL',
    (tester) async {
      final user = _user(
        deactivatedAt: DateTime(2024, 7, 1),
        archivedAt: DateTime(2024, 5, 1),
      );

      for (final direction in [TextDirection.ltr, TextDirection.rtl]) {
        await _pump(
          tester,
          UserDetailLayout(
            user: user,
            notices: UserDetailNotices(user: user, now: _now),
          ),
          locale: 'de',
          width: 320,
          scale: 2,
          direction: direction,
        );

        expect(
          find.text('Benutzer wird am 01.07.2024 deaktiviert.'),
          findsOneWidget,
        );
        expect(find.byType(SsInfoCallout), findsNWidgets(2));
        await tester.drag(find.byType(ListView), const Offset(0, -450));
        await tester.pumpAndSettle();

        expect(
          tester.widgetList<SsIcon>(find.byType(SsIcon)).map((icon) {
            return icon.name;
          }),
          ['lock', 'archive'],
        );
        expect(tester.takeException(), isNull);
      }
    },
  );
}

final _now = DateTime(2024, 6, 15, 12);

models.User _user({DateTime? deactivatedAt, DateTime? archivedAt}) {
  return models.User(
    id: 'user',
    firstName: 'Ada',
    username: 'account',
    contractType: models.UserContractType.internal,
    createdAt: DateTime(2024),
    modifiedAt: DateTime(2024),
    deactivatedAt: deactivatedAt,
    archivedAt: archivedAt,
  );
}

Future<void> _pump(
  WidgetTester tester,
  Widget child, {
  String locale = 'en',
  double width = 800,
  double scale = 1,
  TextDirection direction = TextDirection.ltr,
}) async {
  tester.view.physicalSize = Size(width, 900);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);

  await tester.pumpWidget(
    MaterialApp(
      locale: Locale(locale),
      supportedLocales: const [Locale('en'), Locale('de')],
      localizationsDelegates: GlobalMaterialLocalizations.delegates,
      home: SsTheme(
        colors: SsColors.light,
        child: MediaQuery(
          data: MediaQueryData(textScaler: TextScaler.linear(scale)),
          child: Directionality(
            textDirection: direction,
            child: Scaffold(body: child),
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}
