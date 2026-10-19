import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/features/vendors/vendor_draft.dart';
import 'package:sortsys_client/features/vendors/vendor_receipt.dart';
import 'package:sortsys_client/features/vendors/vendor_write_coordinator.dart';

void main() {
  test(
    'vendor create persists each stage before one write and exact readback',
    () async {
      final store = _Store();
      final access = _Access(store);
      final coordinator = VendorWriteCoordinator(
        access: access,
        receipts: store,
      );

      final result = await coordinator.save(_draft());

      expect(result.name, 'After');
      expect(access.creates, 1);
      expect(access.updates, 0);
      expect(store.events, [
        'read',
        'prepared',
        'dispatching',
        'create',
        'acknowledged',
        'get:vendor',
        'clear',
      ]);
      expect(store.encoded, isNull);
    },
  );

  test(
    'vendor update checks fresh baseline and verifies the known changed target',
    () async {
      final store = _Store();
      final access = _Access(store);
      final baseline = access.vendor;
      final coordinator = VendorWriteCoordinator(
        access: access,
        receipts: store,
      );

      final result = await coordinator.save(
        _draft(update: true),
        baseline: baseline,
      );

      expect(result.id, baseline.id);
      expect(result.name, 'After');
      expect(access.creates, 0);
      expect(access.updates, 1);
      expect(access.reads, 2);
      expect(store.saved.first.baseline?.name, 'Before');
      expect(store.encoded, isNull);
    },
  );

  test(
    'vendor conflicts and unchanged edits never journal or mutate',
    () async {
      final store = _Store();
      final access = _Access(store);
      final baseline = access.vendor;
      final coordinator = VendorWriteCoordinator(
        access: access,
        receipts: store,
      );
      access.vendor = _vendor(name: 'Concurrent change');

      await expectLater(
        coordinator.save(_draft(update: true), baseline: baseline),
        _fails(VendorWriteFailure.conflict),
      );
      access.vendor = baseline;
      final result = await coordinator.save(
        VendorDraft.fromVendor(baseline),
        baseline: baseline,
      );

      expect(result.name, 'Before');
      expect(access.updates, 0);
      expect(access.creates, 0);
      expect(store.writes, 0);
    },
  );

  test(
    'vendor lost acknowledgements never replay create or known-ID update',
    () async {
      for (final update in [false, true]) {
        final store = _Store();
        final access = _Access(store)..loseAcknowledgement = true;
        final baseline = access.vendor;
        final coordinator = VendorWriteCoordinator(
          access: access,
          receipts: store,
        );

        await expectLater(
          coordinator.save(
            _draft(update: update),
            baseline: update ? baseline : null,
          ),
          _fails(VendorWriteFailure.uncertain),
        );
        final receipt = (await coordinator.outstanding())!;

        if (update) {
          final result = await coordinator.recover(
            expectedNonce: receipt.nonce,
          );

          expect(result?.name, 'After');
          expect(access.updates, 1);
          expect(access.creates, 0);
          expect(access.reads, 2);
        } else {
          await expectLater(
            coordinator.recover(expectedNonce: receipt.nonce),
            _fails(VendorWriteFailure.uncertain),
          );
          await expectLater(
            coordinator.save(_draft()),
            _fails(VendorWriteFailure.outstanding),
          );

          expect(access.creates, 1);
          expect(access.reads, 0);
          expect(store.encoded, isNotNull);
        }
      }
    },
  );

  test(
    'vendor storage boundaries prevent dispatch or leave uncertainty blocked',
    () async {
      for (final failedWrite in [1, 2, 3]) {
        final store = _Store()..failWrite = failedWrite;
        final access = _Access(store);
        final coordinator = VendorWriteCoordinator(
          access: access,
          receipts: store,
        );

        await expectLater(
          coordinator.save(_draft()),
          failedWrite == 1
              ? throwsStateError
              : _fails(VendorWriteFailure.uncertain),
        );

        expect(access.creates, failedWrite == 3 ? 1 : 0);
        expect(access.reads, 0);

        if (failedWrite == 2) {
          final receipt = (await coordinator.outstanding())!;

          expect(receipt.dispatching, isFalse);
          expect(
            await coordinator.recover(expectedNonce: receipt.nonce),
            isNull,
          );
          expect(store.encoded, isNull);
        }
      }
    },
  );

  test(
    'vendor acknowledged readback retry checks nonce and never repeats write',
    () async {
      final store = _Store();
      final access = _Access(store)..wrongReadback = true;
      final coordinator = VendorWriteCoordinator(
        access: access,
        receipts: store,
      );

      await expectLater(
        coordinator.save(_draft()),
        _fails(VendorWriteFailure.uncertain),
      );
      final receipt = (await coordinator.outstanding())!;

      await expectLater(
        coordinator.recover(expectedNonce: 'different'),
        _fails(VendorWriteFailure.outstanding),
      );
      expect(access.reads, 1);
      access.wrongReadback = false;
      final result = await coordinator.recover(expectedNonce: receipt.nonce);

      expect(result?.name, 'After');
      expect(access.creates, 1);
      expect(access.reads, 2);
    },
  );

  test(
    'vendor permission and owner changes stop dispatch or further readback',
    () async {
      for (final scopeChange in [false, true]) {
        final store = _Store();
        final access = _Access(store)..changeScopeAfterWrite = scopeChange;

        if (!scopeChange) {
          store.afterWrite = () {
            if (store.writes == 2) {
              access.manage = false;
            }
          };
        }

        final coordinator = VendorWriteCoordinator(
          access: access,
          receipts: store,
        );
        await expectLater(
          coordinator.save(_draft()),
          _fails(VendorWriteFailure.uncertain),
        );

        expect(access.creates, scopeChange ? 1 : 0);
        expect(access.reads, 0);
        expect(store.encoded, isNotNull);
        expect(store.events.contains('clear'), isFalse);
      }
    },
  );

  test(
    'vendor verified write survives cleanup failure without resubmission',
    () async {
      for (final clearBeforeFailure in [false, true]) {
        final store = _Store()
          ..failClear = true
          ..clearBeforeFailure = clearBeforeFailure;
        final access = _Access(store);
        final coordinator = VendorWriteCoordinator(
          access: access,
          receipts: store,
        );

        await expectLater(
          coordinator.save(_draft()),
          throwsA(
            isA<VendorWriteException>()
                .having(
                  (error) => error.failure,
                  'failure',
                  VendorWriteFailure.cleanup,
                )
                .having(
                  (error) => error.confirmedVendor?.id,
                  'verified ID',
                  'vendor',
                ),
          ),
        );

        if (!clearBeforeFailure) {
          store.failClear = false;
          final receipt = (await coordinator.outstanding())!;
          final result = await coordinator.recover(
            expectedNonce: receipt.nonce,
          );

          expect(result?.id, 'vendor');
        }

        expect(access.creates, 1);
        expect(store.encoded, isNull);
      }
    },
  );
}

