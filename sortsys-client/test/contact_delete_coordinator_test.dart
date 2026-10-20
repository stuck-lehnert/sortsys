import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/features/contacts/contact_delete_coordinator.dart';
import 'package:sortsys_client/features/contacts/contact_delete_receipt.dart';
import 'package:sortsys_client/features/projects/project_write_lock.dart';

const _scope = '["https://example.test","tenant","actor","contact"]';

void main() {
  test('contact delete reads back all stages before one dispatch', () async {
    final harness = _Harness();
    harness.access.beforeDelete = () {
      expect(harness.receipts.receipt!.dispatching, isTrue);
      expect(harness.receipts.readbackPending, isFalse);
      expect(harness.receipts.stages, ['prepared', 'dispatching']);
    };

    expect(await harness.delete(), 'contact');
    expect(harness.access.getIds, ['contact']);
    expect(harness.access.deleteIds, ['contact']);
    expect(harness.receipts.stages, [
      'prepared',
      'dispatching',
      'acknowledged',
    ]);
    expect(harness.receipts.receipt, isNull);
    expect(harness.receipts.clears, 1);
  });

  test(
    'contact delete rejects confirmation roles and foreign journals',
    () async {
      final harness = _Harness();

      await expectLater(
        Future.sync(() {
          return harness.delete(confirmed: false);
        }),
        throwsFormatException,
      );
      expect(harness.receipts.reads, 0);

      harness.access.canDelete = false;

      await expectLater(
        Future.sync(() {
          return harness.delete();
        }),
        throwsStateError,
      );
      expect(harness.receipts.reads, 0);

      harness.access.canDelete = true;
      harness.receipts.readError = const FormatException(
        'EXISTING_CONTACT_WRITE',
      );

      await expectLater(harness.delete(), throwsFormatException);
      expect(harness.access.getIds, isEmpty);
      expect(harness.access.deleteIds, isEmpty);

      harness.receipts.readError = null;
      harness.receipts.encoded = _receipt(scope: 'foreign').encode();

      await expectLater(harness.delete(), throwsFormatException);
      expect(harness.receipts.stages, isEmpty);
      expect(harness.access.deleteIds, isEmpty);
    },
  );

  test(
    'contact delete requires a full fresh baseline and known target',
    () async {
      for (final fresh in [
        _contact(firstName: 'Changed'),
        _contact(id: 'other'),
        _contact(modifiedAt: DateTime.utc(2025)),
      ]) {
        final harness = _Harness();
        harness.access.contact = fresh;

        await expectLater(
          harness.delete(),
          _failure(ContactDeleteFailure.conflict),
        );
        expect(harness.access.getIds, ['contact']);
        expect(harness.access.deleteIds, isEmpty);
        expect(harness.receipts.stages, isEmpty);
      }
    },
  );

  test('contact delete freezes baseline before the first await', () async {
    final entered = Completer<void>();
    final release = Completer<void>();
    final phones = [const models.CustomerPhoneNumbersItem(number: 'original')];
    final baseline = _contact(phones: phones);
    final harness = _Harness();
    harness.access.contact = _contact(phones: List.of(phones));
    harness.receipts.beforeRead = (number) async {
      if (number == 1) {
        entered.complete();
        await release.future;
      }
    };

    final operation = harness.delete(baseline: baseline);

    await entered.future;

    phones.clear();
    release.complete();

    expect(await operation, 'contact');
    expect(harness.access.deleteIds, ['contact']);
    expect(
      harness.receipts.snapshots.first.baseline.phoneNumbers.single.number,
      'original',
    );
    expect(baseline.phoneNumbers, isEmpty);
  });

  test(
    'contact delete rejects ignored writes at every durable stage',
    () async {
      for (final ignored in [1, 2, 3]) {
        final harness = _Harness();
        harness.receipts.ignoreWrite = ignored;

        await expectLater(
          harness.delete(),
          ignored == 1
              ? throwsStateError
              : _failure(ContactDeleteFailure.uncertain),
        );
        expect(harness.access.deleteIds.length, ignored == 3 ? 1 : 0);

        if (ignored == 1) {
          expect(harness.receipts.receipt, isNull);
        } else {
          final pending = harness.receipts.receipt!;

          expect(pending.acknowledged, isFalse);
          expect(pending.dispatching, ignored == 3);
        }
      }
    },
  );

  test('contact delete ACK loss never infers absence or replays', () async {
    final harness = _Harness();
    harness.access.loseAcknowledgement = true;

    await expectLater(
      harness.delete(),
      _failure(ContactDeleteFailure.uncertain),
    );

    final pending = harness.receipts.receipt!;
    harness.access.canDelete = false;

    await expectLater(
      harness.coordinator.recover(expectedNonce: pending.nonce),
      _failure(ContactDeleteFailure.uncertain),
    );
    expect(harness.access.getIds, ['contact']);
    expect(harness.access.deleteIds, ['contact']);
    expect(harness.receipts.receipt!.encode(), pending.encode());

    harness.access.canDelete = true;

    await expectLater(
      harness.delete(),
      _failure(ContactDeleteFailure.outstanding),
    );
    expect(harness.access.getIds, ['contact']);
    expect(harness.access.deleteIds, ['contact']);
  });

  test(
    'contact delete unsent discard needs nonce but not delete role',
    () async {
      final harness = _Harness();
      harness.receipts.failAfterWrite = 1;

      await expectLater(harness.delete(), throwsStateError);

      final pending = harness.receipts.receipt!;
      harness.access.canDelete = false;

      await expectLater(
        harness.coordinator.recover(expectedNonce: 'foreign'),
        _failure(ContactDeleteFailure.outstanding),
      );
      expect(harness.receipts.receipt!.encode(), pending.encode());
      expect(pending.dispatching, isFalse);
      expect(pending.acknowledged, isFalse);
      expect(
        await harness.coordinator.recover(expectedNonce: pending.nonce),
        isNull,
      );
      expect(harness.receipts.receipt, isNull);
      expect(harness.access.deleteIds, isEmpty);
      expect(harness.access.getIds, ['contact']);
    },
  );

  test('contact delete role loss after read prevents journal writes', () async {
    final harness = _Harness();
    harness.access.afterGet = () async {
      harness.access.canDelete = false;
    };

    await expectLater(harness.delete(), throwsStateError);
    expect(harness.receipts.stages, isEmpty);
    expect(harness.access.deleteIds, isEmpty);
    expect(harness.receipts.receipt, isNull);
  });

  test('contact delete cleanup retains ID before and after removal', () async {
    for (final after in [false, true]) {
      final harness = _Harness();
      harness.receipts.clearFailureAfter = after;

      await expectLater(
        harness.delete(),
        throwsA(
          isA<ContactDeleteException>()
              .having(
                (error) {
                  return error.failure;
                },
                'failure',
                ContactDeleteFailure.cleanup,
              )
              .having(
                (error) {
                  return error.confirmedContactId;
                },
                'confirmed ID',
                'contact',
              ),
        ),
      );
      expect(harness.access.deleteIds, ['contact']);
      expect(harness.access.getIds, ['contact']);

      if (after) {
        expect(harness.receipts.receipt, isNull);
      } else {
        final pending = harness.receipts.receipt!;
        harness.receipts.clearFailureAfter = null;
        harness.access.canDelete = false;

        expect(pending.acknowledged, isTrue);
        expect(
          await harness.coordinator.recover(expectedNonce: pending.nonce),
          'contact',
        );
        expect(harness.receipts.receipt, isNull);
        expect(harness.access.deleteIds, ['contact']);
        expect(harness.access.getIds, ['contact']);
      }
    }
  });

  test(
    'contact delete stale replies cannot confirm a replacement owner',
    () async {
      for (final phase in ['read', 'delete']) {
        final harness = _Harness();

        if (phase == 'read') {
          harness.access.afterGet = () async {
            harness.access.active = false;
          };
        } else {
          harness.access.afterDelete = () async {
            harness.access.active = false;
          };
        }

        await expectLater(
          harness.delete(),
          phase == 'read'
              ? throwsStateError
              : _failure(ContactDeleteFailure.uncertain),
        );
        expect(harness.access.deleteIds.length, phase == 'delete' ? 1 : 0);

        if (phase == 'read') {
          expect(harness.receipts.receipt, isNull);
        } else {
          expect(harness.receipts.receipt!.dispatching, isTrue);
          expect(harness.receipts.receipt!.acknowledged, isFalse);
        }
      }
    },
  );

  test('contact delete preserves a replacement receipt nonce', () async {
    final harness = _Harness();
    final replacement = _receipt(nonce: 'ffffffffffffffffffffffffffffffff');
    String? originalNonce;
    harness.access.afterDelete = () async {
      originalNonce = harness.receipts.receipt!.nonce;
      harness.receipts.encoded = replacement.encode();
    };

    await expectLater(
      harness.delete(),
      _failure(ContactDeleteFailure.uncertain),
    );
    expect(harness.receipts.receipt!.encode(), replacement.encode());
    expect(harness.access.deleteIds, ['contact']);

    await expectLater(
      harness.coordinator.recover(expectedNonce: originalNonce!),
      _failure(ContactDeleteFailure.outstanding),
    );
    expect(harness.receipts.receipt!.encode(), replacement.encode());
    expect(harness.receipts.clears, 0);
  });

  test(
    'contact delete shares the target contact writer lock and releases it',
    () async {
      final harness = _Harness();
      final entered = Completer<void>();
      final release = Completer<void>();
      final holding = withProjectWriteLock(
        'contacts:${harness.access.scope}',
        () async {
          entered.complete();
          await release.future;

          return 'released';
        },
      );
      await entered.future;

      try {
        await expectLater(
          harness.delete(),
          throwsA(
            isA<StateError>().having(
              (error) {
                return error.message;
              },
              'message',
              'PROJECT_WRITE_BUSY',
            ),
          ),
        );
        expect(harness.receipts.stages, isEmpty);
        expect(harness.access.deleteIds, isEmpty);
      } finally {
        release.complete();
        await holding;
      }

      expect(await harness.delete(), 'contact');
      expect(harness.access.deleteIds, ['contact']);
    },
  );

  test(
    'contact delete rejects a baseline outside the bound target before IO',
    () async {
      final harness = _Harness();

      await expectLater(
        Future.sync(() {
          return harness.delete(baseline: _contact(id: 'other'));
        }),
        throwsFormatException,
      );
      expect(harness.receipts.reads, 0);
      expect(harness.receipts.stages, isEmpty);
      expect(harness.access.getIds, isEmpty);
      expect(harness.access.deleteIds, isEmpty);
    },
  );

  test(
    'contact delete rejects foreign-target receipts for every operation',
    () async {
      for (final operation in ['outstanding', 'delete', 'recover']) {
        final harness = _Harness();
        final pending = _receipt(id: 'other');
        harness.receipts.encoded = pending.encode();

        final Future<Object?> attempt;

        if (operation == 'outstanding') {
          attempt = harness.coordinator.outstanding();
        } else if (operation == 'delete') {
          attempt = harness.delete();
        } else {
          attempt = harness.coordinator.recover(expectedNonce: pending.nonce);
        }

        await expectLater(attempt, throwsFormatException);

        expect(harness.receipts.receipt!.encode(), pending.encode());
        expect(harness.receipts.stages, isEmpty);
        expect(harness.receipts.clears, 0);
        expect(harness.access.getIds, isEmpty);
        expect(harness.access.deleteIds, isEmpty);
      }
    },
  );

  test(
    'contact delete rechecks bound target after every journal read entry',
    () async {
      for (final operation in ['outstanding', 'delete', 'recover']) {
        final harness = _Harness();
        final pending = _receipt();

        if (operation == 'recover') {
          harness.receipts.encoded = pending.encode();
        }

        final original = harness.receipts.encoded;
        harness.receipts.beforeRead = (number) async {
          if (number == 1) {
            harness.access.contactId = 'other';
          }
        };

        final Future<Object?> attempt;

        if (operation == 'outstanding') {
          attempt = harness.coordinator.outstanding();
        } else if (operation == 'delete') {
          attempt = harness.delete();
        } else {
          attempt = harness.coordinator.recover(expectedNonce: pending.nonce);
        }

        await expectLater(attempt, throwsStateError);

        expect(harness.receipts.encoded, original);
        expect(harness.receipts.stages, isEmpty);
        expect(harness.receipts.clears, 0);
        expect(harness.access.getIds, isEmpty);
        expect(harness.access.deleteIds, isEmpty);
      }
    },
  );

  test(
    'contact delete rechecks bound target after fresh reads and mutation replies',
    () async {
      for (final phase in ['read', 'delete']) {
        final harness = _Harness();

        if (phase == 'read') {
          harness.access.afterGet = () async {
            harness.access.contactId = 'other';
          };
        } else {
          harness.access.afterDelete = () async {
            harness.access.contactId = 'other';
          };
        }

        await expectLater(
          harness.delete(),
          phase == 'read'
              ? throwsStateError
              : _failure(ContactDeleteFailure.uncertain),
        );

        expect(harness.access.getIds, ['contact']);
        expect(harness.access.deleteIds.length, phase == 'delete' ? 1 : 0);

        if (phase == 'read') {
          expect(harness.receipts.stages, isEmpty);
        } else {
          expect(harness.receipts.receipt!.dispatching, isTrue);
          expect(harness.receipts.receipt!.acknowledged, isFalse);
        }
      }
    },
  );

  test(
    'contact false ACK and missing mutation records never confirm or replay',
    () async {
      for (final response in ['false', 'not-found']) {
        final harness = _Harness();

        if (response == 'false') {
          harness.access.success = false;
        } else {
          harness.access.deleteError = StateError('HTTP_404');
        }

        await expectLater(
          harness.delete(),
          _failure(ContactDeleteFailure.uncertain),
        );

        final pending = harness.receipts.receipt!;

        expect(pending.dispatching, isTrue);
        expect(pending.acknowledged, isFalse);

        await expectLater(
          harness.coordinator.recover(expectedNonce: pending.nonce),
          _failure(ContactDeleteFailure.uncertain),
        );
        await expectLater(
          harness.delete(),
          _failure(ContactDeleteFailure.outstanding),
        );

        expect(harness.receipts.receipt!.encode(), pending.encode());
        expect(harness.receipts.clears, 0);
        expect(harness.access.getIds, ['contact']);
        expect(harness.access.deleteIds, ['contact']);
      }
    },
  );

  test(
    'contact genuine ACK survives delete-role loss without another request',
    () async {
      final harness = _Harness();
      harness.access.afterDelete = () async {
        harness.access.canDelete = false;
      };

      expect(await harness.delete(), 'contact');
      expect(harness.access.canDelete, isFalse);
      expect(harness.access.getIds, ['contact']);
      expect(harness.access.deleteIds, ['contact']);
      expect(harness.receipts.stages, [
        'prepared',
        'dispatching',
        'acknowledged',
      ]);
      expect(harness.receipts.clears, 1);
      expect(harness.receipts.receipt, isNull);
    },
  );
}

