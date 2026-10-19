import 'dart:math';

import '../../api/generated/models.g.dart' as models;
import '../projects/project_write_lock.dart';
import 'vendor_draft.dart';
import 'vendor_receipt.dart';

abstract interface class VendorWriteAccess {
  String get scope;

  void checkCurrent();

  void checkCreate(models.ProductsVendorsCreateInput input);

  void checkUpdate(models.ProductsVendorsUpdateInput input);

  Future<models.ProductsVendorsCreateOutput> createVendor(
    models.ProductsVendorsCreateInput input,
  );

  Future<models.ProductsVendorsUpdateOutput> updateVendor(
    models.ProductsVendorsUpdateInput input,
  );

  Future<models.ProductVendor?> getVendor(String id);
}

enum VendorWriteFailure { outstanding, conflict, uncertain, cleanup }

final class VendorWriteException implements Exception {
  const VendorWriteException(this.failure, {this.cause, this.confirmedVendor});

  final VendorWriteFailure failure;
  final Object? cause;
  final models.ProductVendor? confirmedVendor;
}

final class VendorWriteCoordinator {
  const VendorWriteCoordinator({required this.access, required this.receipts});

  final VendorWriteAccess access;
  final VendorReceiptStore receipts;

  void _check(String scope) {
    access.checkCurrent();

    if (scope.isEmpty || access.scope != scope) {
      throw StateError('VENDOR_WRITE_SCOPE_CHANGED');
    }
  }

  Future<VendorWriteReceipt?> outstanding() {
    return _outstanding(access.scope);
  }

  Future<VendorWriteReceipt?> _outstanding(String scope) async {
    _check(scope);

    final receipt = await receipts.read(scope);
    _check(scope);

    if (receipt != null) {
      receipt.encode();

      if (receipt.scope != scope) {
        throw const FormatException('VENDOR_RECEIPT_SCOPE_MISMATCH');
      }
    }

    return receipt;
  }

  Future<models.ProductVendor> save(
    VendorDraft draft, {
    models.ProductVendor? baseline,
  }) async {
    final scope = access.scope;
    _check(scope);

    final create = draft.vendorId == null ? draft.createInput() : null;
    final update = draft.vendorId == null ? null : draft.updateInput();

    if ((create != null && baseline != null) ||
        (update != null && (baseline == null || baseline.id != update.id))) {
      throw const FormatException('INVALID_VENDOR_WRITE_BASELINE');
    }

    _checkWrite(create, update);

    return withProjectWriteLock('vendors:$scope', () {
      return _saveLocked(scope, create, update, baseline);
    });
  }

  void _checkWrite(
    models.ProductsVendorsCreateInput? create,
    models.ProductsVendorsUpdateInput? update,
  ) {
    if (create != null) {
      access.checkCreate(create);
    } else if (update != null) {
      access.checkUpdate(update);
    } else {
      throw const FormatException('INVALID_VENDOR_WRITE_KIND');
    }
  }

  Future<models.ProductVendor> _saveLocked(
    String scope,
    models.ProductsVendorsCreateInput? create,
    models.ProductsVendorsUpdateInput? update,
    models.ProductVendor? baseline,
  ) async {
    if (await _outstanding(scope) != null) {
      throw const VendorWriteException(VendorWriteFailure.outstanding);
    }

    _checkWrite(create, update);

    if (update != null) {
      final fresh = await access.getVendor(update.id);
      _check(scope);
      access.checkUpdate(update);

      if (fresh == null ||
          baseline == null ||
          !sameVendorSnapshot(fresh, baseline)) {
        throw const VendorWriteException(VendorWriteFailure.conflict);
      }

      if (fresh.name == update.data.name.valueOrNull &&
          fresh.description == update.data.description.valueOrNull) {
        return fresh;
      }
    }

    final receipt = VendorWriteReceipt(
      scope: scope,
      nonce: _operationNonce(),
      createdAt: DateTime.now().toUtc(),
      createInput: create,
      updateInput: update,
      baseline: baseline,
    );
    await _persist(scope, receipt);

    try {
      _checkWrite(create, update);

      final started = receipt.started();
      await _persist(scope, started);
      _checkWrite(create, update);

      final VendorWriteReceipt confirmed;

      if (create != null) {
        final result = await access.createVendor(create);
        _check(scope);
        confirmed = started.confirmedCreate(result);
      } else {
        final result = await access.updateVendor(update!);
        _check(scope);
        confirmed = started.confirmedUpdate(result);
      }

      await _persist(scope, confirmed);

      return await _verifyAndClear(scope, confirmed);
    } catch (error) {
      if (error is VendorWriteException &&
          error.failure == VendorWriteFailure.cleanup) {
        rethrow;
      }

      throw VendorWriteException(VendorWriteFailure.uncertain, cause: error);
    }
  }

  Future<void> _persist(String scope, VendorWriteReceipt receipt) async {
    _check(scope);
    receipt.encode();

    if (receipt.scope != scope) {
      throw const FormatException('VENDOR_RECEIPT_SCOPE_MISMATCH');
    }

    await receipts.write(receipt);
    _check(scope);
  }

  Future<models.ProductVendor?> recover({required String expectedNonce}) async {
    final scope = access.scope;
    _check(scope);

    return withProjectWriteLock('vendors:$scope', () async {
      final receipt = await _outstanding(scope);

      if (receipt == null) {
        throw StateError('NO_VENDOR_WRITE_RECEIPT');
      }

      if (expectedNonce != receipt.nonce || receipt.deleteInput != null) {
        throw const VendorWriteException(VendorWriteFailure.outstanding);
      }

      try {
        if (!receipt.dispatching && !receipt.acknowledged) {
          await receipts.clear(scope);
          _check(scope);

          return null;
        }

        return await _verifyAndClear(scope, receipt);
      } catch (error) {
        if (error is VendorWriteException &&
            error.failure == VendorWriteFailure.cleanup) {
          rethrow;
        }

        throw VendorWriteException(VendorWriteFailure.uncertain, cause: error);
      }
    });
  }

  Future<models.ProductVendor> _verifyAndClear(
    String scope,
    VendorWriteReceipt receipt,
  ) async {
    final id = receipt.creation?.id ?? receipt.updateInput?.id;

    if (id == null || id.isEmpty) {
      throw StateError('UNCONFIRMED_VENDOR_CREATION');
    }

    _check(scope);

    final vendor = await access.getVendor(id);
    _check(scope);

    if (vendor == null || !receipt.confirms(vendor)) {
      throw StateError('VENDOR_WRITE_NOT_CONFIRMED');
    }

    // The target is verified; cleanup failure cannot justify resubmission.
    try {
      await receipts.clear(scope);
    } catch (error) {
      _check(scope);

      throw VendorWriteException(
        VendorWriteFailure.cleanup,
        cause: error,
        confirmedVendor: vendor,
      );
    }

    _check(scope);

    return vendor;
  }
}

String _operationNonce() {
  final random = Random.secure();
  final bytes = List<int>.generate(16, (index) {
    return random.nextInt(256);
  });

  return bytes.map((value) {
    return value.toRadixString(16).padLeft(2, '0');
  }).join();
}
