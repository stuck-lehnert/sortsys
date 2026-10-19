import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/api/model.dart';
import 'package:sortsys_client/features/contacts/contact_detail_layout.dart';
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

  test('contact names preserve canonical truthiness and whitespace', () {
    expect(contactName(_contact()), 'Dr. Ada Harbor');
    expect(contactName(_contact(minimal: true)), '');
    final salutationOnly = models.Contact(
      id: 'one',
      salutation: 'Dr.',
      phoneNumbers: const [],
      emailAddresses: const [],
      createdAt: DateTime.utc(2026, 1, 1),
      modifiedAt: DateTime.utc(2026, 1, 1),
    );
    expect(contactName(salutationOnly), 'Dr. ');
    final whitespace = models.Contact(
      id: 'one',
      firstName: ' Ada ',
      lastName: ' Harbor ',
      phoneNumbers: const [],
      emailAddresses: const [],
      createdAt: DateTime.utc(2026, 1, 1),
      modifiedAt: DateTime.utc(2026, 1, 1),
    );
    expect(contactName(whitespace), ' Ada   Harbor ');
  });

  testWidgets('contact detail has canonical attributes and real link targets', (
    tester,
  ) async {
    await _pump(tester, _contact());

    expect(find.text('Dr. Ada Harbor'), findsOneWidget);
    expect(find.text('Ada'), findsOneWidget);
    expect(find.text('Harbor'), findsOneWidget);
    expect(find.text('Pier 7, 20457 Hamburg'), findsOneWidget);
    expect(find.text('Germany'), findsNothing);
    expect(find.text('Created'), findsNothing);
    expect(find.text('Contact content'), findsOneWidget);

    final locations = tester.widgetList<SsLink>(find.byType(SsLink)).map((link) {
      return link.uri.toString();
    }).toList();

    expect(locations, [
      'https://www.google.com/maps/search/Pier%207%2C%2020457%20Hamburg',
      'mailto:ada@example.org',
      'tel:+49%2040%20123',
    ]);
    expect(tester.takeException(), isNull);
  });

  testWidgets('nullable first name retains a blank field without placeholders', (
    tester,
  ) async {
    await _pump(tester, _contact(minimal: true));

    final attribute = tester.widget<SsAttribute>(find.byType(SsAttribute));
    expect(attribute.label, 'First name');
    expect((attribute.child as Text).data, '');
    expect(find.byType(SsLink), findsNothing);
    expect(find.text('Unknown'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('contact page title follows canonical nonempty name behavior', (
    tester,
  ) async {
    await _pump(tester, _contact());
    final titles = find.descendant(
      of: find.byType(ContactDetailLayout),
      matching: find.byType(Title),
    );

    expect(tester.widget<Title>(titles).title, 'Dr. Ada Harbor');

    await _pump(tester, _contact(minimal: true));
    expect(titles, findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('contact channels preserve empty labels and localize null fallback', (
    tester,
  ) async {
    await _pump(tester, _contact());
    final english = tester.widgetList<SsAttribute>(find.byType(SsAttribute));

    expect(english.map((attribute) {
      return attribute.label;
    }).toList(), ['Salutation', 'First name', 'Last name', 'Address', '', 'Phone 1']);

    await _pump(tester, _contact(), locale: const Locale('de'));
    final german = tester.widgetList<SsAttribute>(find.byType(SsAttribute));

    expect(german.map((attribute) {
      return attribute.label;
    }).toList(), ['Anrede', 'Vorname', 'Nachname', 'Anschrift', '', 'Telefon 1']);
    expect(tester.takeException(), isNull);
  });

  testWidgets('contact outer scroll reaches content at320px with doubled text', (
    tester,
  ) async {
    await _pump(tester, _contact(), width: 320, scale: 2);
    expect(tester.takeException(), isNull);

    await tester.scrollUntilVisible(
      find.text('Contact content'),
      200,
      scrollable: find.byType(Scrollable).first,
    );
    await tester.pumpAndSettle();
    final content = tester.getRect(find.text('Contact content'));

    expect(content.top, greaterThanOrEqualTo(0));
    expect(content.bottom, lessThanOrEqualTo(800));
    expect(tester.takeException(), isNull);
  });
}

models.Contact _contact({bool minimal = false}) {
  return models.Contact(
    id: 'contact/one',
    salutation: minimal ? null : 'Dr.',
    firstName: minimal ? null : 'Ada',
    lastName: minimal ? null : 'Harbor',
    address: minimal
        ? null
        : const models.ProjectAddress(
            streetAddress: 'Pier 7',
            zip: RpcOptional.value('20457'),
            city: 'Hamburg',
            country: RpcOptional.value('Germany'),
          ),
    phoneNumbers: minimal
        ? const []
        : const [models.CustomerPhoneNumbersItem(number: '+49 40 123')],
    emailAddresses: minimal
        ? const []
        : const [
            models.CustomerEmailAddressesItem(
              name: RpcOptional.value(''),
              email: 'ada@example.org',
            ),
          ],
    createdAt: DateTime.utc(2026, 1, 1),
    modifiedAt: DateTime.utc(2026, 1, 1),
  );
}

Future<void> _pump(
  WidgetTester tester,
  models.Contact contact, {
  double width = 1200,
  double scale = 1,
  Locale locale = const Locale('en'),
}) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = Size(width, 800);
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);

  await tester.pumpWidget(
    MaterialApp(
      locale: locale,
      supportedLocales: const [Locale('de'), Locale('en')],
      localizationsDelegates: GlobalMaterialLocalizations.delegates,
      builder: (context, child) {
        return SsTheme(
          colors: SsColors.light,
          child: MediaQuery(
            data: MediaQuery.of(context).copyWith(
              textScaler: TextScaler.linear(scale),
            ),
            child: child!,
          ),
        );
      },
      home: Scaffold(
        body: ContactDetailLayout(
          contact: contact,
          child: const Text('Contact content'),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}
