import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/api/model.dart';
import 'package:sortsys_client/features/customers/customer_list_screen.dart';
import 'package:sortsys_client/features/customers/customer_list_state.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

void main() {
  test(
    'customer URL sorting cycles without losing page or unrelated values',
    () {
      final original = Uri(
        path: '/customers',
        queryParameters: {
          'keep': ['first', 'second'],
          'pageCustomers': ['2'],
          'pageSizeCustomers': ['50'],
          'sortCustomers': [
            jsonEncode([1, 'ASC']),
          ],
        },
        fragment: 'details',
      );
      final state = CustomerListState.fromUri(original);

      expect(state.page, 2);
      expect(state.pageSize, 50);
      expect(state.sortColumn, CustomerSortColumn.name);
      expect(state.descending, isFalse);

      final descending = state.apply(
        original,
        toggleColumn: CustomerSortColumn.name,
      );
      final descendingState = CustomerListState.fromUri(descending);
      final cleared = descendingState.apply(
        descending,
        toggleColumn: CustomerSortColumn.name,
      );
      final clearedState = CustomerListState.fromUri(cleared);
      final email = clearedState.apply(
        cleared,
        toggleColumn: CustomerSortColumn.email,
      );

      expect(descendingState.descending, isTrue);
      expect(clearedState.sortColumn, isNull);
      expect(cleared.queryParameters.containsKey('sortCustomers'), isFalse);
      expect(
        CustomerListState.fromUri(email).sortColumn,
        CustomerSortColumn.email,
      );
      expect(email.queryParametersAll['keep'], ['first', 'second']);
      expect(email.fragment, 'details');
      expect(CustomerListState.fromUri(email).page, 2);
      expect(CustomerListState.fromUri(email).pageSize, 50);
    },
  );

  test('malformed URL state keeps defaults and server order', () {
    for (final raw in [
      'not-json',
      '[5,"ASC"]',
      '[1,"asc"]',
      '["1","ASC"]',
      '[1,"ASC",0]',
      '{"column":1}',
    ]) {
      final state = CustomerListState.fromUri(
        Uri(
          path: '/customers',
          queryParameters: {
            'sortCustomers': raw,
            'pageCustomers': '-4',
            'pageSizeCustomers': '3',
          },
        ),
      );

      expect(state.sortColumn, isNull, reason: raw);
      expect(state.page, 0);
      expect(state.pageSize, 25);
    }

    expect(
      CustomerListState.fromUri(Uri.parse('/customers')).sortColumn,
      isNull,
    );
  });

  test(
    'case-folded sorting is stable, immutable and missing-last both ways',
    () {
      final rows = [
        _customer('missing', 'Missing'),
        _customer('z', 'Zebra', salutation: 'Z'),
        _customer('a', 'Alpha', salutation: 'A'),
        _customer('a2', 'Second alpha', salutation: 'a'),
      ];
      final ascending = sortedCustomers(
        rows,
        const CustomerListState(sortColumn: CustomerSortColumn.salutation),
      );
      final descending = sortedCustomers(
        rows,
        const CustomerListState(
          sortColumn: CustomerSortColumn.salutation,
          descending: true,
        ),
      );

      expect(_ids(ascending), ['a', 'a2', 'z', 'missing']);
      expect(_ids(descending), ['z', 'a', 'a2', 'missing']);
      expect(_ids(rows), ['missing', 'z', 'a', 'a2']);
      expect(
        _ids(sortedCustomers(rows, const CustomerListState())),
        _ids(rows),
      );
      expect(() {
        ascending.add(rows.first);
      }, throwsUnsupportedError);
    },
  );

  test(
    'all five keys use source values and lexical rather than numeric order',
    () {
      final rows = [
        _customer(
          'b',
          'Beta',
          salutation: 'Beta',
          address: const models.ProjectAddress(
            city: 'B',
            streetAddress: 'B Street',
          ),
          phones: const [models.CustomerPhoneNumbersItem(number: '2')],
          emails: const [
            models.CustomerEmailAddressesItem(email: 'b@example.com'),
          ],
        ),
        _customer(
          'a',
          'alpha',
          salutation: 'alpha',
          address: const models.ProjectAddress(
            city: 'A',
            streetAddress: 'A Street',
          ),
          phones: const [models.CustomerPhoneNumbersItem(number: '10')],
          emails: const [
            models.CustomerEmailAddressesItem(email: 'a@example.com'),
          ],
        ),
      ];

      for (final column in CustomerSortColumn.values) {
        expect(
          _ids(sortedCustomers(rows, CustomerListState(sortColumn: column))),
          ['a', 'b'],
          reason: column.name,
        );
        expect(
          _ids(
            sortedCustomers(
              rows,
              CustomerListState(sortColumn: column, descending: true),
            ),
          ),
          ['b', 'a'],
          reason: column.name,
        );
      }

      final channels = _customer(
        'channels',
        'Channels',
        phones: const [
          models.CustomerPhoneNumbersItem(number: '10'),
          models.CustomerPhoneNumbersItem(number: '20'),
        ],
      );

      expect(customerColumnText(channels, CustomerSortColumn.phone), '10\n20');
      expect(
        customerColumnText(
          channels,
          CustomerSortColumn.phone,
          channelSeparator: ' ',
        ),
        '10 20',
      );
    },
  );

  test('customer name and postal address preserve canonical display', () {
    const address = models.ProjectAddress(
      city: 'Berlin',
      streetAddress: 'Road 1',
      zip: RpcOptional.value('12345'),
      country: RpcOptional.value('DE'),
    );

    expect(customerName(_customer('a', 'Alpha', salutation: 'Dr')), 'Dr Alpha');
    expect(customerName(_customer('a', 'Alpha', salutation: '')), 'Alpha');
    expect(customerName(_customer('a', 'Alpha')), 'Alpha');
    expect(customerAddress(address), 'Road 1, 12345 Berlin');
    expect(customerAddress(null), '');
  });

  testWidgets('desktop headers sort via click Enter Space and rows select', (
    tester,
  ) async {
    var uri = Uri.parse('/customers?keep=first&keep=second');
    final selected = <String>[];
    final rows = [_customer('z', 'Zebra'), _customer('a', 'Alpha')];

    await _pump(
      tester,
      StatefulBuilder(
        builder: (context, setState) {
          return CustomerListRows(
            rows: rows,
            state: CustomerListState.fromUri(uri),
            uri: uri,
            shrinkWrap: true,
            onStateChanged: (next) {
              setState(() {
                uri = next;
              });
            },
            onSelected: (customer) {
              selected.add(customer.id);
            },
          );
        },
      ),
    );

    expect(find.byType(SsTableSortHeader), findsNWidgets(5));
    expect(find.byType(SsPagination), findsOneWidget);
    await tester.tap(find.text('Name'));
    await tester.pumpAndSettle();
    expect(
      tester.getTopLeft(find.text('Alpha')).dy,
      lessThan(tester.getTopLeft(find.text('Zebra')).dy),
    );

    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    expect(CustomerListState.fromUri(uri).descending, isTrue);
    await tester.sendKeyEvent(LogicalKeyboardKey.space);
    await tester.pumpAndSettle();
    expect(CustomerListState.fromUri(uri).sortColumn, isNull);
    expect(
      tester.getTopLeft(find.text('Zebra')).dy,
      lessThan(tester.getTopLeft(find.text('Alpha')).dy),
    );
    expect(uri.queryParametersAll['keep'], ['first', 'second']);

    await tester.tap(find.text('Zebra'));
    await tester.pump();
    expect(selected, ['z']);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    '320px doubled cards retain actual title map mail and phone links',
    (tester) async {
      final row = _customer(
        'customer/a',
        'Alpha',
        salutation: 'Dr',
        address: const models.ProjectAddress(
          city: 'Berlin',
          streetAddress: 'Road 1',
          zip: RpcOptional.value('12345'),
        ),
        emails: const [
          models.CustomerEmailAddressesItem(email: 'a@example.com'),
        ],
        phones: const [models.CustomerPhoneNumbersItem(number: '+491234')],
      );
      String? selected;

      await _pump(
        tester,
        CustomerListLayout(
          rows: CustomerListRows(
            rows: [row],
            state: const CustomerListState(),
            uri: Uri.parse('/customers'),
            shrinkWrap: true,
            onStateChanged: (uri) {},
            onSelected: (customer) {
              selected = customer.id;
            },
          ),
        ),
        width: 320,
        scale: 2,
      );
      final targets = tester.widgetList<SsLink>(find.byType(SsLink)).map((
        link,
      ) {
        return link.uri;
      }).toList();

      expect(find.byType(CustomerTile), findsOneWidget);
      expect(find.byType(SsAttribute), findsNWidgets(3));
      expect(targets, contains(Uri.parse('/customers/customer%2Fa')));
      expect(targets, contains(Uri(scheme: 'mailto', path: 'a@example.com')));
      expect(targets, contains(Uri(scheme: 'tel', path: '+491234')));
      expect(
        targets,
        contains(
          Uri.parse(
            'https://www.google.com/maps/search/Road%201%2C%2012345%20Berlin',
          ),
        ),
      );
      await tester.tap(find.text('Dr Alpha'));
      await tester.pump();
      expect(selected, 'customer/a');
      await tester.ensureVisible(find.text('+491234'));
      await tester.pumpAndSettle();
      final scrollPosition = Scrollable.of(
        tester.element(find.text('+491234')),
      ).position;

      expect(scrollPosition.pixels, greaterThan(0));
      expect(
        tester.getBottomLeft(find.text('+491234')).dy,
        lessThanOrEqualTo(800),
      );
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('empty and error states retain five headers without pagination', (
    tester,
  ) async {
    var retries = 0;

    Widget rows({Object? error}) {
      return CustomerListRows(
        rows: const [],
        state: const CustomerListState(),
        uri: Uri.parse('/customers'),
        shrinkWrap: true,
        error: error,
        onStateChanged: (uri) {},
        onSelected: (customer) {},
        onRetry: () {
          retries++;
        },
      );
    }

    await _pump(tester, rows());
    expect(find.byType(SsTableSortHeader), findsNWidgets(5));
    expect(find.byType(SsPagination), findsNothing);
    expect(find.text('No entries available.'), findsOneWidget);

    await _pump(tester, rows(error: StateError('Unavailable')));
    expect(find.byType(SsTableSortHeader), findsNWidgets(5));
    expect(find.byType(SsPagination), findsNothing);
    expect(find.text('Entries could not be loaded.'), findsOneWidget);
    await tester.tap(find.text('Reload'));
    await tester.pump();
    expect(retries, 1);
    expect(tester.takeException(), isNull);
  });

  testWidgets('bounded compact rows scroll on Space without following a link', (
    tester,
  ) async {
    final rows = [
      for (var index = 0; index < 25; index++)
        _customer('$index', 'Customer $index'),
    ];
    var selected = 0;

    await _pump(
      tester,
      CustomerListRows(
        rows: rows,
        state: const CustomerListState(),
        uri: Uri.parse('/customers'),
        onStateChanged: (uri) {},
        onSelected: (customer) {
          selected++;
        },
      ),
      width: 320,
    );

    await tester.tap(find.text('Customer 0'));
    await tester.sendKeyEvent(LogicalKeyboardKey.space);
    await tester.pumpAndSettle();
    final position = Scrollable.of(
      tester.element(find.text('Customer 0')),
    ).position;

    expect(position.pixels, greaterThan(0));
    expect(selected, 1);
    await tester.ensureVisible(find.text('Customer 24'));
    await tester.pumpAndSettle();
    expect(tester.getTopLeft(find.text('Customer 24')).dy, lessThan(800));
    expect(tester.takeException(), isNull);
  });
}

models.Customer _customer(
  String id,
  String name, {
  String? salutation,
  models.ProjectAddress? address,
  List<models.CustomerPhoneNumbersItem> phones = const [],
  List<models.CustomerEmailAddressesItem> emails = const [],
}) {
  return models.Customer(
    id: id,
    name: name,
    salutation: salutation,
    address: address,
    phoneNumbers: phones,
    emailAddresses: emails,
    createdAt: DateTime.utc(2026, 10, 12),
    modifiedAt: DateTime.utc(2026, 10, 12),
  );
}

List<String> _ids(List<models.Customer> rows) {
  return rows.map((row) {
    return row.id;
  }).toList();
}

Future<void> _pump(
  WidgetTester tester,
  Widget body, {
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
      home: Scaffold(body: body),
    ),
  );
  await tester.pumpAndSettle();
}
