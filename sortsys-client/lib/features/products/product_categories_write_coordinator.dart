import 'dart:math';

import '../../api/generated/models.g.dart' as models;
import '../projects/project_write_lock.dart';
import 'product_categories_draft.dart';
import 'product_categories_inputs.dart';
import 'product_categories_receipt.dart';
import 'product_categories_write_access.dart';

enum ProductCategoriesWriteFailure { outstanding, conflict, uncertain, cleanup }

final class ProductCategoriesWriteException implements Exception {
  const ProductCategoriesWriteException(
    this.failure, {
    this.cause,
    this.confirmedProduct,
  });

  final ProductCategoriesWriteFailure failure;
  final Object? cause;
  final models.Product? confirmedProduct;
}

final class ProductCategoriesWriteCoordinator {
  const ProductCategoriesWriteCoordinator({
    required this.access,
    required this.receipts,
  });

  final ProductCategoriesWriteAccess access;
  final ProductCategoriesReceiptStore receipts;

  void _check(String scope, String productId) {
    access.checkCurrent();

    if (scope.isEmpty ||
        productId.isEmpty ||
        access.scope != scope ||
        access.productId != productId) {
      throw StateError('PRODUCT_CATEGORIES_WRITE_SCOPE_CHANGED');
    }
  }

  Future<ProductCategoriesWriteReceipt?> outstanding() {
    return _outstanding(access.scope, access.productId);
  }

  Future<ProductCategoriesWriteReceipt?> _outstanding(
    String scope,
    String productId,
  ) async {
    _check(scope, productId);

    final receipt = await receipts.read(scope);

    _check(scope, productId);

    if (receipt != null) {
      receipt.encode();

      if (receipt.scope != scope || receipt.input.id != productId) {
        throw const FormatException(
          'PRODUCT_CATEGORIES_RECEIPT_OWNER_MISMATCH',
        );
      }
    }

    return receipt;
  }

  Future<models.Product> save(
    ProductCategoriesDraft draft, {
    required models.Product baseline,
  }) async {
    final scope = access.scope;
    final productId = access.productId;

    _check(scope, productId);

    final input = draft.setInput();
    final baselineCategories = List<String>.unmodifiable(baseline.categories);

    if (input.id != productId || baseline.id != productId) {
      throw const FormatException('INVALID_PRODUCT_CATEGORIES_BASELINE');
    }

    access.checkSet(input);

    return withProjectWriteLock('product-categories:$scope', () {
      return _saveLocked(scope, productId, input, baselineCategories);
    });
  }

  Future<models.Product> _saveLocked(
    String scope,
    String productId,
    models.ProductsCategoriesSetInput input,
    List<String> baselineCategories,
  ) async {
    if (await _outstanding(scope, productId) != null) {
      throw const ProductCategoriesWriteException(
        ProductCategoriesWriteFailure.outstanding,
      );
    }

    access.checkSet(input);

    final fresh = await access.getProduct(productId);

    _check(scope, productId);
    access.checkSet(input);

    if (fresh == null ||
        fresh.id != productId ||
        !sameProductCategoryValues(fresh.categories, baselineCategories)) {
      throw const ProductCategoriesWriteException(
        ProductCategoriesWriteFailure.conflict,
      );
    }

    if (productCategoriesInputMatches(input, fresh)) {
      return fresh;
    }

    final receipt = ProductCategoriesWriteReceipt(
      scope: scope,
      nonce: _operationNonce(),
      createdAt: DateTime.now().toUtc(),
      input: input,
      baselineCategories: fresh.categories,
    );

    await _persist(scope, productId, receipt);

    try {
      access.checkSet(input);

      final started = receipt.started();

      await _persist(scope, productId, started);

      access.checkSet(input);

      final result = await access.setCategories(input);

      _check(scope, productId);

      final confirmed = started.confirmed(result);

      await _persist(scope, productId, confirmed);

      return await _verifyAndClear(scope, productId, confirmed);
    } catch (error) {
      if (error is ProductCategoriesWriteException &&
          error.failure == ProductCategoriesWriteFailure.cleanup) {
        rethrow;
      }

      throw ProductCategoriesWriteException(
        ProductCategoriesWriteFailure.uncertain,
        cause: error,
      );
    }
  }

  Future<void> _persist(
    String scope,
    String productId,
    ProductCategoriesWriteReceipt receipt,
  ) async {
    _check(scope, productId);

    final encoded = receipt.encode();

    if (receipt.scope != scope || receipt.input.id != productId) {
      throw const FormatException('PRODUCT_CATEGORIES_RECEIPT_OWNER_MISMATCH');
    }

    await receipts.write(receipt);

    _check(scope, productId);

    final stored = await _outstanding(scope, productId);

    if (stored == null || stored.encode() != encoded) {
      throw StateError('PRODUCT_CATEGORIES_RECEIPT_NOT_DURABLE');
    }
  }

  Future<models.Product?> recover({required String expectedNonce}) async {
    final scope = access.scope;
    final productId = access.productId;

    _check(scope, productId);

    return withProjectWriteLock('product-categories:$scope', () async {
      final receipt = await _outstanding(scope, productId);

      if (receipt == null) {
        throw StateError('NO_PRODUCT_CATEGORIES_RECEIPT');
      }

      if (receipt.nonce != expectedNonce) {
        throw const ProductCategoriesWriteException(
          ProductCategoriesWriteFailure.outstanding,
        );
      }

      try {
        if (!receipt.dispatching && !receipt.acknowledged) {
          await _clear(scope, productId, receipt.nonce);

          return null;
        }

        return await _verifyAndClear(scope, productId, receipt);
      } catch (error) {
        if (error is ProductCategoriesWriteException &&
            error.failure == ProductCategoriesWriteFailure.cleanup) {
          rethrow;
        }

        throw ProductCategoriesWriteException(
          ProductCategoriesWriteFailure.uncertain,
          cause: error,
        );
      }
    });
  }

  Future<models.Product> _verifyAndClear(
    String scope,
    String productId,
    ProductCategoriesWriteReceipt receipt,
  ) async {
    _check(scope, productId);

    final product = await access.getProduct(productId);

    _check(scope, productId);

    if (product == null || !receipt.confirms(product)) {
      throw StateError('PRODUCT_CATEGORIES_WRITE_NOT_CONFIRMED');
    }

    // A verified state remains a success even if local journal cleanup fails.
    try {
      await _clear(scope, productId, receipt.nonce);
    } catch (error) {
      _check(scope, productId);

      throw ProductCategoriesWriteException(
        ProductCategoriesWriteFailure.cleanup,
        cause: error,
        confirmedProduct: product,
      );
    }

    _check(scope, productId);

    return product;
  }

  Future<void> _clear(String scope, String productId, String nonce) async {
    final current = await _outstanding(scope, productId);

    if (current == null) {
      return;
    }

    if (current.nonce != nonce) {
      throw const ProductCategoriesWriteException(
        ProductCategoriesWriteFailure.outstanding,
      );
    }

    await receipts.clear(scope);

    _check(scope, productId);

    if (await _outstanding(scope, productId) != null) {
      throw StateError('PRODUCT_CATEGORIES_RECEIPT_NOT_CLEARED');
    }
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