Matcher _failure(ContactDeleteFailure failure) {
  return throwsA(
    isA<ContactDeleteException>().having(
      (error) {
        return error.failure;
      },
      'failure',
      failure,
    ),
  );
}

final class _Harness {
  final access = _Access();
  final receipts = _Receipts();

  ContactDeleteCoordinator get coordinator {
    return ContactDeleteCoordinator(access: access, receipts: receipts);
  }

  Future<String> delete({models.Contact? baseline, bool confirmed = true}) {
    return coordinator.delete(
      baseline: baseline ?? _contact(),
      confirmed: confirmed,
    );
  }
}

models.Contact _contact({
  String id = 'contact',
  String? firstName = 'Contact',
  String? lastName = 'Person',
  List<models.CustomerPhoneNumbersItem> phones = const [],
  DateTime? modifiedAt,
}) {
  return models.Contact(
    id: id,
    firstName: firstName,
    lastName: lastName,
    phoneNumbers: phones,
    emailAddresses: const [],
    createdAt: DateTime.utc(2024),
    modifiedAt: modifiedAt ?? DateTime.utc(2024, 2),
  );
}

ContactDeleteReceipt _receipt({
  String scope = _scope,
  String id = 'contact',
  String nonce = '0123456789abcdef0123456789abcdef',
}) {
  return ContactDeleteReceipt(
    scope: scope,
    nonce: nonce,
    createdAt: DateTime.utc(2024, 3),
    input: models.ContactsDeleteInput(id: id),
    baseline: _contact(id: id),
  );
}

