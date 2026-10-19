import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/api/model.dart';
import 'package:sortsys_client/features/contacts/contact_draft.dart';
import 'package:sortsys_client/features/contacts/contact_receipt.dart';
import 'package:sortsys_client/features/contacts/contact_write_access.dart';
import 'package:sortsys_client/features/contacts/contact_write_coordinator.dart';
import 'package:sortsys_client/features/contacts/contact_write_inputs.dart';

void main() {
  test(
    'contact save persists every stage before one create and readback',
    () async {
      final fixture = _Fixture();

      final contact = await fixture.coordinator.save(_draft());

      expect(contact.id, 'contact');
      expect(contact.firstName, 'After');
      expect(fixture.access.creates, 1);
      expect(fixture.access.updates, 0);
      expect(fixture.store.events, [
        'read',
        'prepared',
        'dispatching',
        'create',
        'acknowledged',
        'get:contact',
        'clear',
      ]);
      expect(fixture.store.encoded, isNull);
    },
  );

  test(
    'contact edit checks baseline then verifies known changed fields',
    () async {
      final fixture = _Fixture();
      final baseline = fixture.access.contact;

      final contact = await fixture.coordinator.save(
        _draft(update: true),
        baseline: baseline,
      );

      expect(contact.id, baseline.id);
      expect(contact.createdAt, baseline.createdAt);
      expect(contact.firstName, 'After');
      expect(fixture.access.creates, 0);
      expect(fixture.access.updates, 1);
      expect(fixture.access.reads, 2);
      expect(fixture.store.encoded, isNull);
    },
  );

  test(
    'contact dated conflicts and unchanged edits never journal or mutate',
    () async {
      final fixture = _Fixture();
      final baseline = fixture.access.contact;
      fixture.access.contact = _contact(modifiedAt: DateTime.utc(2024, 3));

      await expectLater(
        fixture.coordinator.save(_draft(update: true), baseline: baseline),
        _fails(ContactWriteFailure.conflict),
      );

      fixture.access.contact = baseline;

      final unchanged = await fixture.coordinator.save(
        ContactDraft.fromContact(baseline),
        baseline: baseline,
      );

      expect(unchanged.firstName, 'Before');
      expect(fixture.store.writes, 0);
      expect(fixture.access.creates, 0);
      expect(fixture.access.updates, 0);
    },
  );

  test(
    'contact lost acknowledgements never replay create or known-ID edit',
    () async {
      for (final update in [false, true]) {
        final fixture = _Fixture();
        final baseline = fixture.access.contact;
        fixture.access.loseAcknowledgement = true;

        await expectLater(
          fixture.coordinator.save(
            _draft(update: update),
            baseline: update ? baseline : null,
          ),
          _fails(ContactWriteFailure.uncertain),
        );

        final receipt = (await fixture.coordinator.outstanding())!;

        if (update) {
          fixture.access.manage = false;

          final recovered = await fixture.coordinator.recover(
            expectedNonce: receipt.nonce,
          );

          expect(recovered?.firstName, 'After');
          expect(fixture.access.updates, 1);
          expect(fixture.access.creates, 0);
          expect(fixture.access.reads, 2);
        } else {
          await expectLater(
            fixture.coordinator.recover(expectedNonce: receipt.nonce),
            _fails(ContactWriteFailure.uncertain),
          );
          await expectLater(
            fixture.coordinator.save(_draft()),
            _fails(ContactWriteFailure.outstanding),
          );

          expect(fixture.access.creates, 1);
          expect(fixture.access.reads, 0);
          expect(fixture.store.encoded, isNotNull);
        }
      }
    },
  );

  test(
    'contact storage faults retain unsent or uncertain durable evidence',
    () async {
      for (final failedWrite in [1, 2, 3]) {
        for (final afterWrite in [false, true]) {
          final fixture = _Fixture();
          fixture.store.failWrite = failedWrite;
          fixture.store.failAfterWrite = afterWrite;

          await expectLater(
            fixture.coordinator.save(_draft()),
            failedWrite == 1
                ? throwsStateError
                : _fails(ContactWriteFailure.uncertain),
          );

          expect(fixture.access.creates, failedWrite == 3 ? 1 : 0);
          expect(fixture.access.reads, 0);

          final receipt = await fixture.coordinator.outstanding();

          if (receipt == null) {
            expect(failedWrite, 1);
            expect(afterWrite, isFalse);
            continue;
          }

          if (!receipt.dispatching && !receipt.acknowledged) {
            final recovered = await fixture.coordinator.recover(
              expectedNonce: receipt.nonce,
            );

            expect(recovered, isNull);
            expect(fixture.access.creates, 0);
            expect(fixture.store.encoded, isNull);
          } else if (receipt.acknowledged) {
            final recovered = await fixture.coordinator.recover(
              expectedNonce: receipt.nonce,
            );

            expect(recovered?.id, 'contact');
            expect(fixture.access.creates, 1);
            expect(fixture.access.reads, 1);
          } else {
            await expectLater(
              fixture.coordinator.recover(expectedNonce: receipt.nonce),
              _fails(ContactWriteFailure.uncertain),
            );

            expect(fixture.store.encoded, isNotNull);
            expect(fixture.access.reads, 0);
          }
        }
      }
    },
  );

  test(
    'contact cleanup failures retain verified success without replay',
    () async {
      for (final afterClear in [false, true]) {
        final fixture = _Fixture();
        fixture.store.failClear = true;
        fixture.store.failAfterClear = afterClear;

        await expectLater(
          fixture.coordinator.save(_draft()),
          throwsA(
            isA<ContactWriteException>()
                .having(
                  (error) => error.failure,
                  'failure',
                  ContactWriteFailure.cleanup,
                )
                .having(
                  (error) => error.confirmedContact?.id,
                  'known ID',
                  'contact',
                ),
          ),
        );

        fixture.access.manage = false;
        fixture.store.failClear = false;

        if (!afterClear) {
          final receipt = (await fixture.coordinator.outstanding())!;
          final recovered = await fixture.coordinator.recover(
            expectedNonce: receipt.nonce,
          );

          expect(recovered?.id, 'contact');
        }

        expect(fixture.access.creates, 1);
        expect(fixture.store.encoded, isNull);
      }
    },
  );

  test(
    'contact recovery pins nonce and exact readback after manage loss',
    () async {
      final fixture = _Fixture();
      fixture.access.foreignReadback = true;

      await expectLater(
        fixture.coordinator.save(_draft()),
        _fails(ContactWriteFailure.uncertain),
      );

      final receipt = (await fixture.coordinator.outstanding())!;

      await expectLater(
        fixture.coordinator.recover(expectedNonce: 'other-operation'),
        _fails(ContactWriteFailure.outstanding),
      );

      fixture.access.foreignReadback = false;
      fixture.access.manage = false;

      final recovered = await fixture.coordinator.recover(
        expectedNonce: receipt.nonce,
      );

      expect(recovered?.id, 'contact');
      expect(fixture.access.creates, 1);
      expect(fixture.access.reads, 2);
      expect(fixture.store.encoded, isNull);
    },
  );

  test(
    'contact scope and permission races suppress dispatch or stale success',
    () async {
      for (final changeScope in [false, true]) {
        final fixture = _Fixture();

        if (changeScope) {
          fixture.access.onMutation = () {
            fixture.access.owner = 'other-actor';
          };
        } else {
          fixture.store.onWrite = (count) {
            if (count == 2) {
              fixture.access.manage = false;
            }
          };
        }

        await expectLater(
          fixture.coordinator.save(_draft()),
          _fails(ContactWriteFailure.uncertain),
        );

        expect(fixture.access.creates, changeScope ? 1 : 0);
        expect(fixture.access.reads, 0);
        expect(fixture.store.writes, 2);
        expect(
          ContactWriteReceipt.decode(fixture.store.encoded!).dispatching,
          isTrue,
        );
        expect(fixture.store.events.contains('clear'), isFalse);
      }
    },
  );
}

