import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/api/model.dart';
import 'package:sortsys_client/features/customers/customer_draft.dart';
import 'package:sortsys_client/features/customers/customer_form_fields.dart';
import 'package:sortsys_client/features/customers/customer_write.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

void main() {
  test('customer names use trimmed UTF-8 byte limits without truncation', () {
    expect(CustomerDraft(name: '  Hafen  ').createInput().name, 'Hafen');
    expect(CustomerDraft(name: 'ä' * 63).createInput().name, 'ä' * 63);
    expect(() {
      CustomerDraft(name: 'ä' * 64).createInput();
    }, throwsFormatException);
    expect(() {
      CustomerDraft(name: '  ').createInput();
    }, throwsFormatException);
  });

  test('draft normalizes channels and emits changed fields only', () {
    final baseline = _row(
      address: const models.ProjectAddress(
        streetAddress: 'Pier 7',
        city: 'Hamburg',
      ),
    );
    final draft = CustomerDraft(
      name: ' Hafenbau ',
      salutation: '  ',
      phoneNumbers: const [
        models.CustomerPhoneNumbersItem(
          number: ' +49 40 ',
          name: RpcOptional.value(' Office '),
        ),
        models.CustomerPhoneNumbersItem(number: ' '),
      ],
      emailAddresses: const [
        models.CustomerEmailAddressesItem(
          email: ' office@example.org ',
          name: RpcOptional.value(' '),
        ),
      ],
      contactIds: ['c1', 'c1'],
    );
    final update = draft.updateInput(baseline).data.toWire();

    expect(update.containsKey('name'), isFalse);
    expect(update.containsKey('salutation'), isFalse);
    expect(update['address'], isNull);
    expect(update['phoneNumbers'], [
      {'name': 'Office', 'number': '+49 40'},
    ]);
    expect(update['emailAddresses'], [
      {'name': null, 'email': 'office@example.org'},
    ]);
    expect(draft.contactIds, ['c1']);
    expect(() {
      draft.contactIds!.add('c2');
    }, throwsUnsupportedError);
  });

  test('coordinator requires its own authorized loaded baseline', () async {
    final fixture = _Fixture();

    await expectLater(
      fixture.writer.save(CustomerDraft(name: 'New')),
      throwsStateError,
    );
    expect(fixture.access.mutations, isEmpty);
    expect(fixture.store.writes, 0);
  });

  test(
    'creation journals before each separate base and contact dispatch',
    () async {
      final fixture = _Fixture();
      await fixture.writer.load(null);
      final id = await fixture.writer.save(
        CustomerDraft(name: 'Created', contactIds: ['c1']),
      );

      expect(id, 'new-1');
      expect(fixture.access.mutations, ['create', 'contacts']);
      expect(fixture.access.journalStages, [
        CustomerWriteStage.basePending,
        CustomerWriteStage.contactsPending,
      ]);
      expect(fixture.access.validated, ['c1']);
      expect(fixture.store.receipt, isNull);
      expect(fixture.access.customer.name, 'Created');
      expect(fixture.access.contacts.single.id, 'c1');
    },
  );

  test('unchanged customer does not dispatch or persist a receipt', () async {
    final fixture = _Fixture();
    await fixture.writer.load('existing');
    final id = await fixture.writer.save(
      CustomerDraft(name: 'Hafenbau', contactIds: []),
    );

    expect(id, 'existing');
    expect(fixture.access.mutations, isEmpty);
    expect(fixture.store.writes, 0);
  });

  test(
    'missing contact visibility preserves relationships and hides selection',
    () async {
      final fixture = _Fixture();
      fixture.access.canSelectContacts = false;
      fixture.access.contacts = [_contact('c1')];
      final seed = await fixture.writer.load('existing');
      final values = CustomerFormValues(seed);
      addTearDown(values.dispose);
      values.name.text = 'Updated';

      expect(seed.contacts, isNull);
      expect(values.draft().contactIds, isNull);
      await fixture.writer.save(values.draft());

      expect(fixture.access.mutations, ['update']);
      expect(fixture.access.contacts.single.id, 'c1');
      expect(fixture.access.contactReads, 0);
      expect(fixture.store.receipt, isNull);
    },
  );

  test(
    'forged contact selection without authorized baseline is rejected',
    () async {
      final fixture = _Fixture();
      fixture.access.canSelectContacts = false;
      await fixture.writer.load('existing');

      await expectLater(
        fixture.writer.save(CustomerDraft(name: 'Changed', contactIds: [])),
        throwsStateError,
      );
      expect(fixture.access.mutations, isEmpty);
      expect(fixture.store.writes, 0);
    },
  );

  test('fresh customer conflict rejects all writes', () async {
    final fixture = _Fixture();
    await fixture.writer.load('existing');
    fixture.access.customer = _row(name: 'Changed elsewhere');

    await expectLater(
      fixture.writer.save(CustomerDraft(name: 'Mine', contactIds: [])),
      _failure(CustomerWriteFailure.conflict),
    );
    expect(fixture.access.mutations, isEmpty);
    expect(fixture.store.writes, 0);
  });

  test('fresh relationship conflict rejects base and contact writes', () async {
    final fixture = _Fixture();
    await fixture.writer.load('existing');
    fixture.access.contacts = [_contact('other')];

    await expectLater(
      fixture.writer.save(CustomerDraft(name: 'Mine', contactIds: ['c1'])),
      _failure(CustomerWriteFailure.conflict),
    );
    expect(fixture.access.mutations, isEmpty);
    expect(fixture.store.writes, 0);
  });

  test(
    'unacknowledged creation cannot infer an ID or replay on recovery',
    () async {
      final fixture = _Fixture();
      await fixture.writer.load(null);
      fixture.access.loseBaseAcknowledgement = true;

      await expectLater(
        fixture.writer.save(CustomerDraft(name: 'Created', contactIds: [])),
        _failure(CustomerWriteFailure.uncertain),
      );
      final receipt = fixture.store.receipt!;
      expect(receipt.customerId, isNull);

      await expectLater(
        fixture.writer.recover(receipt),
        _failure(CustomerWriteFailure.uncertain),
      );
      expect(fixture.access.mutations, ['create']);
      expect(fixture.store.receipt, isNotNull);
    },
  );

  test(
    'lost contact acknowledgement recovers by reads without replay',
    () async {
      final fixture = _Fixture();
      await fixture.writer.load('existing');
      fixture.access.loseContactAcknowledgement = true;

      await expectLater(
        fixture.writer.save(CustomerDraft(name: 'Updated', contactIds: ['c1'])),
        _failure(CustomerWriteFailure.uncertain),
      );
      final receipt = fixture.store.receipt!;
      final decoded = CustomerWriteReceipt.decode(receipt.encode());
      final id = await fixture.writer.recover(decoded);

      expect(id, 'existing');
      expect(decoded.stage, CustomerWriteStage.contactsPending);
      expect(fixture.access.mutations, ['update', 'contacts']);
      expect(fixture.store.receipt, isNull);
    },
  );

  test(
    'partial base success never dispatches pending contacts during recovery',
    () async {
      final fixture = _Fixture();
      await fixture.writer.load('existing');
      fixture.store.failWriteAt = 3;

      await expectLater(
        fixture.writer.save(CustomerDraft(name: 'Updated', contactIds: ['c1'])),
        _failure(CustomerWriteFailure.uncertain),
      );
      final receipt = fixture.store.receipt!;

      await expectLater(
        fixture.writer.recover(receipt),
        _failure(CustomerWriteFailure.uncertain),
      );
      expect(fixture.access.mutations, ['update']);
      expect(fixture.store.receipt, isNotNull);
    },
  );

  test(
    'failed intent persistence and changed scope prevent dispatch',
    () async {
      final fixture = _Fixture();
      await fixture.writer.load('existing');
      fixture.store.failWriteAt = 1;

      await expectLater(
        fixture.writer.save(CustomerDraft(name: 'Updated', contactIds: [])),
        throwsStateError,
      );
      expect(fixture.access.mutations, isEmpty);

      fixture.store.failWriteAt = null;
      fixture.store.afterWrite = () {
        fixture.access.current = false;
      };
      await expectLater(
        fixture.writer.save(CustomerDraft(name: 'Updated', contactIds: [])),
        _failure(CustomerWriteFailure.uncertain),
      );
      expect(fixture.access.mutations, isEmpty);
    },
  );

  testWidgets(
    'customer form retains address toggle and dynamic channels at 320px',
    (tester) async {
      final fixture = _Fixture();
      final values = CustomerFormValues(await fixture.writer.load(null));
      addTearDown(values.dispose);
      final form = GlobalKey<FormState>();
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(320, 800);
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
                    .copyWith(textScaler: const TextScaler.linear(2)),
                child: child!,
              ),
            );
          },
          home: Scaffold(
            body: SingleChildScrollView(
              child: Form(
                key: form,
                child: CustomerFormFields(
                  values: values,
                  queryIdentity: 'test-account',
                  loadContacts: (query) async {
                    return [];
                  },
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(form.currentState!.validate(), isFalse);
      values.name.text = 'Hafen';
      await tester.tap(find.text('Add address'));
      await tester.pumpAndSettle();
      expect(find.text('Street and number'), findsOneWidget);
      expect(form.currentState!.validate(), isFalse);
      values.street.text = 'Pier 7';
      values.city.text = 'Hamburg';

      await tester.ensureVisible(find.text('Email'));
      await tester.tap(find.text('Email'));
      await tester.pumpAndSettle();
      expect(values.channels, hasLength(1));
      expect(values.channels.single.nameFocus.hasFocus, isTrue);
      expect(form.currentState!.validate(), isFalse);
      values.channels.single.value.text = ' office@example.org ';
      expect(form.currentState!.validate(), isTrue);
      expect(values.draft().emailAddresses.single.email, 'office@example.org');

      await tester.ensureVisible(find.byTooltip('Remove entry'));
      await tester.tap(find.byTooltip('Remove entry'));
      await tester.pumpAndSettle();
      expect(values.channels, isEmpty);
      expect(values.draft().emailAddresses, isEmpty);
      expect(tester.takeException(), isNull);
    },
  );
}

Matcher _failure(CustomerWriteFailure failure) {
  return throwsA(
    isA<CustomerWriteException>().having(
      (error) {
        return error.failure;
      },
      'failure',
      failure,
    ),
  );
}

models.Customer _row({
  String id = 'existing',
  String name = 'Hafenbau',
  models.ProjectAddress? address,
}) {
  return models.Customer(
    id: id,
    name: name,
    address: address,
    phoneNumbers: const [],
    emailAddresses: const [],
    createdAt: DateTime.utc(2026, 10, 12),
    modifiedAt: DateTime.utc(2026, 10, 12),
  );
}

models.Contact _contact(String id) {
  return models.Contact(
    id: id,
    firstName: 'Contact $id',
    phoneNumbers: const [],
    emailAddresses: const [],
    createdAt: DateTime.utc(2026, 10, 12),
    modifiedAt: DateTime.utc(2026, 10, 12),
  );
}

final class _Fixture {
  _Fixture() {
    access.store = store;
    writer = CustomerWriteCoordinator(
      access: access,
      receipts: store,
      lock: (scope, operation) {
        return operation();
      },
    );
  }

  final access = _Access();
  final store = _Receipts();
  late final CustomerWriteCoordinator writer;
}

final class _Receipts implements CustomerReceiptStore {
  CustomerWriteReceipt? receipt;
  int writes = 0;
  int? failWriteAt;
  VoidCallback? afterWrite;

  @override
  Future<CustomerWriteReceipt?> read(String scope) async {
    return receipt;
  }

  @override
  Future<void> write(CustomerWriteReceipt value) async {
    writes++;

    if (writes == failWriteAt) {
      throw StateError('TEST_STORAGE_FAILURE');
    }

    receipt = CustomerWriteReceipt.decode(value.encode());
    afterWrite?.call();
  }

  @override
  Future<void> clear(String scope) async {
    receipt = null;
  }
}

final class _Access implements CustomerWriteAccess {
  @override
  final scope = 'test-instance/tenant/user';
  @override
  bool canSelectContacts = true;
  bool current = true;
  bool loseBaseAcknowledgement = false;
  bool loseContactAcknowledgement = false;
  models.Customer customer = _row();
  List<models.Contact> contacts = [];
  final mutations = <String>[];
  final journalStages = <CustomerWriteStage>[];
  final validated = <String>[];
  int contactReads = 0;
  late _Receipts store;

  @override
  void checkCurrent() {
    if (!current) {
      throw StateError('TEST_SCOPE_CHANGED');
    }
  }

  @override
  Future<void> validateContactIds(List<String> ids) async {
    validated.addAll(ids);
  }

  @override
  Future<models.Customer> getCustomer(String id) async {
    return customer;
  }

  @override
  Future<List<models.Contact>> getContacts(String id) async {
    contactReads++;

    return List.of(contacts);
  }

  void _dispatched(String name) {
    expect(store.receipt, isNotNull);
    mutations.add(name);
    journalStages.add(store.receipt!.stage);
  }

  @override
  Future<String> createCustomer(models.CustomersCreateInput input) async {
    _dispatched('create');
    customer = models.Customer.fromWire({
      ..._row(id: 'new-1').toWire(),
      ...input.toWire(),
    });

    if (loseBaseAcknowledgement) {
      throw StateError('TEST_ACK_LOST');
    }

    return customer.id;
  }

  @override
  Future<void> updateCustomer(models.CustomersUpdateInput input) async {
    _dispatched('update');
    customer = models.Customer.fromWire({
      ...customer.toWire(),
      ...input.data.toWire(),
    });

    if (loseBaseAcknowledgement) {
      throw StateError('TEST_ACK_LOST');
    }
  }

  @override
  Future<void> setContacts(models.CustomersContactsSetInput input) async {
    _dispatched('contacts');
    contacts = input.contactIds.map(_contact).toList();

    if (loseContactAcknowledgement) {
      throw StateError('TEST_CONTACT_ACK_LOST');
    }
  }
}
