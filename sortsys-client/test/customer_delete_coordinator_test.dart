import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/features/customers/customer_delete_coordinator.dart';
import 'package:sortsys_client/features/customers/customer_delete_receipt.dart';
import 'package:sortsys_client/features/projects/project_write_lock.dart';

void main() {
  test('customer delete reads back all stages before one dispatch', () async {
    final harness = _Harness();
    harness.access.beforeDelete = () {
      expect(harness.receipts.receipt!.dispatching, isTrue);
      expect(harness.receipts.readbackPending, isFalse);
      expect(harness.receipts.stages, ['prepared', 'dispatching']);
    };

    expect(await harness.delete(), 'customer');
    expect(harness.access.getIds, ['customer']);
    expect(harness.access.deleteIds, ['customer']);
    expect(harness.receipts.stages, [
      'prepared',
      'dispatching',
      'acknowledged',
    ]);
    expect(harness.receipts.receipt, isNull);
    expect(harness.receipts.clears, 1);
  });

  test(
    'customer delete rejects confirmation roles and foreign journals',
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
        'EXISTING_CUSTOMER_WRITE',
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
    'customer delete requires a full fresh baseline and known target',
    () async {
      for (final fresh in [
        _customer(name: 'Changed'),
        _customer(id: 'other'),
        _customer(modifiedAt: DateTime.utc(2025)),
      ]) {
        final harness = _Harness();
        harness.access.customer = fresh;

        await expectLater(
          harness.delete(),
          _failure(CustomerDeleteFailure.conflict),
        );
        expect(harness.access.getIds, ['customer']);
        expect(harness.access.deleteIds, isEmpty);
        expect(harness.receipts.stages, isEmpty);
      }
    },
  );

  test('customer delete freezes baseline before the first await', () async {
    final entered = Completer<void>();
    final release = Completer<void>();
    final phones = [const models.CustomerPhoneNumbersItem(number: 'original')];
    final baseline = _customer(phones: phones);
    final harness = _Harness();
    harness.access.customer = _customer(phones: List.of(phones));
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

    expect(await operation, 'customer');
    expect(harness.access.deleteIds, ['customer']);
    expect(
      harness.receipts.snapshots.first.baseline.phoneNumbers.single.number,
      'original',
    );
    expect(baseline.phoneNumbers, isEmpty);
  });

  test(
    'customer delete rejects ignored writes at every durable stage',
    () async {
      for (final ignored in [1, 2, 3]) {
        final harness = _Harness();
        harness.receipts.ignoreWrite = ignored;

        await expectLater(
          harness.delete(),
          ignored == 1
              ? throwsStateError
              : _failure(CustomerDeleteFailure.uncertain),
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

  test('customer delete ACK loss never infers absence or replays', () async {
    final harness = _Harness();
    harness.access.loseAcknowledgement = true;

    await expectLater(
      harness.delete(),
      _failure(CustomerDeleteFailure.uncertain),
    );

    final pending = harness.receipts.receipt!;
    harness.access.canDelete = false;

    await expectLater(
      harness.coordinator.recover(expectedNonce: pending.nonce),
      _failure(CustomerDeleteFailure.uncertain),
    );
    expect(harness.access.getIds, ['customer']);
    expect(harness.access.deleteIds, ['customer']);
    expect(harness.receipts.receipt!.encode(), pending.encode());

    harness.access.canDelete = true;

    await expectLater(
      harness.delete(),
      _failure(CustomerDeleteFailure.outstanding),
    );
    expect(harness.access.getIds, ['customer']);
    expect(harness.access.deleteIds, ['customer']);
  });

  test(
    'customer delete unsent discard needs nonce but not delete role',
    () async {
      final harness = _Harness();
      harness.receipts.failAfterWrite = 1;

      await expectLater(harness.delete(), throwsStateError);

      final pending = harness.receipts.receipt!;
      harness.access.canDelete = false;

      await expectLater(
        harness.coordinator.recover(expectedNonce: 'foreign'),
        _failure(CustomerDeleteFailure.outstanding),
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
      expect(harness.access.getIds, ['customer']);
    },
  );

  test(
    'customer delete role loss after read prevents journal writes',
    () async {
      final harness = _Harness();
      harness.access.afterGet = () async {
        harness.access.canDelete = false;
      };

      await expectLater(harness.delete(), throwsStateError);
      expect(harness.receipts.stages, isEmpty);
      expect(harness.access.deleteIds, isEmpty);
      expect(harness.receipts.receipt, isNull);
    },
  );

  test('customer delete cleanup retains ID before and after removal', () async {
    for (final after in [false, true]) {
      final harness = _Harness();
      harness.receipts.clearFailureAfter = after;

      await expectLater(
        harness.delete(),
        throwsA(
          isA<CustomerDeleteException>()
              .having(
                (error) {
                  return error.failure;
                },
                'failure',
                CustomerDeleteFailure.cleanup,
              )
              .having(
                (error) {
                  return error.confirmedCustomerId;
                },
                'confirmed ID',
                'customer',
              ),
        ),
      );
      expect(harness.access.deleteIds, ['customer']);
      expect(harness.access.getIds, ['customer']);

      if (after) {
        expect(harness.receipts.receipt, isNull);
      } else {
        final pending = harness.receipts.receipt!;
        harness.receipts.clearFailureAfter = null;
        harness.access.canDelete = false;

        expect(pending.acknowledged, isTrue);
        expect(
          await harness.coordinator.recover(expectedNonce: pending.nonce),
          'customer',
        );
        expect(harness.receipts.receipt, isNull);
        expect(harness.access.deleteIds, ['customer']);
        expect(harness.access.getIds, ['customer']);
      }
    }
  });

  test(
    'customer delete stale replies cannot confirm a replacement owner',
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
              : _failure(CustomerDeleteFailure.uncertain),
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

  test('customer delete preserves a replacement receipt nonce', () async {
    final harness = _Harness();
    final replacement = _receipt(nonce: 'ffffffffffffffffffffffffffffffff');
    String? originalNonce;
    harness.access.afterDelete = () async {
      originalNonce = harness.receipts.receipt!.nonce;
      harness.receipts.encoded = replacement.encode();
    };

    await expectLater(
      harness.delete(),
      _failure(CustomerDeleteFailure.uncertain),
    );
    expect(harness.receipts.receipt!.encode(), replacement.encode());
    expect(harness.access.deleteIds, ['customer']);

    await expectLater(
      harness.coordinator.recover(expectedNonce: originalNonce!),
      _failure(CustomerDeleteFailure.outstanding),
    );
    expect(harness.receipts.receipt!.encode(), replacement.encode());
    expect(harness.receipts.clears, 0);
  });

  test(
    'customer delete shares the actor customer lock and releases it',
    () async {
      final harness = _Harness();
      final entered = Completer<void>();
      final release = Completer<void>();
      final holding = withProjectWriteLock(
        'customer:${harness.access.scope}',
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

      expect(await harness.delete(), 'customer');
      expect(harness.access.deleteIds, ['customer']);
    },
  );
}

Matcher _failure(CustomerDeleteFailure failure) {
  return throwsA(
    isA<CustomerDeleteException>().having(
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

  CustomerDeleteCoordinator get coordinator {
    return CustomerDeleteCoordinator(access: access, receipts: receipts);
  }

  Future<String> delete({models.Customer? baseline, bool confirmed = true}) {
    return coordinator.delete(
      baseline: baseline ?? _customer(),
      confirmed: confirmed,
    );
  }
}

models.Customer _customer({
  String id = 'customer',
  String name = 'Customer',
  List<models.CustomerPhoneNumbersItem> phones = const [],
  DateTime? modifiedAt,
}) {
  return models.Customer(
    id: id,
    name: name,
    phoneNumbers: phones,
    emailAddresses: const [],
    createdAt: DateTime.utc(2024),
    modifiedAt: modifiedAt ?? DateTime.utc(2024, 2),
  );
}

CustomerDeleteReceipt _receipt({
  String scope = 'origin|tenant|actor',
  String nonce = '0123456789abcdef0123456789abcdef',
}) {
  return CustomerDeleteReceipt(
    scope: scope,
    nonce: nonce,
    createdAt: DateTime.utc(2024, 3),
    input: const models.CustomersDeleteInput(id: 'customer'),
    baseline: _customer(),
  );
}

final class _Access implements CustomerDeleteAccess {
  @override
  String scope = 'origin|tenant|actor';

  bool active = true;
  bool canDelete = true;
  bool loseAcknowledgement = false;
  models.Customer customer = _customer();
  final getIds = <String>[];
  final deleteIds = <String>[];
  void Function()? beforeDelete;
  Future<void> Function()? afterGet;
  Future<void> Function()? afterDelete;

  @override
  void checkCurrent() {
    if (!active) {
      throw StateError('CUSTOMER_DELETE_SCOPE_CHANGED');
    }
  }

  @override
  void checkDelete(models.CustomersDeleteInput input) {
    checkCurrent();

    if (!canDelete) {
      throw StateError('CUSTOMER_DELETE_FORBIDDEN');
    }
  }

  @override
  Future<models.Customer> getCustomer(String id) async {
    getIds.add(id);

    final callback = afterGet;

    if (callback != null) {
      await callback();
    }

    return customer;
  }

  @override
  Future<models.CustomersDeleteOutput> deleteCustomer(
    models.CustomersDeleteInput input,
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

    return const models.CustomersDeleteOutput(success: true);
  }
}

final class _Receipts implements CustomerDeleteReceiptStore {
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
  final snapshots = <CustomerDeleteReceipt>[];

  CustomerDeleteReceipt? get receipt {
    final value = encoded;

    return value == null ? null : CustomerDeleteReceipt.decode(value);
  }

  @override
  Future<CustomerDeleteReceipt?> read(String scope) async {
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
  Future<void> write(CustomerDeleteReceipt receipt) async {
    final stage = receipt.acknowledged
        ? 'acknowledged'
        : receipt.dispatching
        ? 'dispatching'
        : 'prepared';

    stages.add(stage);
    snapshots.add(CustomerDeleteReceipt.decode(receipt.encode()));
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