final class _Access implements ContactDeleteAccess {
  @override
  String scope = _scope;

  @override
  String contactId = 'contact';

  bool active = true;
  bool canDelete = true;
  bool loseAcknowledgement = false;
  bool success = true;
  Object? deleteError;
  models.Contact contact = _contact();
  final getIds = <String>[];
  final deleteIds = <String>[];
  void Function()? beforeDelete;
  Future<void> Function()? afterGet;
  Future<void> Function()? afterDelete;

  @override
  void checkCurrent() {
    if (!active) {
      throw StateError('CONTACT_DELETE_SCOPE_CHANGED');
    }
  }

  @override
  void checkDelete(models.ContactsDeleteInput input) {
    checkCurrent();

    if (!canDelete || input.id != contactId) {
      throw StateError('CONTACT_DELETE_FORBIDDEN');
    }
  }

  @override
  Future<models.Contact> getContact(String id) async {
    getIds.add(id);

    final callback = afterGet;

    if (callback != null) {
      await callback();
    }

    return contact;
  }

  @override
  Future<models.ContactsDeleteOutput> deleteContact(
    models.ContactsDeleteInput input,
  ) async {
    checkDelete(input);
    beforeDelete?.call();
    deleteIds.add(input.id);

    final callback = afterDelete;

    if (callback != null) {
      await callback();
    }

    if (loseAcknowledgement) {
      throw StateError('ACK_LOST');
    }

    final error = deleteError;

    if (error != null) {
      throw error;
    }

    return models.ContactsDeleteOutput(success: success);
  }
}

