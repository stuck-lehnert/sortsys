import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/api/model.dart';
import 'package:sortsys_client/features/contacts/contact_list_screen.dart';
import 'package:sortsys_client/features/contacts/contact_list_state.dart';
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

  test(
    'Contacts URL validates sort, cycles and preserves unrelated values',
    () {
      final uri = Uri.parse(
        '/contacts?pageContacts=2&pageContacts=9&pageSizeContacts=50'
        '&keep=one&keep=two#part',
      );
      final state = ContactListState.fromUri(uri);
      final first = state.apply(uri, toggleColumn: ContactSortColumn.lastName);
      final second = ContactListState.fromUri(first)
          .apply(first, toggleColumn: ContactSortColumn.lastName);
      final third = ContactListState.fromUri(second)
          .apply(second, toggleColumn: ContactSortColumn.lastName);

      expect(state.page, 2);
      expect(state.pageSize, 50);
      expect(first.queryParameters['sortContacts'], '[2,"ASC"]');
      expect(second.queryParameters['sortContacts'], '[2,"DESC"]');
      expect(third.queryParameters.containsKey('sortContacts'), isFalse);
      expect(third.queryParametersAll['keep'], ['one', 'two']);
      expect(third.fragment, 'part');

      for (final value in [
        'broken',
        '[4,"ASC"]',
        '[0,"asc"]',
        '[true,"ASC"]',
      ]) {
        final invalid = ContactListState.fromUri(
          Uri(
            path: '/contacts',
            queryParameters: {
              'sortContacts': value,
              'pageContacts': '-1',
              'pageSizeContacts': '99',
            },
          ),
        );

        expect(invalid.column, isNull);
        expect(invalid.page, 0);
        expect(invalid.pageSize, 25);
      }
    },
  );

  test(
    'contact sorting is stable, case insensitive, empty-last and immutable',
    () {
      final first = _contact('first', lastName: 'Harbor');
      final tied = _contact('tied', lastName: 'harbor');
      final empty = _contact('empty', lastName: null, full: false);
      final contacts = [first, tied, empty];

      expect(
        sortedContacts(
          contacts,
          const ContactListState(
            column: ContactSortColumn.lastName,
            descending: true,
          ),
        ),
        [first, tied, empty],
      );
      expect(
        contactColumnText(first, ContactSortColumn.address),
        'Pier 7, 20457 Hamburg',
      );
      expect(contactColumnText(empty, ContactSortColumn.address), '');
      expect(sortedContacts(contacts, const ContactListState()), contacts);
      expect(contacts, [first, tied, empty]);
    },
  );

  testWidgets('contact desktop uses canonical columns and original names', (
    tester,
  ) async {
    final contact = _contact('one', lastName: ' Harbor ');
    models.Contact? selected;
    Uri? changed;

    await _pump(
      tester,
      [contact],
      onSelected: (value) {
        selected = value;
      },
      onChanged: (value) {
        changed = value;
      },
    );

    final table = tester.widget<SsDataTable<models.Contact>>(
      find.byType(SsDataTable<models.Contact>),
    );

    expect(table.columns.map((column) => column.label), [
      'Salutation',
      'First name',
      'Last name',
      'Address',
    ]);
    expect(find.text(' Harbor '), findsOneWidget);
    table.onSelected!(contact);

    expect(selected, same(contact));
    await tester.tap(find.text('Last name'));
    await tester.pumpAndSettle();

    expect(changed?.queryParameters['sortContacts'], '[2,"ASC"]');
    expect(changed?.queryParametersAll['keep'], ['one', 'two']);
    expect(tester.takeException(), isNull);
  });

  testWidgets('contact top pagination clamps and resets page on size change', (
    tester,
  ) async {
    final contacts = List.generate(60, (index) {
      return _contact('$index', full: false);
    });
    Uri? changed;

    await _pump(
      tester,
      contacts,
      state: const ContactListState(page: 99),
      onChanged: (value) {
        changed = value;
      },
    );

    final pagination = tester.widget<SsPagination>(find.byType(SsPagination));
    final table = tester.widget<SsDataTable<models.Contact>>(
      find.byType(SsDataTable<models.Contact>),
    );

    expect(pagination.page, 3);
    expect(pagination.pageSizes, [25, 50, 100]);
    expect(table.rows, hasLength(10));
    pagination.onPageSize(50);

    expect(changed?.queryParameters.containsKey('pageContacts'), isFalse);
    expect(changed?.queryParameters['pageSizeContacts'], '50');
    expect(changed?.fragment, 'part');
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'contact cards retain genuine links and static channel fallbacks',
    (tester) async {
      await _pump(tester, [_contact(' A&/B ')], width: 800);

      final link = tester.widget<SsLink>(
        find.byWidgetPredicate((widget) {
          return widget is SsLink &&
              widget.uri.toString() == '/contacts/%20A%26%2FB%20';
        }),
      );
      final external = tester.widgetList<EntityExternalLink>(
        find.byType(EntityExternalLink),
      );
      final labels = tester
          .widgetList<SsAttribute>(find.byType(SsAttribute))
          .map((attribute) => attribute.label);

      expect(link.uri.toString(), '/contacts/%20A%26%2FB%20');
      expect(labels, ['Anschrift', '', 'Telefon 1']);
      expect(external.map((item) => item.uri.scheme), [
        'https',
        'mailto',
        'tel',
      ]);
      expect(
        external.map((item) => item.uri.toString()),
        contains('mailto:ada@example.org'),
      );
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('contact cards scroll at 320px with doubled actual-font text', (
    tester,
  ) async {
    final contacts = List.generate(25, (index) {
      return _contact('$index');
    });

    await _pump(tester, contacts, width: 320, scale: 2);

    final scroll = tester.state<ScrollableState>(
      find.descendant(
        of: find.byType(ListView),
        matching: find.byType(Scrollable),
      ),
    );

    expect(scroll.position.maxScrollExtent, greaterThan(0));
    expect(tester.takeException(), isNull);
    await tester.drag(find.byType(ListView), const Offset(0, -500));
    await tester.pumpAndSettle();

    expect(scroll.position.pixels, greaterThan(0));
    expect(tester.takeException(), isNull);
  });
}

Future<void> _pump(
  WidgetTester tester,
  List<models.Contact> contacts, {
  double width = 1200,
  double scale = 1,
  ContactListState state = const ContactListState(),
  ValueChanged<models.Contact>? onSelected,
  ValueChanged<Uri>? onChanged,
}) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = Size(width, 900);
  addTearDown(tester.view.resetDevicePixelRatio);
  addTearDown(tester.view.resetPhysicalSize);

  await tester.pumpWidget(
    MaterialApp(
      locale: const Locale('en'),
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
      home: Scaffold(
        body: ContactListRows(
          rows: contacts,
          state: state,
          uri: Uri.parse('/contacts?keep=one&keep=two#part'),
          onStateChanged: onChanged ?? (value) {},
          onSelected: onSelected ?? (value) {},
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

models.Contact _contact(
  String id, {
  String? lastName = 'Harbor',
  bool full = true,
}) {
  return models.Contact(
    id: id,
    salutation: full ? 'Dr.' : null,
    firstName: full ? 'Ada' : null,
    lastName: lastName,
    address: full
        ? const models.ProjectAddress(
            streetAddress: 'Pier 7',
            zip: RpcOptional.value('20457'),
            city: 'Hamburg',
          )
        : null,
    phoneNumbers: full
        ? const [models.CustomerPhoneNumbersItem(number: '+49 40 123')]
        : const [],
    emailAddresses: full
        ? const [
            models.CustomerEmailAddressesItem(
              email: 'ada@example.org',
              name: RpcOptional.value(''),
            ),
          ]
        : const [],
    createdAt: DateTime.utc(2026, 1, 1),
    modifiedAt: DateTime.utc(2026, 1, 1),
  );
}