Matcher _fails(VendorWriteFailure failure) {
  return throwsA(
    isA<VendorWriteException>().having(
      (error) => error.failure,
      'failure',
      failure,
    ),
  );
}

VendorDraft _draft({bool update = false}) {
  return VendorDraft(name: ' After ', vendorId: update ? 'vendor' : null);
}

models.ProductVendor _vendor({String name = 'Before', DateTime? modifiedAt}) {
  return models.ProductVendor(
    id: 'vendor',
    name: name,
    createdAt: DateTime.utc(2024),
    modifiedAt: modifiedAt ?? DateTime.utc(2024, 2),
  );
}

final class _Store implements VendorReceiptStore {
  final events = <String>[];
  final saved = <VendorWriteReceipt>[];
  String? encoded;
  int writes = 0;
  int? failWrite;
  bool failClear = false;
  bool clearBeforeFailure = false;
  void Function()? afterWrite;

  @override
  Future<VendorWriteReceipt?> read(String scope) async {
    events.add('read');
    final value = encoded;

    return value == null ? null : VendorWriteReceipt.decode(value);
  }

  @override
  Future<void> write(VendorWriteReceipt receipt) async {
    writes++;

    if (writes == failWrite) {
      throw StateError('storage unavailable');
    }

    encoded = receipt.encode();
    saved.add(VendorWriteReceipt.decode(encoded!));
    events.add(
      receipt.dispatching
          ? 'dispatching'
          : receipt.acknowledged
          ? 'acknowledged'
          : 'prepared',
    );
    afterWrite?.call();
  }

  @override
  Future<void> clear(String scope) async {
    events.add('clear');

    if (clearBeforeFailure) {
      encoded = null;
    }

    if (failClear) {
      throw StateError('cleanup unavailable');
    }

    encoded = null;
  }
}

final class _Access implements VendorWriteAccess {
  _Access(this.store);

  final _Store store;
  String owner = 'scope';
  bool manage = true;
  bool current = true;
  bool loseAcknowledgement = false;
  bool changeScopeAfterWrite = false;
  bool wrongReadback = false;
  models.ProductVendor vendor = _vendor();
  int creates = 0;
  int updates = 0;
  int reads = 0;

  @override
  String get scope {
    return owner;
  }

  @override
  void checkCurrent() {
    if (!current) {
      throw StateError('owner changed');
    }
  }

  @override
  void checkCreate(models.ProductsVendorsCreateInput input) {
    checkCurrent();

    if (!manage) {
      throw StateError('permission changed');
    }
  }

  @override
  void checkUpdate(models.ProductsVendorsUpdateInput input) {
    checkCurrent();

    if (!manage || input.id != 'vendor') {
      throw StateError('permission or owner changed');
    }
  }

  void _afterWrite() {
    if (changeScopeAfterWrite) {
      owner = 'other';
    }

    if (loseAcknowledgement) {
      throw StateError('acknowledgement lost');
    }
  }

  @override
  Future<models.ProductsVendorsCreateOutput> createVendor(
    models.ProductsVendorsCreateInput input,
  ) async {
    creates++;
    store.events.add('create');
    vendor = _vendor(name: input.name);
    _afterWrite();

    return const models.ProductsVendorsCreateOutput(id: 'vendor');
  }

  @override
  Future<models.ProductsVendorsUpdateOutput> updateVendor(
    models.ProductsVendorsUpdateInput input,
  ) async {
    updates++;
    store.events.add('update');
    vendor = _vendor(
      name: input.data.name.value,
      modifiedAt: DateTime.utc(2024, 2, 2),
    );
    _afterWrite();

    return const models.ProductsVendorsUpdateOutput(success: true);
  }

  @override
  Future<models.ProductVendor?> getVendor(String id) async {
    reads++;
    store.events.add('get:$id');
    expect(id, 'vendor');

    return wrongReadback ? _vendor(name: 'Wrong target') : vendor;
  }
}
