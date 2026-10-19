import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/client.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/features/vendors/vendor_delete_coordinator.dart';
import 'package:sortsys_client/features/vendors/vendor_draft.dart';
import 'package:sortsys_client/features/vendors/vendor_receipt.dart';
import 'package:sortsys_client/features/vendors/vendor_write_coordinator.dart';

void main() {
  test('vendor deletion journals before one mutation and trusts only its acknowledgement', () async {
    final fixture = _Fixture();
    final result = await fixture.deletions.delete(
      baseline: fixture.access.vendor,
      confirmed: true,
    );

    expect(result, 'vendor');
    expect(fixture.access.deletes, 1);
    expect(fixture.access.reads, 1);
    expect(fixture.store.encoded, isNull);
    expect(fixture.store.events, [
      'read',
      'get:vendor',
      'prepared',
      'dispatching',
      'delete',
      'acknowledged',
      'clear',
    ]);
  });

  test('vendor deletion needs explicit confirmation and an unchanged full baseline', () async {
    final fixture = _Fixture();
    final baseline = fixture.access.vendor;

    await expectLater(
      fixture.deletions.delete(baseline: baseline, confirmed: false),
      throwsFormatException,
    );
    expect(fixture.access.reads, 0);
    expect(fixture.store.events, isEmpty);
    fixture.access.vendor = _vendor(name: 'Concurrent change');

    await expectLater(
      fixture.deletions.delete(baseline: baseline, confirmed: true),
      _fails(VendorDeleteFailure.conflict),
    );
    expect(fixture.access.deletes, 0);
    expect(fixture.store.writes, 0);
  });

  test('vendor lost delete acknowledgement cannot be replaced by HTTP404 or replay', () async {
    final fixture = _Fixture();
    fixture.access.loseAcknowledgement = true;

    await expectLater(
      fixture.deletions.delete(
        baseline: fixture.access.vendor,
        confirmed: true,
      ),
      _fails(VendorDeleteFailure.uncertain),
    );
    final receipt = (await fixture.deletions.outstanding())!;

    await expectLater(
      fixture.deletions.recover(expectedNonce: 'other-operation'),
      _fails(VendorDeleteFailure.outstanding),
    );
    await expectLater(
      fixture.deletions.recover(expectedNonce: receipt.nonce),
      _fails(VendorDeleteFailure.uncertain),
    );
    await expectLater(
      fixture.deletions.delete(
        baseline: fixture.access.vendor,
        confirmed: true,
      ),
      _fails(VendorDeleteFailure.outstanding),
    );
    await expectLater(
      fixture.writes.recover(expectedNonce: receipt.nonce),
      throwsA(
        isA<VendorWriteException>().having(
          (error) => error.failure,
          'failure',
          VendorWriteFailure.outstanding,
        ),
      ),
    );
    await expectLater(
      fixture.access.getVendor('vendor'),
      throwsA(
        isA<RpcException>().having(
          (error) => error.httpCode,
          'generic HTTP status',
          404,
        ),
      ),
    );
    expect(fixture.access.deletes, 1);
    expect(fixture.access.reads, 2);
    expect(fixture.store.encoded, isNotNull);
    expect(receipt.deletionConfirmed, isFalse);
  });

  test(
    'vendor deletion storage failures preserve unsent or uncertain boundaries',
    () async {
      for (final failedWrite in [1, 2, 3]) {
        for (final afterWrite in [false, true]) {
          final fixture = _Fixture();
          fixture.store.failWrite = failedWrite;
          fixture.store.failAfterWrite = afterWrite;

          await expectLater(
            fixture.deletions.delete(
              baseline: fixture.access.vendor,
              confirmed: true,
            ),
            failedWrite == 1
                ? throwsStateError
                : _fails(VendorDeleteFailure.uncertain),
          );
          expect(fixture.access.deletes, failedWrite == 3 ? 1 : 0);
          expect(fixture.access.reads, 1);
          final receipt = await fixture.deletions.outstanding();

          if (receipt == null) {
            expect(failedWrite, 1);
            expect(afterWrite, isFalse);
            continue;
          }

          if (!receipt.dispatching && !receipt.acknowledged) {
            expect(
              await fixture.deletions.recover(expectedNonce: receipt.nonce),
              isNull,
            );
            expect(fixture.access.deletes, 0);
            expect(fixture.store.encoded, isNull);
          } else if (receipt.deletionConfirmed) {
            expect(
              await fixture.deletions.recover(expectedNonce: receipt.nonce),
              'vendor',
            );
            expect(fixture.access.deletes, 1);
          } else {
            await expectLater(
              fixture.deletions.recover(expectedNonce: receipt.nonce),
              _fails(VendorDeleteFailure.uncertain),
            );
            expect(fixture.store.encoded, isNotNull);
          }

          expect(fixture.access.reads, 1);
        }
      }
    },
  );

  test('vendor acknowledged deletion stays successful across cleanup failure and role loss', () async {
    for (final afterClear in [false, true]) {
      final fixture = _Fixture();
      fixture.store.failClear = true;
      fixture.store.failAfterClear = afterClear;

      await expectLater(
        fixture.deletions.delete(
          baseline: fixture.access.vendor,
          confirmed: true,
        ),
        throwsA(
          isA<VendorDeleteException>()
              .having(
                (error) => error.failure,
                'failure',
                VendorDeleteFailure.cleanup,
              )
              .having(
                (error) => error.confirmedVendorId,
                'confirmed target',
                'vendor',
              ),
        ),
      );
      fixture.access.canDelete = false;
      fixture.store.failClear = false;

      if (!afterClear) {
        final receipt = (await fixture.deletions.outstanding())!;

        expect(
          await fixture.deletions.recover(expectedNonce: receipt.nonce),
          'vendor',
        );
      }

      expect(fixture.access.deletes, 1);
      expect(fixture.access.reads, 1);
      expect(fixture.store.encoded, isNull);
    }
  });

  test(
    'vendor deletion checks scope and permission across dispatch awaits',
    () async {
      for (final changeScope in [false, true]) {
        final fixture = _Fixture();

        if (changeScope) {
          fixture.access.onDelete = () async {
            fixture.access.owner = 'other-actor';
          };
        } else {
          fixture.store.onWrite = (count) {
            if (count == 2) {
              fixture.access.canDelete = false;
            }
          };
        }

        await expectLater(
          fixture.deletions.delete(
            baseline: fixture.access.vendor,
            confirmed: true,
          ),
          _fails(VendorDeleteFailure.uncertain),
        );
        expect(fixture.access.deletes, changeScope ? 1 : 0);
        expect(fixture.store.writes, 2);
        expect(
          VendorWriteReceipt.decode(fixture.store.encoded!).dispatching,
          isTrue,
        );
        expect(fixture.store.events.contains('clear'), isFalse);
      }
    },
  );

  test('vendor edit and deletion cannot bypass each other through the shared journal or lock', () async {
    final fixture = _Fixture();
    final baseline = fixture.access.vendor;
    final prior = VendorWriteReceipt(
      scope: fixture.access.scope,
      nonce: '0123456789abcdef0123456789abcdef',
      createdAt: DateTime.utc(2024),
      updateInput: const VendorDraft(
        name: 'Changed',
        vendorId: 'vendor',
      ).updateInput(),
      baseline: baseline,
    );
    fixture.store.encoded = prior.encode();

    await expectLater(
      fixture.deletions.delete(baseline: baseline, confirmed: true),
      _fails(VendorDeleteFailure.outstanding),
    );
    await expectLater(
      fixture.deletions.recover(expectedNonce: prior.nonce),
      _fails(VendorDeleteFailure.outstanding),
    );
    expect(fixture.store.encoded, isNotNull);
    expect(fixture.access.deletes, 0);
    expect(await fixture.writes.recover(expectedNonce: prior.nonce), isNull);

    final entered = Completer<void>();
    final release = Completer<void>();
    fixture.access.loseAcknowledgement = true;
    fixture.access.onDelete = () async {
      entered.complete();
      await release.future;
    };
    final deletion = expectLater(
      fixture.deletions.delete(baseline: baseline, confirmed: true),
      _fails(VendorDeleteFailure.uncertain),
    );
    await entered.future;

    final editing = expectLater(
      fixture.writes.save(
        const VendorDraft(name: 'Changed', vendorId: 'vendor'),
        baseline: baseline,
      ),
      throwsA(
        isA<VendorWriteException>().having(
          (error) => error.failure,
          'failure',
          VendorWriteFailure.outstanding,
        ),
      ),
    );
    release.complete();
    await Future.wait([deletion, editing]);

    expect(fixture.access.deletes, 1);
    expect(fixture.access.reads, 1);
    expect(fixture.store.encoded, isNotNull);
  });
}

