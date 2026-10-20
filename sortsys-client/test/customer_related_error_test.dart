import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/features/customers/customer_related_sections.dart';
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

  testWidgets('customer related error matches canonical title and severity', (
    tester,
  ) async {
    for (final german in [false, true]) {
      for (final colors in [SsColors.light, SsColors.dark]) {
        await _pump(
          tester,
          CustomerRelatedContent(
            contacts: [_contact()],
            projects: const [],
            hasError: true,
          ),
          german: german,
          colors: colors,
        );

        final message = german
            ? 'Verknüpfte Daten konnten nicht geladen werden'
            : 'Related data could not be loaded';
        final calloutFinder = find.byType(SsInfoCallout);
        final callout = tester.widget<SsInfoCallout>(calloutFinder);
        final title = tester.widget<Text>(find.text(message));
        final liveRegion = tester.widget<Semantics>(
          find
              .ancestor(of: calloutFinder, matching: find.byType(Semantics))
              .first,
        );

        expect(callout.kind, SsCalloutKind.error);
        expect(callout.icon, isNull);
        expect(title.style?.fontWeight, FontWeight.w700);
        expect(liveRegion.properties.liveRegion, isTrue);
        expect(
          find.text(german ? 'Ansprechpartner (1)' : 'Contacts (1)'),
          findsOneWidget,
        );
        expect(find.text('Projects (0)'), findsNothing);
        expect(find.text('Reload'), findsNothing);
        expect(find.text('Erneut laden'), findsNothing);
        expect(tester.takeException(), isNull);
      }
    }
  });

  testWidgets('customer error retains partial records and real reload action', (
    tester,
  ) async {
    var reloads = 0;

    await _pump(
      tester,
      CustomerRelatedContent(
        contacts: [_contact()],
        projects: const [],
        hasError: true,
        onRetry: () {
          reloads++;
        },
      ),
    );
    await tester.tap(find.text('Reload'));
    await tester.pumpAndSettle();

    expect(reloads, 1);
    expect(find.byType(SsInfoCallout), findsOneWidget);

    await tester.tap(find.text('Contacts (1)'));
    await tester.pumpAndSettle();

    expect(find.text('Ada Example').hitTestable(), findsOneWidget);
    expect(
      tester.widgetList<SsLink>(find.byType(SsLink)).map((link) {
        return link.uri;
      }),
      contains(Uri.parse('/contacts/contact%2F1')),
    );
    expect(tester.takeException(), isNull);

    await _pump(
      tester,
      const CustomerRelatedContent(contacts: [], projects: []),
    );

    expect(find.byType(SsInfoCallout), findsNothing);
    expect(find.byType(SsDisclosure), findsNothing);
    expect(find.text('Reload'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'customer error wraps at320px with doubled German Ubuntu and RTL',
    (tester) async {
      for (final direction in [TextDirection.ltr, TextDirection.rtl]) {
        var reloads = 0;

        await _pump(
          tester,
          CustomerRelatedContent(
            contacts: [_contact()],
            projects: const [],
            hasError: true,
            onRetry: () {
              reloads++;
            },
          ),
          german: true,
          width: 320,
          scale: 2,
          direction: direction,
        );

        final callout = find.byType(SsInfoCallout);

        expect(tester.getSize(callout).width, 320);
        expect(tester.getTopLeft(callout).dx, greaterThanOrEqualTo(0));
        expect(tester.getBottomRight(callout).dx, lessThanOrEqualTo(320));
        expect(
          find.text('Verknüpfte Daten konnten nicht geladen werden'),
          findsOneWidget,
        );

        await tester.ensureVisible(find.text('Erneut laden'));
        await tester.tap(find.text('Erneut laden'));
        await tester.pumpAndSettle();

        expect(reloads, 1);
        expect(find.text('Ansprechpartner (1)'), findsOneWidget);
        expect(tester.takeException(), isNull);
      }
    },
  );
}

models.Contact _contact() {
  return models.Contact(
    id: 'contact/1',
    firstName: 'Ada',
    lastName: 'Example',
    phoneNumbers: const [],
    emailAddresses: const [],
    createdAt: DateTime(2024),
    modifiedAt: DateTime(2024),
  );
}

Future<void> _pump(
  WidgetTester tester,
  Widget content, {
  bool german = false,
  SsColors? colors,
  double width = 800,
  double scale = 1,
  TextDirection direction = TextDirection.ltr,
}) async {
  await tester.pumpWidget(
    MaterialApp(
      locale: Locale(german ? 'de' : 'en'),
      supportedLocales: const [Locale('en'), Locale('de')],
      localizationsDelegates: GlobalMaterialLocalizations.delegates,
      home: SsTheme(
        colors: colors ?? SsColors.light,
        child: Scaffold(
          body: Align(
            alignment: Alignment.topLeft,
            child: SizedBox(
              width: width,
              height: 560,
              child: MediaQuery(
                data: MediaQueryData(
                  size: Size(width, 560),
                  textScaler: TextScaler.linear(scale),
                ),
                child: Directionality(
                  textDirection: direction,
                  child: SingleChildScrollView(child: content),
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
