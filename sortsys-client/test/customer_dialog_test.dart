import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/features/contacts/contact_dialog.dart';
import 'package:sortsys_client/features/contacts/contact_receipt.dart';
import 'package:sortsys_client/features/contacts/contact_write_access.dart';
import 'package:sortsys_client/features/contacts/contact_write_coordinator.dart';
import 'package:sortsys_client/features/customers/customer_dialog.dart';
import 'package:sortsys_client/features/customers/customer_draft.dart';
import 'package:sortsys_client/features/customers/customer_write.dart';
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

  test('customer cleanup faults preserve the verified ID before and after deletion', () async {
    for (final afterDelete in [false, true]) {
      final fixture = _Fixture();
      fixture.store.failClear = true;
      fixture.store.failAfterClear = afterDelete;

      await fixture.writer.load(null);

      await expectLater(
        fixture.writer.save(CustomerDraft(name: 'Created', contactIds: [])),
        throwsA(
          isA<CustomerWriteException>()
              .having(
                (error) {
                  return error.failure;
                },
                'failure',
                CustomerWriteFailure.cleanup,
              )
              .having(
                (error) {
                  return error.confirmedCustomerId;
                },
                'confirmed ID',
                'created',
              ),
        ),
      );

      expect(fixture.access.mutations, ['create']);
      expect(fixture.store.receipt == null, afterDelete);

      if (!afterDelete) {
        fixture.store.failClear = false;

        final id = await fixture.writer.recover(fixture.store.receipt!);

        expect(id, 'created');
        expect(fixture.access.mutations, ['create']);
      }
    }
  });

  testWidgets(
    'customer create retains raw query and waits for verified readback',
    (tester) async {
      final fixture = _Fixture();
      final release = Completer<void>();
      fixture.access.holdReadback = release;
      addTearDown(() {
        if (!release.isCompleted) {
          release.complete();
        }
      });

      await _pump(tester, fixture, query: '  Created  ');

      expect(
        tester.widget<SsTextField>(_field('Name')).controller!.text,
        '  Created  ',
      );

      await tester.tap(find.text('Create'));
      await tester.pump();
      await fixture.access.readbackEntered.future;

      expect(fixture.saved, isEmpty);
      expect(fixture.access.mutations, ['create']);
      expect(
        tester
            .widget<SsButton>(find.widgetWithText(SsButton, 'Cancel'))
            .onPressed,
        isNull,
      );

      release.complete();
      await tester.pumpAndSettle();

      expect(fixture.saved, ['created']);
      expect(fixture.access.customer.name, 'Created');
      expect(fixture.store.receipt, isNull);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('customer edit submits explicit null and only changed fields', (
    tester,
  ) async {
    final fixture = _Fixture();
    fixture.access.customer = _row(salutation: 'Mx');

    await _pump(tester, fixture, edit: true);
    await _enter(tester, 'Salutation', '  ');
    await _enter(tester, 'Name', ' After ');
    await tester.tap(find.text('Save'));
    await tester.pumpAndSettle();

    expect(fixture.saved, ['existing']);
    expect(fixture.access.lastUpdate!.data.toWire(), {
      'name': 'After',
      'salutation': null,
    });
    expect(fixture.access.mutations, ['update']);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'customer lost create acknowledgement cannot infer ID or repeat',
    (tester) async {
      final fixture = _Fixture();
      fixture.access.loseCreateAck = true;

      await _pump(tester, fixture, query: 'Created');
      await tester.tap(find.text('Create'));
      await tester.pumpAndSettle();

      expect(fixture.saved, isEmpty);
      expect(fixture.access.mutations, ['create']);
      expect(fixture.store.receipt!.customerId, isNull);
      expect(find.byType(SsTextField), findsNothing);
      expect(find.text('Verify with read-only request'), findsNothing);
      expect(
        tester
            .widget<SsButton>(find.widgetWithText(SsButton, 'Create'))
            .onPressed,
        isNull,
      );
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('customer relationship recovery is read-only after manage loss', (
    tester,
  ) async {
    final fixture = _Fixture();
    await fixture.writer.load('existing');
    fixture.access.loseContactAck = true;

    await expectLater(
      fixture.writer.save(
        CustomerDraft(name: 'After', contactIds: ['contact']),
      ),
      throwsA(isA<CustomerWriteException>()),
    );
    fixture.restartCoordinator();

    await _pump(tester, fixture, edit: true, enabled: false);

    expect(find.byType(SsTextField), findsNothing);

    await tester.tap(find.text('Verify with read-only request'));
    await tester.pumpAndSettle();

    expect(fixture.saved, ['existing']);
    expect(fixture.access.mutations, ['update', 'contacts']);
    expect(fixture.store.receipt, isNull);
    expect(tester.takeException(), isNull);
  });

  testWidgets('customer verified cleanup failure reports success only once', (
    tester,
  ) async {
    final fixture = _Fixture();
    fixture.store.failClear = true;
    fixture.store.failAfterClear = true;

    await _pump(tester, fixture, query: 'Created');
    await tester.tap(find.text('Create'));
    await tester.pumpAndSettle();

    expect(fixture.saved, ['created']);
    expect(fixture.access.mutations, ['create']);
    expect(
      tester
          .widget<SsButton>(find.widgetWithText(SsButton, 'Create'))
          .onPressed,
      isNull,
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('customer stale owner cannot publish a held readback', (
    tester,
  ) async {
    final fixture = _Fixture();
    final release = Completer<void>();
    fixture.access.holdReadback = release;
    addTearDown(() {
      if (!release.isCompleted) {
        release.complete();
      }
    });

    await _pump(tester, fixture, query: 'Created');
    await tester.tap(find.text('Create'));
    await tester.pump();
    await fixture.access.readbackEntered.future;
    fixture.access.current = false;
    release.complete();
    await tester.pumpAndSettle();

    expect(fixture.saved, isEmpty);
    expect(find.text('No permission'), findsOneWidget);
    expect(fixture.access.mutations, ['create']);
    expect(
      tester
          .widget<SsButton>(find.widgetWithText(SsButton, 'Cancel'))
          .onPressed,
      isNotNull,
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('customer modal creates with doubled Ubuntu German RTL at320px', (
    tester,
  ) async {
    final fixture = _Fixture();
    fixture.access.canSelectContacts = false;

    await _pump(
      tester,
      fixture,
      query: '  Kunde  ',
      german: true,
      narrow: true,
    );
    await tester.ensureVisible(_field('Name'));
    await tester.tap(find.text('Erstellen'));
    await tester.pumpAndSettle();

    expect(fixture.saved, ['created']);
    expect(fixture.access.customer.name, 'Kunde');
    expect(fixture.access.mutations, ['create']);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'nested contact waits for verified readback and preserves customer draft',
    (tester) async {
      final fixture = _Fixture();
      final nested = _ContactFixture();
      final release = Completer<void>();
      fixture.access.contacts = [_contact('contact')];
      nested.access.holdReadback = release;
      addTearDown(() {
        if (!release.isCompleted) {
          release.complete();
        }
      });

      await _pump(tester, fixture, edit: true, nested: nested);
      await _enter(tester, 'Name', '  Updated customer  ');
      await _enter(tester, 'Contacts', 'Grace Hopper');
      await tester.pump(const Duration(milliseconds: 300));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Create contact: Grace Hopper'));
      await tester.pumpAndSettle();

      expect(find.byType(ContactDialog), findsOneWidget);
      expect(
        tester.widget<SsTextField>(_field('First name')).controller!.text,
        'Grace',
      );
      expect(
        tester.widget<SsTextField>(_field('Last name')).controller!.text,
        'Hopper',
      );

      await tester.tap(find.widgetWithText(SsButton, 'Create'));
      await tester.pump();

      expect(nested.access.readbackEntered.isCompleted, isTrue);
      expect(nested.access.creations, 1);
      expect(fixture.access.mutations, isEmpty);
      expect(fixture.saved, isEmpty);
      expect(find.byType(ContactDialog), findsOneWidget);
      expect(
        tester.widget<SsTextField>(_field('Name')).controller!.text,
        '  Updated customer  ',
      );

      release.complete();
      await tester.pumpAndSettle();

      expect(find.byType(ContactDialog), findsNothing);
      expect(find.text('Ada'), findsOneWidget);
      expect(find.text('Grace Hopper'), findsOneWidget);
      expect(nested.store.receipt, isNull);
      expect(fixture.access.mutations, isEmpty);
      expect(
        tester.widget<SsTextField>(_field('Name')).controller!.text,
        '  Updated customer  ',
      );

      await tester.tap(find.widgetWithText(SsButton, 'Save'));
      await tester.pumpAndSettle();

      expect(fixture.saved, ['existing']);
      expect(fixture.access.mutations, ['update', 'contacts']);
      expect(
        fixture.access.contacts.map((contact) {
          return contact.id;
        }),
        ['contact', 'nested-id'],
      );
      expect(nested.access.creations, 1);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'cancelled nested contact restores query and keeps customer selections',
    (tester) async {
      final fixture = _Fixture();
      final nested = _ContactFixture();
      fixture.access.contacts = [_contact('contact')];

      await _pump(tester, fixture, edit: true, nested: nested);
      await _enter(tester, 'Name', '  Unsaved customer  ');
      await _enter(tester, 'Contacts', 'Grace Hopper');
      await tester.pump(const Duration(milliseconds: 300));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Create contact: Grace Hopper'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(SsButton, 'Cancel').last);
      await tester.pumpAndSettle();

      expect(find.byType(ContactDialog), findsNothing);
      expect(
        tester.widget<SsTextField>(_field('Name')).controller!.text,
        '  Unsaved customer  ',
      );
      expect(
        tester.widget<SsTextField>(_field('Contacts')).controller!.text,
        'Grace Hopper',
      );
      expect(find.text('Ada'), findsOneWidget);
      expect(nested.access.creations, 0);
      expect(nested.store.receipt, isNull);
      expect(fixture.access.mutations, isEmpty);
      expect(fixture.saved, isEmpty);
      expect(tester.takeException(), isNull);
    },
  );
}

Finder _field(String label) {
  return find.byWidgetPredicate((widget) {
    return widget is SsTextField && widget.label == label;
  });
}

Future<void> _enter(WidgetTester tester, String label, String value) async {
  final editable = find.descendant(
    of: _field(label),
    matching: find.byType(EditableText),
  );

  await tester.ensureVisible(editable);
  await tester.enterText(editable, value);
  await tester.pump();
}

Future<void> _pump(
  WidgetTester tester,
  _Fixture fixture, {
  String query = '',
  bool edit = false,
  bool enabled = true,
  bool german = false,
  bool narrow = false,
  _ContactFixture? nested,
}) async {
  final width = narrow ? 320.0 : 800.0;

  await tester.pumpWidget(
    MaterialApp(
      locale: Locale(german ? 'de' : 'en'),
      supportedLocales: const [Locale('en'), Locale('de')],
      localizationsDelegates: GlobalMaterialLocalizations.delegates,
      home: SsTheme(
        colors: SsColors.light,
        child: Scaffold(
          body: Align(
            alignment: Alignment.topLeft,
            child: SizedBox(
              width: width,
              height: 560,
              child: MediaQuery(
                data: MediaQueryData(
                  size: Size(width, 560),
                  textScaler: TextScaler.linear(narrow ? 2 : 1),
                ),
                child: Directionality(
                  textDirection: narrow ? TextDirection.rtl : TextDirection.ltr,
                  child: CustomerDialog(
                    customer: edit ? fixture.access.customer : null,
                    initialQuery: query,
                    coordinator: fixture.writer,
                    queryIdentity: 'actor',
                    isCurrent: () {
                      return fixture.access.current;
                    },
                    loadContacts: (query) async {
                      return [_contact('contact')];
                    },
                    createContact: nested == null
                        ? null
                        : (query) {
                            return showContactDialog(
                              tester.element(find.byType(CustomerDialog)),
                              initialQuery: query,
                              coordinator: nested.writer,
                              queryIdentity: 'nested-actor',
                              isCurrent: () {
                                return fixture.access.current;
                              },
                              canSave: () {
                                return fixture.access.current;
                              },
                            );
                          },
                    canCreateContact: () {
                      return nested != null;
                    },
                    enabled: enabled,
                    onSaved: fixture.saved.add,
                    onCancel: () {
                      // The fixture owns the dialog lifetime.
                    },
                  ),
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

models.Customer _row({
  String id = 'existing',
  String name = 'Before',
  String? salutation,
}) {
  return models.Customer(
    id: id,
    name: name,
    salutation: salutation,
    phoneNumbers: const [],
    emailAddresses: const [],
    createdAt: DateTime(2024),
    modifiedAt: DateTime(2024),
  );
}

models.Contact _contact(String id) {
  return models.Contact(
    id: id,
    firstName: 'Ada',
    phoneNumbers: const [],
    emailAddresses: const [],
    createdAt: DateTime(2024),
    modifiedAt: DateTime(2024),
  );
}

final class _Fixture {
  _Fixture() {
    access.store = store;
    restartCoordinator();
  }

  final store = _Store();
  final access = _Access();
  final saved = <String>[];
  late CustomerWriteCoordinator writer;

  void restartCoordinator() {
    writer = CustomerWriteCoordinator(
      access: access,
      receipts: store,
      lock: (scope, operation) {
        return operation();
      },
    );
  }
}

final class _Store implements CustomerReceiptStore {
  CustomerWriteReceipt? receipt;
  bool failClear = false;
  bool failAfterClear = false;

  @override
  Future<CustomerWriteReceipt?> read(String scope) async {
    return receipt == null
        ? null
        : CustomerWriteReceipt.decode(receipt!.encode());
  }

  @override
  Future<void> write(CustomerWriteReceipt value) async {
    receipt = CustomerWriteReceipt.decode(value.encode());
  }

  @override
  Future<void> clear(String scope) async {
    if (!failClear || failAfterClear) {
      receipt = null;
    }

    if (failClear) {
      throw StateError('TEST_CLEAR_FAILURE');
    }
  }
}

final class _Access implements CustomerWriteAccess {
  @override
  final scope = 'actor';
  @override
  bool canSelectContacts = true;
  bool current = true;
  bool loseCreateAck = false;
  bool loseContactAck = false;
  models.Customer customer = _row();
  List<models.Contact> contacts = [];
  models.CustomersUpdateInput? lastUpdate;
  final mutations = <String>[];
  final readbackEntered = Completer<void>();
  Completer<void>? holdReadback;
  late _Store store;

  @override
  void checkCurrent() {
    if (!current) {
      throw StateError('TEST_SCOPE_CHANGED');
    }
  }

  @override
  Future<void> validateContactIds(List<String> ids) async {
    checkCurrent();
  }

  @override
  Future<models.Customer> getCustomer(String id) async {
    if (mutations.isNotEmpty && holdReadback != null) {
      if (!readbackEntered.isCompleted) {
        readbackEntered.complete();
      }

      await holdReadback!.future;
    }

    return customer;
  }

  @override
  Future<List<models.Contact>> getContacts(String id) async {
    return List.of(contacts);
  }

  @override
  Future<String> createCustomer(models.CustomersCreateInput input) async {
    expect(store.receipt?.stage, CustomerWriteStage.basePending);
    mutations.add('create');
    customer = models.Customer.fromWire({
      ..._row(id: 'created').toWire(),
      ...input.toWire(),
    });

    if (loseCreateAck) {
      throw StateError('TEST_ACK_LOST');
    }

    return customer.id;
  }

  @override
  Future<void> updateCustomer(models.CustomersUpdateInput input) async {
    expect(store.receipt?.stage, CustomerWriteStage.basePending);
    mutations.add('update');
    lastUpdate = input;
    customer = models.Customer.fromWire({
      ...customer.toWire(),
      ...input.data.toWire(),
    });
  }

  @override
  Future<void> setContacts(models.CustomersContactsSetInput input) async {
    expect(store.receipt?.stage, CustomerWriteStage.contactsPending);
    mutations.add('contacts');
    contacts = input.contactIds.map(_contact).toList();

    if (loseContactAck) {
      throw StateError('TEST_CONTACT_ACK_LOST');
    }
  }
}

final class _ContactFixture {
  _ContactFixture() {
    writer = ContactWriteCoordinator(access: access, receipts: store);
  }

  final access = _ContactAccess();
  final store = _ContactStore();
  late final ContactWriteCoordinator writer;
}

final class _ContactStore implements ContactReceiptStore {
  ContactWriteReceipt? receipt;

  @override
  Future<ContactWriteReceipt?> read(String scope) async {
    return receipt == null
        ? null
        : ContactWriteReceipt.decode(receipt!.encode());
  }

  @override
  Future<void> write(ContactWriteReceipt value) async {
    receipt = ContactWriteReceipt.decode(value.encode());
  }

  @override
  Future<void> clear(String scope) async {
    receipt = null;
  }
}

final class _ContactAccess implements ContactWriteAccess {
  @override
  final scope = 'nested-actor';
  int creations = 0;
  bool current = true;
  models.Contact? contact;
  Completer<void>? holdReadback;
  final readbackEntered = Completer<void>();

  @override
  void checkCurrent() {
    if (!current) {
      throw StateError('TEST_CONTACT_SCOPE_CHANGED');
    }
  }

  @override
  void checkCreate(models.ContactsCreateInput input) {
    checkCurrent();
  }

  @override
  void checkUpdate(models.ContactsUpdateInput input) {
    throw StateError('UNEXPECTED_CONTACT_UPDATE');
  }

  @override
  Future<models.ContactsCreateOutput> createContact(
    models.ContactsCreateInput input,
  ) async {
    creations++;
    contact = models.Contact.fromWire({
      ..._contact('nested-id').toWire(),
      ...input.toWire(),
    });

    return models.ContactsCreateOutput(id: 'nested-id');
  }

  @override
  Future<models.ContactsUpdateOutput> updateContact(
    models.ContactsUpdateInput input,
  ) {
    throw StateError('UNEXPECTED_CONTACT_UPDATE');
  }

  @override
  Future<models.Contact?> getContact(String id) async {
    if (holdReadback != null) {
      if (!readbackEntered.isCompleted) {
        readbackEntered.complete();
      }

      await holdReadback!.future;
    }

    expect(id, 'nested-id');

    return contact;
  }
}
