import 'dart:math';

import '../../api/generated/models.g.dart' as models;
import '../projects/project_write_lock.dart';
import 'product_categories_receipt.dart';
import 'product_delete_receipt.dart';
import 'product_price_receipt.dart';

abstract interface class ProductDeleteAccess {
  String get scope;

  String get productId;

  void checkCurrent();

  void checkDelete(models.ProductsDeleteInput input);

  Future<models.Product> getProduct(String id);

  Future<models.ProductsDeleteOutput> deleteProduct(
    models.ProductsDeleteInput input,
  );
}

enum ProductDeleteFailure { outstanding, conflict, uncertain, cleanup }

final class ProductDeleteException implements Exception {
  const ProductDeleteException(
    this.failure, {
    this.cause,
    this.confirmedProductId,
  });

  final ProductDeleteFailure failure;
  final Object? cause;
  final String? confirmedProductId;
}

final class ProductDeleteCoordinator {
  const ProductDeleteCoordinator({
    required this.access,
    required this.receipts,
    required this.priceReceipts,
    required this.categoryReceipts,
  });

  final ProductDeleteAccess access;
  final ProductDeleteReceiptStore receipts;
  final ProductPriceReceiptStore priceReceipts;
  final ProductCategoriesReceiptStore categoryReceipts;

  void _check(String scope, String productId) {
    access.checkCurrent();

    if (scope.isEmpty ||
        productId.isEmpty ||
        access.scope != scope ||
        access.productId != productId) {
      throw StateError('PRODUCT_DELETE_SCOPE_CHANGED');
    }
  }

  Future<T> _withWriteLocks<T>(String scope, Future<T> Function() operation) {
    // Deletion spans all three existing product writers in this process.
    return withProjectWriteLock('product-master:$scope', () {
      return withProjectWriteLock('product-prices:$scope', () {
        return withProjectWriteLock('product-categories:$scope', () {
          return operation();
        });
      });
    });
  }

  Future<ProductDeleteReceipt?> outstanding() async {
    final scope = access.scope;
    final productId = access.productId;

    final receipt = await _outstanding(scope, productId);

    if (receipt == null) {
      await _checkOtherReceipts(scope, productId);
    }

    return receipt;
  }

  Future<ProductDeleteReceipt?> _outstanding(
    String scope,
    String productId,
  ) async {
    _check(scope, productId);

    final receipt = await receipts.read(scope);

    _check(scope, productId);

    if (receipt != null) {
      receipt.encode();

      if (receipt.scope != scope || receipt.input.id != productId) {
        throw const FormatException('PRODUCT_DELETE_RECEIPT_OWNER_MISMATCH');
      }
    }

    return receipt;
  }

  Future<void> _checkOtherReceipts(String scope, String productId) async {
    _check(scope, productId);

    final price = await priceReceipts.read(scope);

    _check(scope, productId);

    if (price != null) {
      price.encode();

      if (price.scope != scope || price.input.productId != productId) {
        throw const FormatException(
          'PRODUCT_DELETE_PRICE_RECEIPT_OWNER_MISMATCH',
        );
      }

      throw const ProductDeleteException(ProductDeleteFailure.outstanding);
    }

    final categories = await categoryReceipts.read(scope);

    _check(scope, productId);

    if (categories != null) {
      categories.encode();

      if (categories.scope != scope || categories.input.id != productId) {
        throw const FormatException(
          'PRODUCT_DELETE_CATEGORY_RECEIPT_OWNER_MISMATCH',
        );
      }

      throw const ProductDeleteException(ProductDeleteFailure.outstanding);
    }
  }

  Future<String> delete({
    required models.Product baseline,
    required bool confirmed,
  }) {
    final scope = access.scope;
    final productId = access.productId;

    _check(scope, productId);

    if (!confirmed) {
      throw const FormatException('PRODUCT_DELETE_CONFIRMATION_REQUIRED');
    }

    if (baseline.id != productId) {
      throw const FormatException('INVALID_PRODUCT_DELETE_BASELINE');
    }

    final snapshot = freezeProductDeleteBaseline(baseline);
    final input = models.ProductsDeleteInput(id: productId);

    access.checkDelete(input);

    return _withWriteLocks(scope, () {
      return _deleteLocked(scope, productId, input, snapshot);
    });
  }

