import 'dart:math';

import '../../api/generated/models.g.dart' as models;
import '../projects/project_write_lock.dart';
import 'product_price_draft.dart';
import 'product_price_receipt.dart';

abstract interface class ProductPriceWriteAccess {
  String get scope;

  void checkCurrent();

  void checkCreate(models.ProductsPriceRecordsCreateInput input);

  Future<models.ProductsPriceRecordsCreateOutput> createPrice(
    models.ProductsPriceRecordsCreateInput input,
  );

  Future<models.ProductsPriceRecordsListResultItem?> priceRecord(
    String recordId,
    String productId,
  );
}

enum ProductPriceWriteFailure { outstanding, uncertain, cleanup }

final class ProductPriceWriteException implements Exception {
  const ProductPriceWriteException(
    this.failure, {
    this.cause,
    this.confirmedRecord,
  });

  final ProductPriceWriteFailure failure;
  final Object? cause;
  final models.ProductsPriceRecordsListResultItem? confirmedRecord;
}

final class ProductPriceWriteCoordinator {
  const ProductPriceWriteCoordinator({
    required this.access,
    required this.receipts,
  });

  final ProductPriceWriteAccess access;
  final ProductPriceReceiptStore receipts;

  void _check(String scope) {
    access.checkCurrent();

    if (scope.isEmpty || access.scope != scope) {
      throw StateError('PRODUCT_PRICE_WRITE_SCOPE_CHANGED');
    }
  }

  Future<ProductPriceWriteReceipt?> outstanding() {
    final scope = access.scope;

    return _outstanding(scope);
  }

  Future<ProductPriceWriteReceipt?> _outstanding(String scope) async {
    _check(scope);

    final receipt = await receipts.read(scope);
    _check(scope);

    if (receipt != null) {
      receipt.encode();

      if (receipt.scope != scope) {
        throw const FormatException('PRODUCT_PRICE_RECEIPT_SCOPE_MISMATCH');
      }
    }

    return receipt;
  }

  Future<models.ProductsPriceRecordsListResultItem> save(
    ProductPriceDraft draft,
  ) async {
    final scope = access.scope;
    _check(scope);

    final input = draft.createInput();
    access.checkCreate(input);

    return withProjectWriteLock('product-prices:$scope', () {
      return _saveLocked(scope, input);
    });
  }

  Future<models.ProductsPriceRecordsListResultItem> _saveLocked(
    String scope,
    models.ProductsPriceRecordsCreateInput input,
  ) async {
    final pending = await _outstanding(scope);

    if (pending != null) {
      throw const ProductPriceWriteException(
        ProductPriceWriteFailure.outstanding,
      );
    }

    access.checkCreate(input);

    final receipt = ProductPriceWriteReceipt(
      scope: scope,
      nonce: _operationNonce(),
      createdAt: DateTime.now().toUtc(),
      input: input,
    );
    await _persist(scope, receipt);

    try {
      access.checkCreate(input);

      final started = receipt.started();
      await _persist(scope, started);
      access.checkCreate(input);

      final acknowledgement = await access.createPrice(input);
      _check(scope);

      final confirmed = started.confirmed(acknowledgement);
      await _persist(scope, confirmed);

      return await _verifyAndClear(scope, confirmed);
    } catch (error) {
      if (error is ProductPriceWriteException &&
          error.failure == ProductPriceWriteFailure.cleanup) {
        rethrow;
      }

      throw ProductPriceWriteException(
        ProductPriceWriteFailure.uncertain,
        cause: error,
      );
    }
  }

  Future<void> _persist(String scope, ProductPriceWriteReceipt receipt) async {
    _check(scope);
    receipt.encode();

    if (receipt.scope != scope) {
      throw const FormatException('PRODUCT_PRICE_RECEIPT_SCOPE_MISMATCH');
    }

    await receipts.write(receipt);
    _check(scope);
  }

  Future<models.ProductsPriceRecordsListResultItem?> recover({
    String? expectedNonce,
  }) async {
    final scope = access.scope;
    _check(scope);

    return withProjectWriteLock('product-prices:$scope', () async {
      final receipt = await _outstanding(scope);

      if (receipt == null) {
        throw StateError('NO_PRODUCT_PRICE_WRITE_RECEIPT');
      }

      if (expectedNonce != null && expectedNonce != receipt.nonce) {
        throw const ProductPriceWriteException(
          ProductPriceWriteFailure.outstanding,
        );
      }

      try {
        if (receipt.acknowledgement != null) {
          return await _verifyAndClear(scope, receipt);
        }

        if (receipt.dispatching) {
          throw StateError('UNCONFIRMED_PRODUCT_PRICE_CREATION');
        }

        // Only a durable pre-dispatch stage proves nothing was submitted.
        await receipts.clear(scope);
        _check(scope);

        return null;
      } catch (error) {
        if (error is ProductPriceWriteException &&
            error.failure == ProductPriceWriteFailure.cleanup) {
          rethrow;
        }

        throw ProductPriceWriteException(
          ProductPriceWriteFailure.uncertain,
          cause: error,
        );
      }
    });
  }

  Future<models.ProductsPriceRecordsListResultItem> _verifyAndClear(
    String scope,
    ProductPriceWriteReceipt receipt,
  ) async {
    final acknowledgement = receipt.acknowledgement;

    if (acknowledgement == null) {
      throw StateError('UNCONFIRMED_PRODUCT_PRICE_CREATION');
    }

    _check(scope);

    final record = await access.priceRecord(
      acknowledgement.id,
      receipt.input.productId,
    );
    _check(scope);

    if (record == null || !receipt.confirms(record)) {
      throw StateError('PRODUCT_PRICE_WRITE_NOT_CONFIRMED');
    }

    // Creation is verified; cleanup failure must not invite resubmission.
    try {
      await receipts.clear(scope);
    } catch (error) {
      _check(scope);

      throw ProductPriceWriteException(
        ProductPriceWriteFailure.cleanup,
        cause: error,
        confirmedRecord: record,
      );
    }

    _check(scope);

    return record;
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