Matcher _fails(ContactWriteFailure failure) {
  return throwsA(
    isA<ContactWriteException>().having(
      (error) => error.failure,
      'failure',
      failure,
    ),
  );
}

ContactDraft _draft({bool update = false}) {
  return ContactDraft(
    contactId: update ? 'contact' : null,
    firstName: 'After',
    phoneNumbers: const [ContactChannelDraft(value: '+43')],
  );
}

models.Contact _contact({String id = 'contact', DateTime? modifiedAt}) {
  return models.Contact(
    id: id,
    firstName: 'Before',
    phoneNumbers: const [
      models.CustomerPhoneNumbersItem(
        name: RpcOptional.value(null),
        number: '+43',
      ),
    ],
    emailAddresses: [],
    createdAt: DateTime.utc(2024),
    modifiedAt: modifiedAt ?? DateTime.utc(2024, 2),
  );
}

final class _Fixture {
  final store = _Store();
  late final access = _Access(store);
  late final coordinator = ContactWriteCoordinator(
    access: access,
    receipts: store,
  );
}

final class _Store implements ContactReceiptStore {
  final events = <String>[];
  String? encoded;
  int writes = 0;
  int failWrite = 0;
  bool failAfterWrite = false;
  bool failClear = false;
  bool failAfterClear = false;
  void Function(int count)? onWrite;

