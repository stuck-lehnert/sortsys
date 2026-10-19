import 'dart:math';

import '../../api/generated/models.g.dart' as models;
import '../projects/project_write_lock.dart';
import 'vendor_receipt.dart';
import 'vendor_write_coordinator.dart';

abstract interface class VendorDeleteAccess implements VendorWriteAccess {
  void checkDelete(models.ProductsVendorsDeleteInput input);

  Future<models.ProductsVendorsDeleteOutput> deleteVendor(
    models.ProductsVendorsDeleteInput input,
  );
}

enum VendorDeleteFailure { outstanding, conflict, uncertain, cleanup }

final class VendorDeleteException implements Exception {
  const VendorDeleteException(
    this.failure, {
    this.cause,
    this.confirmedVendorId,
  });

  final VendorDeleteFailure failure;
  final Object? cause;
  final String? confirmedVendorId;
}

final class VendorDeleteCoordinator {
  const VendorDeleteCoordinator({required this.access, required this.receipts});

  final VendorDeleteAccess access;
  final VendorReceiptStore receipts;

  void _check(String scope) {
    access.checkCurrent();

    if (scope.isEmpty || access.scope != scope) {
      throw StateError('VENDOR_DELETE_SCOPE_CHANGED');
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

  Future<String> delete({
    required models.ProductVendor baseline,
    required bool confirmed,
  }) async {
    final scope = access.scope;
    _check(scope);

    if (!confirmed || baseline.id.isEmpty) {
      throw const FormatException('VENDOR_DELETE_CONFIRMATION_REQUIRED');
    }

    final input = models.ProductsVendorsDeleteInput(id: baseline.id);
    access.checkDelete(input);

    // Creation, editing and deletion share the journal and lock namespace.
    return withProjectWriteLock('vendors:$scope', () {
      return _deleteLocked(scope, input, baseline);
    });
  }

  Future<String> _deleteLocked(
    String scope,
    models.ProductsVendorsDeleteInput input,
    models.ProductVendor baseline,
  ) async {
    if (await _outstanding(scope) != null) {
      throw const VendorDeleteException(VendorDeleteFailure.outstanding);
    }

    access.checkDelete(input);

    final fresh = await access.getVendor(input.id);
    _check(scope);
    access.checkDelete(input);

    if (fresh == null || !sameVendorSnapshot(fresh, baseline)) {
      throw const VendorDeleteException(VendorDeleteFailure.conflict);
    }

    final receipt = VendorWriteReceipt(
      scope: scope,
      nonce: _deletionNonce(),
      createdAt: DateTime.now().toUtc(),
      deleteInput: input,
      baseline: baseline,
    );
    await _persist(scope, receipt);

    try {
      access.checkDelete(input);

      final started = receipt.started();
      await _persist(scope, started);
      access.checkDelete(input);

      final result = await access.deleteVendor(input);
      _check(scope);

      final acknowledged = started.confirmedDelete(result);
      await _persist(scope, acknowledged);

      return await _finishAcknowledged(scope, acknowledged);
    } catch (error) {
      if (error is VendorDeleteException &&
          error.failure == VendorDeleteFailure.cleanup) {
        rethrow;
      }

      throw VendorDeleteException(VendorDeleteFailure.uncertain, cause: error);
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

  Future<String?> recover({required String expectedNonce}) async {
    final scope = access.scope;
    _check(scope);

    return withProjectWriteLock('vendors:$scope', () async {
      final receipt = await _outstanding(scope);

      if (receipt == null) {
        throw StateError('NO_VENDOR_DELETE_RECEIPT');
      }

      if (receipt.nonce != expectedNonce || receipt.deleteInput == null) {
        throw const VendorDeleteException(VendorDeleteFailure.outstanding);
      }

      try {
        if (!receipt.dispatching && !receipt.acknowledged) {
          await receipts.clear(scope);
          _check(scope);

          return null;
        }

        return await _finishAcknowledged(scope, receipt);
      } catch (error) {
        if (error is VendorDeleteException &&
            error.failure == VendorDeleteFailure.cleanup) {
          rethrow;
        }

        throw VendorDeleteException(
          VendorDeleteFailure.uncertain,
          cause: error,
        );
      }
    });
  }

  Future<String> _finishAcknowledged(
    String scope,
    VendorWriteReceipt receipt,
  ) async {
    _check(scope);

    if (!receipt.deletionConfirmed) {
      // Missing records, including generic HTTP 404, cannot establish success.
      throw StateError('VENDOR_DELETION_NOT_ACKNOWLEDGED');
    }

    final id = receipt.deleteInput!.id;

    try {
      await receipts.clear(scope);
    } catch (error) {
      _check(scope);

      throw VendorDeleteException(
        VendorDeleteFailure.cleanup,
        cause: error,
        confirmedVendorId: id,
      );
    }

    _check(scope);

    return id;
  }
}

String _deletionNonce() {
  final random = Random.secure();
  final bytes = List<int>.generate(16, (index) {
    return random.nextInt(256);
  });

  return bytes.map((value) {
    return value.toRadixString(16).padLeft(2, '0');
  }).join();
}
