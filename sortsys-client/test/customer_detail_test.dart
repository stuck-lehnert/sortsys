import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/api/model.dart';
import 'package:sortsys_client/features/customers/customer_detail_screen.dart';
import 'package:sortsys_client/features/projects/project_history.dart';
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

  test('customer activity scopes requests without project context', () {
    final customer = projectActivityInput(
      'customer-7',
      cursor: 'older-1',
      resourceType: models.ActivityResourceType.customer,
    ).valueOrNull!;
    final project = projectActivityInput('project-3').valueOrNull!;

    expect(
      customer.resourceType.valueOrNull,
      models.ActivityResourceType.customer,
    );
    expect(customer.resourceId.valueOrNull, 'customer-7');
    expect(customer.includeProjectContext.valueOrNull, isFalse);
    expect(customer.cursor.valueOrNull, 'older-1');
    expect(customer.limit.valueOrNull, 50);
    expect(
      project.resourceType.valueOrNull,
      models.ActivityResourceType.project,
    );
    expect(project.includeProjectContext.valueOrNull, isTrue);
    expect(project.cursor.isAbsent, isTrue);
  });

  testWidgets(
    'detail uses canonical customer attributes and real link targets',
    (tester) async {
      await _pump(tester, _customer());

      expect(find.text('Firma Hafenbau'), findsOneWidget);
      expect(find.text('Firma'), findsOneWidget);
      expect(find.text('Hafenbau'), findsOneWidget);
      expect(find.text('Pier 7, 20457 Hamburg'), findsOneWidget);
      expect(find.text('Germany'), findsNothing);
      expect(find.text('Created'), findsNothing);
      expect(find.text('Modified'), findsNothing);
      expect(find.text('Customer content'), findsOneWidget);

      final urls = tester.widgetList<SsLink>(find.byType(SsLink)).map((link) {
        return link.uri.toString();
      }).toList();

      expect(urls, [
        'https://www.google.com/maps/search/Pier%207%2C%2020457%20Hamburg',
        'mailto:office@example.org',
        'tel:+49%2040%20123',
      ]);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('customer page title follows canonical nonempty name behavior', (
    tester,
  ) async {
    await _pump(tester, _customer());
    final titles = find.descendant(
      of: find.byType(CustomerDetailLayout),
      matching: find.byType(Title),
    );

    expect(tester.widget<Title>(titles).title, 'Firma Hafenbau');

    await _pump(
      tester,
      models.Customer(
        id: 'empty-name',
        name: '',
        phoneNumbers: const [],
        emailAddresses: const [],
        createdAt: DateTime.utc(2026, 1, 1),
        modifiedAt: DateTime.utc(2026, 1, 1),
      ),
    );
    expect(titles, findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('absent optional values produce no placeholder attributes', (
    tester,
  ) async {
    await _pump(tester, _customer(minimal: true));

    expect(find.byType(SsAttribute), findsOneWidget);
    expect(find.byType(SsLink), findsNothing);
    expect(find.text('Hafenbau'), findsNWidgets(2));
    expect(tester.takeException(), isNull);
  });

  testWidgets('channel label fallback preserves an explicitly empty name', (
    tester,
  ) async {
    await _pump(tester, _customer());
    final attributes = tester.widgetList<SsAttribute>(find.byType(SsAttribute));
    final labels = attributes.map((attribute) {
      return attribute.label;
    }).toList();

    expect(labels, ['Salutation', 'Name', 'Address', '', 'Phone 1']);
    expect(tester.takeException(), isNull);
  });

  testWidgets('active detail layout scrolls at 320px with doubled text', (
    tester,
  ) async {
    await _pump(tester, _customer(), width: 320, scale: 2);
    expect(tester.takeException(), isNull);

    await tester.scrollUntilVisible(
      find.text('Customer content'),
      200,
      scrollable: find.byType(Scrollable).first,
    );
    await tester.pumpAndSettle();

    final content = tester.getRect(find.text('Customer content'));
    expect(content.top, greaterThanOrEqualTo(0));
    expect(content.bottom, lessThanOrEqualTo(800));
    expect(find.byType(SsAttribute), findsNWidgets(5));
    expect(tester.takeException(), isNull);
  });
}

models.Customer _customer({bool minimal = false}) {
  return models.Customer(
    id: '7',
    salutation: minimal ? '' : 'Firma',
    name: 'Hafenbau',
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
              email: 'office@example.org',
            ),
          ],
    createdAt: DateTime.utc(2026, 10, 12),
    modifiedAt: DateTime.utc(2026, 10, 12),
  );
}

Future<void> _pump(
  WidgetTester tester,
  models.Customer customer, {
  double width = 1200,
  double scale = 1,
}) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = Size(width, 800);
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);

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
      home: Scaffold(
        body: CustomerDetailLayout(
          customer: customer,
          child: const Text('Customer content'),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}