final class _Receipts implements ContactDeleteReceiptStore {
  String? encoded;
  int reads = 0;
  int clears = 0;
  int? ignoreWrite;
  int? failAfterWrite;
  bool? clearFailureAfter;
  bool readbackPending = false;
  Object? readError;
  Future<void> Function(int number)? beforeRead;
  final stages = <String>[];
  final snapshots = <ContactDeleteReceipt>[];

  ContactDeleteReceipt? get receipt {
    final value = encoded;

    return value == null ? null : ContactDeleteReceipt.decode(value);
  }

  @override
  Future<ContactDeleteReceipt?> read(String scope) async {
    reads++;

    final callback = beforeRead;

    if (callback != null) {
      await callback(reads);
    }

    final error = readError;

    if (error != null) {
      throw error;
    }

    readbackPending = false;

    return receipt;
  }

  @override
  Future<void> write(ContactDeleteReceipt receipt) async {
    final stage = receipt.acknowledged
        ? 'acknowledged'
        : receipt.dispatching
        ? 'dispatching'
        : 'prepared';

    stages.add(stage);
    snapshots.add(ContactDeleteReceipt.decode(receipt.encode()));
    readbackPending = true;

    if (ignoreWrite == stages.length) {
      return;
    }

    encoded = receipt.encode();

    if (failAfterWrite == stages.length) {
      throw StateError('AFTER_WRITE_FAILURE');
    }
  }

  @override
  Future<void> clear(String scope) async {
    clears++;

    if (clearFailureAfter == false) {
      throw StateError('BEFORE_CLEAR_FAILURE');
    }

    encoded = null;

    if (clearFailureAfter == true) {
      throw StateError('AFTER_CLEAR_FAILURE');
    }
  }
}