  @override
  Future<ContactWriteReceipt?> read(String scope) async {
    events.add('read');

    return encoded == null ? null : ContactWriteReceipt.decode(encoded!);
  }

  @override
  Future<void> write(ContactWriteReceipt receipt) async {
    writes++;
    events.add(
      receipt.acknowledged
          ? 'acknowledged'
          : receipt.dispatching
          ? 'dispatching'
          : 'prepared',
    );

    if (writes == failWrite && !failAfterWrite) {
      throw StateError('WRITE_FAILED');
    }

    encoded = receipt.encode();
    onWrite?.call(writes);

    if (writes == failWrite && failAfterWrite) {
      throw StateError('WRITE_FAILED_AFTER_PERSIST');
    }
  }

  @override
  Future<void> clear(String scope) async {
    events.add('clear');

    if (failClear && !failAfterClear) {
      throw StateError('CLEAR_FAILED');
    }

    encoded = null;

    if (failClear && failAfterClear) {
      throw StateError('CLEAR_FAILED_AFTER_DELETE');
    }
  }
}

final class _Access implements ContactWriteAccess {
  _Access(this.store);

  final _Store store;
  String owner = 'scope';
  bool current = true;
  bool manage = true;
  bool loseAcknowledgement = false;
  bool foreignReadback = false;
  int creates = 0;
  int updates = 0;
  int reads = 0;
  models.Contact contact = _contact();
  void Function()? onMutation;

  @override
  String get scope {
    return owner;
  }

  @override
  void checkCurrent() {
    if (!current) {
      throw StateError('STALE_SCOPE');
    }
  }

  void _checkManage() {
    checkCurrent();

    if (!manage) {
      throw StateError('MANAGE_NOT_ALLOWED');
    }
  }

  @override
  void checkCreate(models.ContactsCreateInput input) {
    _checkManage();
    copyContactWriteInput(input);
  }

  @override
  void checkUpdate(models.ContactsUpdateInput input) {
    _checkManage();
    copyContactWriteInput(input.data);
  }

  void _apply(String id, models.ContactsCreateInput input) {
    contact = models.Contact(
      id: id,
      salutation: input.salutation.value,
      firstName: input.firstName.value,
      lastName: input.lastName.value,
      address: input.address.value,
      phoneNumbers: input.phoneNumbers.value,
      emailAddresses: input.emailAddresses.value,
      createdAt: contact.createdAt,
      modifiedAt: DateTime.utc(2024, 3),
    );
    onMutation?.call();

    if (loseAcknowledgement) {
      throw StateError('ACKNOWLEDGEMENT_LOST');
    }
  }

  @override
  Future<models.ContactsCreateOutput> createContact(
    models.ContactsCreateInput input,
  ) async {
    checkCreate(input);
    creates++;
    store.events.add('create');
    _apply('contact', input);

    return const models.ContactsCreateOutput(id: 'contact');
  }

  @override
  Future<models.ContactsUpdateOutput> updateContact(
    models.ContactsUpdateInput input,
  ) async {
    checkUpdate(input);
    updates++;
    store.events.add('update');
    _apply(input.id, input.data);

    return const models.ContactsUpdateOutput(success: true);
  }

  @override
  Future<models.Contact?> getContact(String id) async {
    checkCurrent();
    reads++;
    store.events.add('get:$id');

    if (foreignReadback) {
      return _contact(id: 'foreign');
    }

    return contact;
  }
}
