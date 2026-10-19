import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/api/model.dart';
import 'package:sortsys_client/features/contacts/contact_detail_layout.dart';
import 'package:sortsys_client/features/contacts/contact_related_sections.dart';
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

  test('contact relationship queries use the exact contactId filter', () {
    expect(contactCustomersInput('contact/one').toWire(), {
      'contactId': 'contact/one',
    });
    expect(contactProjectsInput('contact/one').toWire(), {
      'contactId': 'contact/one',
    });
  });

  testWidgets('related sections start collapsed and expose genuine entity URIs', (
    tester,
  ) async {
    await _pump(tester, ContactRelatedContent(
      customers: [_customer()],
      projects: [_project()],
    ));

    expect(find.text('Customers (1)'), findsOneWidget);
    expect(find.text('Projects (1)'), findsOneWidget);
    expect(find.text('Hafenbau'), findsNothing);
    expect(find.text('Pier project'), findsNothing);

    await tester.tap(find.text('Customers (1)'));
    await tester.pumpAndSettle();
    expect(find.text('Hafenbau'), findsOneWidget);
    expect(find.text('Pier project'), findsNothing);

    final customerLinks = tester.widgetList<SsLink>(find.byType(SsLink));
    expect(customerLinks.any((link) {
      return link.uri.toString() == '/customers/customer%2Fone';
    }), isTrue);

    await tester.scrollUntilVisible(
      find.text('Projects (1)'),
      100,
      scrollable: find.byType(Scrollable).first,
    );
    await tester.tap(find.text('Projects (1)'));
    await tester.pumpAndSettle();
    final links = tester.widgetList<SsLink>(find.byType(SsLink));
    expect(links.any((link) {
      return link.uri.toString() == '/projects/project%2Fone';
    }), isTrue);
    expect(tester.takeException(), isNull);
  });

  testWidgets('customer card keeps one canonical attribute group and labels', (
    tester,
  ) async {
    await _pump(tester, ContactCustomerCard(customer: _customer()));

    expect(find.byType(SsAttributeList), findsNWidgets(2));
    final card = find.byType(ContactCustomerCard);
    expect(find.descendant(of: card, matching: find.byType(SsAttributeList)),
        findsOneWidget);
    final fields = tester.widgetList<SsAttribute>(find.descendant(
      of: card,
      matching: find.byType(SsAttribute),
    ));
    expect(fields.map((field) {
      return field.label;
    }).toList(), ['Anschrift', 'E-Mail 1', 'Telefon 1']);

    final urls = tester.widgetList<SsLink>(find.descendant(
      of: card,
      matching: find.byType(SsLink),
    )).map((link) {
      return link.uri.toString();
    }).toList();
    expect(urls, [
      '/customers/customer%2Fone',
      'https://www.google.com/maps/search/Pier%207%2C%2020457%20Hamburg',
      'mailto:office@example.org',
      'tel:+49%2040%20123',
    ]);
    expect(tester.takeException(), isNull);
  });

  testWidgets('related failure retains successful sections and real retry', (
    tester,
  ) async {
    var retries = 0;
    await _pump(tester, ContactRelatedContent(
      customers: [_customer()],
      projects: const [],
      hasError: true,
      onRetry: () {
        retries++;
      },
    ));

    expect(find.text('Related data could not be loaded'), findsOneWidget);
    expect(find.text('Customers (1)'), findsOneWidget);
    expect(find.text('Projects (0)'), findsNothing);
    await tester.tap(find.text('Reload'));
    expect(retries, 1);
    await tester.tap(find.text('Customers (1)'));
    await tester.pumpAndSettle();
    expect(find.text('Hafenbau'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('expanded related cards scroll at320px with doubled text', (
    tester,
  ) async {
    await _pump(tester, ContactRelatedContent(
      customers: [_customer()],
      projects: [_project()],
    ), width: 320, scale: 2);
    await tester.tap(find.text('Customers (1)'));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);

    await tester.scrollUntilVisible(
      find.text('Projects (1)'),
      200,
      scrollable: find.byType(Scrollable).first,
    );
    await tester.tap(find.text('Projects (1)'));
    await tester.pumpAndSettle();
    await tester.scrollUntilVisible(
      find.text('Pier project'),
      100,
      scrollable: find.byType(Scrollable).first,
    );
    await tester.pumpAndSettle();

    expect(tester.getRect(find.text('Pier project')).bottom,
        lessThanOrEqualTo(800));
    expect(tester.takeException(), isNull);
  });
}

const _address = models.ProjectAddress(
  streetAddress: 'Pier 7',
  zip: RpcOptional.value('20457'),
  city: 'Hamburg',
);

models.Customer _customer() {
  return models.Customer(
    id: 'customer/one',
    name: 'Hafenbau',
    address: _address,
    phoneNumbers: const [
      models.CustomerPhoneNumbersItem(number: '+49 40 123'),
    ],
    emailAddresses: const [
      models.CustomerEmailAddressesItem(email: 'office@example.org'),
    ],
    createdAt: DateTime.utc(2026, 1, 1),
    modifiedAt: DateTime.utc(2026, 1, 1),
  );
}

models.Project _project() {
  return models.Project(
    id: 'project/one',
    title: 'Pier project',
    address: _address,
    createdAt: DateTime.utc(2026, 1, 1),
    modifiedAt: DateTime.utc(2026, 1, 1),
  );
}

Future<void> _pump(
  WidgetTester tester,
  Widget content, {
  double width = 1200,
  double scale = 1,
}) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = Size(width, 800);
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);

  await tester.pumpWidget(MaterialApp(
    locale: const Locale('en'),
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
        contact: models.Contact(
          id: 'contact/one',
          firstName: 'Ada',
          phoneNumbers: const [],
          emailAddresses: const [],
          createdAt: DateTime.utc(2026, 1, 1),
          modifiedAt: DateTime.utc(2026, 1, 1),
        ),
        child: content,
      ),
    ),
  ));
  await tester.pumpAndSettle();
}
