import 'dart:math';

import '../../api/generated/models.g.dart' as models;
import '../projects/project_write_lock.dart';
import 'customer_delete_receipt.dart';

abstract interface class CustomerDeleteAccess {
  String get scope;

  void checkCurrent();

  void checkDelete(models.CustomersDeleteInput input);

  Future<models.Customer> getCustomer(String id);

  Future<models.CustomersDeleteOutput> deleteCustomer(
    models.CustomersDeleteInput input,
  );
}

enum CustomerDeleteFailure { outstanding, conflict, uncertain, cleanup }

final class CustomerDeleteException implements Exception {
  const CustomerDeleteException(
    this.failure, {
    this.cause,
    this.confirmedCustomerId,
  });

  final CustomerDeleteFailure failure;
  final Object? cause;
  final String? confirmedCustomerId;
}

final class CustomerDeleteCoordinator {
  const CustomerDeleteCoordinator({
    required this.access,
    required this.receipts,
  });

  final CustomerDeleteAccess access;
  final CustomerDeleteReceiptStore receipts;

  void _check(String scope) {
    access.checkCurrent();

    if (scope.isEmpty || access.scope != scope) {
      throw StateError('CUSTOMER_DELETE_SCOPE_CHANGED');
    }
  }

  Future<CustomerDeleteReceipt?> outstanding() {
    return _outstanding(access.scope);
  }

  Future<CustomerDeleteReceipt?> _outstanding(String scope) async {
    _check(scope);

    final receipt = await receipts.read(scope);

    _check(scope);

    if (receipt != null) {
      receipt.encode();

      if (receipt.scope != scope) {
        throw const FormatException('CUSTOMER_DELETE_RECEIPT_SCOPE_MISMATCH');
      }
    }

    return receipt;
  }

  Future<String> delete({
    required models.Customer baseline,
    required bool confirmed,
  }) {
    final scope = access.scope;
    _check(scope);

    if (!confirmed || baseline.id.isEmpty) {
      throw const FormatException('CUSTOMER_DELETE_CONFIRMATION_REQUIRED');
    }

    final snapshot = freezeCustomerDeleteBaseline(baseline);
    final input = models.CustomersDeleteInput(id: snapshot.id);

    access.checkDelete(input);

    // Serialize deletion with the existing actor-wide customer create/edit lock.
    return withProjectWriteLock('customer:$scope', () {
      return _deleteLocked(scope, input, snapshot);
    });
  }

  Future<String> _deleteLocked(
    String scope,
    models.CustomersDeleteInput input,
    models.Customer baseline,
  ) async {
    if (await _outstanding(scope) != null) {
      throw const CustomerDeleteException(CustomerDeleteFailure.outstanding);
    }

    access.checkDelete(input);

    final fresh = await access.getCustomer(input.id);

    _check(scope);
    access.checkDelete(input);

    if (!sameCustomerDeleteBaseline(fresh, baseline)) {
      throw const CustomerDeleteException(CustomerDeleteFailure.conflict);
    }

    final receipt = CustomerDeleteReceipt(
      scope: scope,
      nonce: _nonce(),
      createdAt: DateTime.now().toUtc(),
      input: input,
      baseline: baseline,
    );

    await _persist(scope, receipt);

    try {
      access.checkDelete(input);

      final started = receipt.started();

      await _persist(scope, started, previous: receipt);
      access.checkDelete(input);

      final result = await access.deleteCustomer(input);

      _check(scope);

      final acknowledged = started.confirmed(result);

      await _persist(scope, acknowledged, previous: started);

      return await _finishAcknowledged(scope, acknowledged);
    } catch (error) {
      if (error is CustomerDeleteException &&
          error.failure == CustomerDeleteFailure.cleanup) {
        rethrow;
      }

      throw CustomerDeleteException(
        CustomerDeleteFailure.uncertain,
        cause: error,
      );
    }
  }

  Future<void> _persist(
    String scope,
    CustomerDeleteReceipt receipt, {
    CustomerDeleteReceipt? previous,
  }) async {
    _check(scope);

    final encoded = receipt.encode();

    final current = await _outstanding(scope);

    if (receipt.scope != scope ||
        (previous == null && current != null) ||
        (previous != null && current?.encode() != previous.encode())) {
      throw const CustomerDeleteException(CustomerDeleteFailure.outstanding);
    }

    await receipts.write(receipt);

    _check(scope);

    final persisted = await _outstanding(scope);

    if (persisted?.encode() != encoded) {
      throw StateError('CUSTOMER_DELETE_RECEIPT_NOT_PERSISTED');
    }
  }

  Future<String?> recover({required String expectedNonce}) {
    final scope = access.scope;
    _check(scope);

    return withProjectWriteLock('customer:$scope', () async {
      final receipt = await _outstanding(scope);

      if (receipt == null) {
        throw StateError('NO_CUSTOMER_DELETE_RECEIPT');
      }

      if (receipt.nonce != expectedNonce) {
        throw const CustomerDeleteException(CustomerDeleteFailure.outstanding);
      }

      if (receipt.acknowledged) {
        return _finishAcknowledged(scope, receipt);
      }

      if (receipt.dispatching) {
        throw const CustomerDeleteException(CustomerDeleteFailure.uncertain);
      }

      // Only an intent that never entered dispatch can be safely discarded.
      final current = await _outstanding(scope);

      if (current?.encode() != receipt.encode()) {
        throw const CustomerDeleteException(CustomerDeleteFailure.outstanding);
      }

      await receipts.clear(scope);

      _check(scope);

      if (await _outstanding(scope) != null) {
        throw StateError('CUSTOMER_DELETE_RECEIPT_NOT_CLEARED');
      }

      return null;
    });
  }

  Future<String> _finishAcknowledged(
    String scope,
    CustomerDeleteReceipt receipt,
  ) async {
    _check(scope);

    if (!receipt.acknowledged || receipt.dispatching) {
      throw const CustomerDeleteException(CustomerDeleteFailure.uncertain);
    }

    final id = receipt.input.id;

    try {
      final current = await _outstanding(scope);

      if (current?.encode() != receipt.encode()) {
        throw StateError('CUSTOMER_DELETE_RECEIPT_CHANGED');
      }

      await receipts.clear(scope);

      _check(scope);

      if (await _outstanding(scope) != null) {
        throw StateError('CUSTOMER_DELETE_RECEIPT_NOT_CLEARED');
      }

      return id;
    } catch (error) {
      throw CustomerDeleteException(
        CustomerDeleteFailure.cleanup,
        cause: error,
        confirmedCustomerId: id,
      );
    }
  }
}

String _nonce() {
  final random = Random.secure();

  return List.generate(16, (_) {
    return random.nextInt(256).toRadixString(16).padLeft(2, '0');
  }).join();
}
