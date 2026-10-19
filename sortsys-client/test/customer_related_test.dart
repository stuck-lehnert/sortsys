import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/api/model.dart';
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

  testWidgets('related cards start collapsed and retain actual link targets', (
    tester,
  ) async {
    await _pump(
      tester,
      CustomerRelatedContent(contacts: [_contact()], projects: [_project()]),
    );

    expect(find.text('Contacts (1)'), findsOneWidget);
    expect(find.text('Projects (1)'), findsOneWidget);
    expect(find.text('Ada Example').hitTestable(), findsNothing);
    expect(find.text('Harbor').hitTestable(), findsNothing);

    await tester.tap(find.text('Contacts (1)'));
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text('Projects (1)'));
    await tester.tap(find.text('Projects (1)'));
    await tester.pumpAndSettle();

    final links = tester.widgetList<SsLink>(find.byType(SsLink)).map((link) {
      return link.uri.toString();
    }).toList();
    expect(links, contains('/contacts/contact%2F1'));
    expect(links, contains('/projects/project%2F2'));
    expect(links, contains('mailto:ada@example.org'));
    expect(links, contains('tel:+49%2040%207'));
    expect(
      links.where((url) {
        return url.startsWith('https://www.google.com/maps/search/');
      }),
      hasLength(2),
    );

    final attributes = tester.widgetList<SsAttribute>(find.byType(SsAttribute));
    expect(
      attributes.map((attribute) {
        return attribute.label;
      }),
      ['Address', '', 'Phone 1', 'Address'],
    );
    expect(find.text('Customer'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'one canonical error retains partial successes and genuine retry',
    (tester) async {
      var retries = 0;
      await _pump(
        tester,
        CustomerRelatedContent(
          contacts: [_contact()],
          projects: const [],
          hasError: true,
          onRetry: () {
            retries++;
          },
        ),
      );

      expect(find.text('Related data could not be loaded'), findsOneWidget);
      expect(find.text('Contacts (1)'), findsOneWidget);
      expect(find.text('Projects (0)'), findsNothing);
      await tester.tap(find.text('Reload'));
      await tester.pump();
      expect(retries, 1);
      expect(tester.takeException(), isNull);

      await _pump(
        tester,
        const CustomerRelatedContent(contacts: [], projects: []),
      );
      expect(find.byType(SsDisclosure), findsNothing);
      expect(find.text('Related data could not be loaded'), findsNothing);
    },
  );

  testWidgets('related cards expand and scroll at 320px with doubled text', (
    tester,
  ) async {
    await _pump(
      tester,
      CustomerRelatedContent(contacts: [_contact()], projects: [_project()]),
      width: 320,
      scale: 2,
    );
    await tester.tap(find.text('Contacts (1)'));
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text('+49 40 7'));
    await tester.pumpAndSettle();
    expect(
      tester.getRect(find.text('+49 40 7')).bottom,
      lessThanOrEqualTo(800),
    );
    expect(tester.takeException(), isNull);

    await tester.ensureVisible(find.text('Projects (1)'));
    await tester.tap(find.text('Projects (1)'));
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text('Pier 7, 20457 Hamburg').last);
    await tester.pumpAndSettle();
    expect(
      tester.getRect(find.text('Pier 7, 20457 Hamburg').last).bottom,
      lessThanOrEqualTo(800),
    );
    expect(tester.takeException(), isNull);
  });
}

const _address = models.ProjectAddress(
  streetAddress: 'Pier 7',
  city: 'Hamburg',
  zip: RpcOptional.value('20457'),
);

models.Contact _contact() {
  return models.Contact(
    id: 'contact/1',
    firstName: 'Ada',
    lastName: 'Example',
    address: _address,
    emailAddresses: const [
      models.CustomerEmailAddressesItem(
        email: 'ada@example.org',
        name: RpcOptional.value(''),
      ),
    ],
    phoneNumbers: const [models.CustomerPhoneNumbersItem(number: '+49 40 7')],
    createdAt: DateTime.utc(2026, 10, 12),
    modifiedAt: DateTime.utc(2026, 10, 12),
  );
}

models.Project _project() {
  return models.Project(
    id: 'project/2',
    title: 'Harbor',
    customerId: 'customer-3',
    address: _address,
    createdAt: DateTime.utc(2026, 10, 12),
    modifiedAt: DateTime.utc(2026, 10, 12),
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
  addTearDown(tester.view.resetDevicePixelRatio);
  addTearDown(tester.view.resetPhysicalSize);

  await tester.pumpWidget(
    MaterialApp(
      locale: const Locale('en'),
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
      home: Scaffold(body: SingleChildScrollView(child: content)),
    ),
  );
  await tester.pumpAndSettle();
}