  Future<String> _deleteLocked(
    String scope,
    String productId,
    models.ProductsDeleteInput input,
    models.Product baseline,
  ) async {
    if (await _outstanding(scope, productId) != null) {
      throw const ProductDeleteException(ProductDeleteFailure.outstanding);
    }

    await _checkOtherReceipts(scope, productId);
    access.checkDelete(input);

    final fresh = await access.getProduct(productId);

    _check(scope, productId);
    access.checkDelete(input);

    if (!sameProductDeleteBaseline(fresh, baseline)) {
      throw const ProductDeleteException(ProductDeleteFailure.conflict);
    }

    final receipt = ProductDeleteReceipt(
      scope: scope,
      nonce: _nonce(),
      createdAt: DateTime.now().toUtc(),
      input: input,
      baseline: baseline,
    );

    await _persist(scope, productId, receipt);

    try {
      // Stop dispatch if another journal became visible after intent persisted.
      await _checkOtherReceipts(scope, productId);
      access.checkDelete(input);

      final started = receipt.started();

      await _persist(scope, productId, started, previous: receipt);
      access.checkDelete(input);

      final result = await access.deleteProduct(input);

      _check(scope, productId);

      final acknowledged = started.confirmed(result);

      await _persist(scope, productId, acknowledged, previous: started);

      return await _finishAcknowledged(scope, productId, acknowledged);
    } catch (error) {
      if (error is ProductDeleteException &&
          error.failure == ProductDeleteFailure.cleanup) {
        rethrow;
      }

      throw ProductDeleteException(
        ProductDeleteFailure.uncertain,
        cause: error,
      );
    }
  }

  Future<void> _persist(
    String scope,
    String productId,
    ProductDeleteReceipt receipt, {
    ProductDeleteReceipt? previous,
  }) async {
    _check(scope, productId);

    final encoded = receipt.encode();

    final current = await _outstanding(scope, productId);

    if (receipt.scope != scope ||
        receipt.input.id != productId ||
        (previous == null && current != null) ||
        (previous != null && current?.encode() != previous.encode())) {
      throw const ProductDeleteException(ProductDeleteFailure.outstanding);
    }

    await receipts.write(receipt);

    _check(scope, productId);

    final persisted = await _outstanding(scope, productId);

    if (persisted?.encode() != encoded) {
      throw StateError('PRODUCT_DELETE_RECEIPT_NOT_PERSISTED');
    }
  }

  Future<String?> recover({required String expectedNonce}) {
    final scope = access.scope;
    final productId = access.productId;

    _check(scope, productId);

    return _withWriteLocks(scope, () async {
      final receipt = await _outstanding(scope, productId);

      if (receipt == null) {
        throw StateError('NO_PRODUCT_DELETE_RECEIPT');
      }

      if (receipt.nonce != expectedNonce) {
        throw const ProductDeleteException(ProductDeleteFailure.outstanding);
      }

      if (receipt.acknowledged) {
        return _finishAcknowledged(scope, productId, receipt);
      }

      if (receipt.dispatching) {
        throw const ProductDeleteException(ProductDeleteFailure.uncertain);
      }

      // Only an intent that never entered dispatch can be safely discarded.
      final current = await _outstanding(scope, productId);

      if (current?.encode() != receipt.encode()) {
        throw const ProductDeleteException(ProductDeleteFailure.outstanding);
      }

      await receipts.clear(scope);

      _check(scope, productId);

      if (await _outstanding(scope, productId) != null) {
        throw StateError('PRODUCT_DELETE_RECEIPT_NOT_CLEARED');
      }

      return null;
    });
  }

  Future<String> _finishAcknowledged(
    String scope,
    String productId,
    ProductDeleteReceipt receipt,
  ) async {
    _check(scope, productId);

    if (!receipt.acknowledged || receipt.dispatching) {
      throw const ProductDeleteException(ProductDeleteFailure.uncertain);
    }

    final id = receipt.input.id;

    try {
      final current = await _outstanding(scope, productId);

      if (current?.encode() != receipt.encode()) {
        throw StateError('PRODUCT_DELETE_RECEIPT_CHANGED');
      }

      await receipts.clear(scope);

      _check(scope, productId);

      if (await _outstanding(scope, productId) != null) {
        throw StateError('PRODUCT_DELETE_RECEIPT_NOT_CLEARED');
      }

      return id;
    } catch (error) {
      throw ProductDeleteException(
        ProductDeleteFailure.cleanup,
        cause: error,
        confirmedProductId: id,
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