Matcher _fails(VendorDeleteFailure failure) {
  return throwsA(
    isA<VendorDeleteException>().having(
      (error) => error.failure,
      'failure',
      failure,
    ),
  );
}

final class _Fixture {
  final store = _Store();
  late final access = _Access(store);
  late final deletions = VendorDeleteCoordinator(
    access: access,
    receipts: store,
  );
  late final writes = VendorWriteCoordinator(access: access, receipts: store);
}

final class _Store implements VendorReceiptStore {
  final events = <String>[];
  String? encoded;
  int writes = 0;
  int failWrite = 0;
  bool failAfterWrite = false;
  bool failClear = false;
  bool failAfterClear = false;
  void Function(int count)? onWrite;

  @override
  Future<VendorWriteReceipt?> read(String scope) async {
    events.add('read');

    return encoded == null ? null : VendorWriteReceipt.decode(encoded!);
  }

  @override
  Future<void> write(VendorWriteReceipt receipt) async {
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

final class _Access implements VendorDeleteAccess {
  _Access(this.store);

  final _Store store;
  String owner = 'origin|tenant|actor|vendor';
  models.ProductVendor vendor = _vendor();
  bool canDelete = true;
  bool current = true;
  bool deleted = false;
  bool loseAcknowledgement = false;
  int deletes = 0;
  int reads = 0;
  Future<void> Function()? onDelete;

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

  @override
  void checkCreate(models.ProductsVendorsCreateInput input) {
    checkCurrent();
  }

  @override
  void checkUpdate(models.ProductsVendorsUpdateInput input) {
    checkCurrent();
  }

  @override
  void checkDelete(models.ProductsVendorsDeleteInput input) {
    checkCurrent();

    if (!canDelete || input.id != 'vendor') {
      throw StateError('DELETE_NOT_ALLOWED');
    }
  }

  @override
  Future<models.ProductsVendorsDeleteOutput> deleteVendor(
    models.ProductsVendorsDeleteInput input,
  ) async {
    checkDelete(input);
    deletes++;
    deleted = true;
    store.events.add('delete');
    await onDelete?.call();

    if (loseAcknowledgement) {
      throw const RpcException('NETWORK_ERROR');
    }

    return const models.ProductsVendorsDeleteOutput(success: true);
  }

  @override
  Future<models.ProductVendor?> getVendor(String id) async {
    checkCurrent();
    reads++;
    store.events.add('get:$id');

    if (deleted) {
      throw const RpcException('HTTP_ERROR', httpCode: 404);
    }

    return vendor;
  }

  @override
  Future<models.ProductsVendorsCreateOutput> createVendor(
    models.ProductsVendorsCreateInput input,
  ) async {
    throw StateError('UNEXPECTED_CREATE');
  }

  @override
  Future<models.ProductsVendorsUpdateOutput> updateVendor(
    models.ProductsVendorsUpdateInput input,
  ) async {
    throw StateError('UNEXPECTED_UPDATE');
  }
}

models.ProductVendor _vendor({String name = 'Vendor'}) {
  return models.ProductVendor(
    id: 'vendor',
    name: name,
    createdAt: DateTime.utc(2024),
    modifiedAt: DateTime.utc(2024, 2),
  );
}
