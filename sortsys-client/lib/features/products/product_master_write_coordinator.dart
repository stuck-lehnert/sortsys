import 'dart:math';

import '../../api/generated/models.g.dart' as models;
import '../projects/project_write_lock.dart';
import 'product_draft.dart';
import 'product_master_receipt.dart';
import 'product_master_write_access.dart';

enum ProductMasterWriteFailure { outstanding, conflict, uncertain, cleanup }

final class ProductMasterWriteException implements Exception {
  const ProductMasterWriteException(
    this.failure, {
    this.cause,
    this.confirmedProduct,
  });

  final ProductMasterWriteFailure failure;
  final Object? cause;
  final models.Product? confirmedProduct;
}

final class ProductMasterWriteCoordinator {
  const ProductMasterWriteCoordinator({
    required this.access,
    required this.receipts,
  });

  final ProductMasterWriteAccess access;
  final ProductMasterReceiptStore receipts;

  void _check(String scope) {
    access.checkCurrent();

    if (scope.isEmpty || access.scope != scope) {
      throw StateError('PRODUCT_MASTER_WRITE_SCOPE_CHANGED');
    }
  }

  Future<ProductMasterWriteReceipt?> outstanding() {
    return _outstanding(access.scope);
  }

  Future<ProductMasterWriteReceipt?> _outstanding(String scope) async {
    _check(scope);

    final receipt = await receipts.read(scope);
    _check(scope);

    if (receipt != null) {
      receipt.encode();

      if (receipt.scope != scope) {
        throw const FormatException('PRODUCT_MASTER_RECEIPT_SCOPE_MISMATCH');
      }
    }

    return receipt;
  }

  Future<models.Product> save(
    ProductDraft draft, {
    models.Product? baseline,
  }) async {
    final scope = access.scope;
    _check(scope);

    final create = draft.productId == null ? draft.createInput() : null;
    final update = draft.productId == null ? null : draft.updateInput();

    if ((create != null && baseline != null) ||
        (update != null && (baseline == null || baseline.id != update.id))) {
      throw const FormatException('INVALID_PRODUCT_MASTER_BASELINE');
    }

    _checkWrite(create, update);

    return withProjectWriteLock('product-master:$scope', () {
      return _saveLocked(scope, create, update, baseline);
    });
  }

  void _checkWrite(
    models.ProductsCreateInput? create,
    models.ProductsUpdateInput? update,
  ) {
    if (create != null) {
      access.checkCreate(create);
    } else if (update != null) {
      access.checkUpdate(update);
    } else {
      throw const FormatException('INVALID_PRODUCT_MASTER_WRITE_KIND');
    }
  }

  Future<models.Product> _saveLocked(
    String scope,
    models.ProductsCreateInput? create,
    models.ProductsUpdateInput? update,
    models.Product? baseline,
  ) async {
    if (await _outstanding(scope) != null) {
      throw const ProductMasterWriteException(
        ProductMasterWriteFailure.outstanding,
      );
    }

    _checkWrite(create, update);

    if (update != null) {
      final fresh = await access.getProduct(update.id);
      _check(scope);
      access.checkUpdate(update);

      if (fresh == null ||
          baseline == null ||
          !sameProductMasterSnapshot(fresh, baseline)) {
        throw const ProductMasterWriteException(
          ProductMasterWriteFailure.conflict,
        );
      }

      if (productMasterUpdateMatches(update, fresh)) {
        return fresh;
      }
    }

    final receipt = ProductMasterWriteReceipt(
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

      final ProductMasterWriteReceipt confirmed;

      if (create != null) {
        final result = await access.createProduct(create);
        _check(scope);
        confirmed = started.confirmedCreate(result);
      } else {
        final result = await access.updateProduct(update!);
        _check(scope);
        confirmed = started.confirmedUpdate(result);
      }

      await _persist(scope, confirmed);

      return await _verifyAndClear(scope, confirmed);
    } catch (error) {
      if (error is ProductMasterWriteException &&
          error.failure == ProductMasterWriteFailure.cleanup) {
        rethrow;
      }

      throw ProductMasterWriteException(
        ProductMasterWriteFailure.uncertain,
        cause: error,
      );
    }
  }

  Future<void> _persist(String scope, ProductMasterWriteReceipt receipt) async {
    _check(scope);
    receipt.encode();

    if (receipt.scope != scope) {
      throw const FormatException('PRODUCT_MASTER_RECEIPT_SCOPE_MISMATCH');
    }

    await receipts.write(receipt);
    _check(scope);
  }

  Future<models.Product?> recover({required String expectedNonce}) async {
    final scope = access.scope;
    _check(scope);

    return withProjectWriteLock('product-master:$scope', () async {
      final receipt = await _outstanding(scope);

      if (receipt == null) {
        throw StateError('NO_PRODUCT_MASTER_RECEIPT');
      }

      if (receipt.nonce != expectedNonce) {
        throw const ProductMasterWriteException(
          ProductMasterWriteFailure.outstanding,
        );
      }

      try {
        if (!receipt.dispatching && !receipt.acknowledged) {
          await receipts.clear(scope);
          _check(scope);

          return null;
        }

        return await _verifyAndClear(scope, receipt);
      } catch (error) {
        if (error is ProductMasterWriteException &&
            error.failure == ProductMasterWriteFailure.cleanup) {
          rethrow;
        }

        throw ProductMasterWriteException(
          ProductMasterWriteFailure.uncertain,
          cause: error,
        );
      }
    });
  }

  Future<models.Product> _verifyAndClear(
    String scope,
    ProductMasterWriteReceipt receipt,
  ) async {
    final id = receipt.creation?.id ?? receipt.updateInput?.id;

    if (id == null || id.isEmpty) {
      throw StateError('UNCONFIRMED_PRODUCT_MASTER_CREATION');
    }

    _check(scope);

    final product = await access.getProduct(id);
    _check(scope);

    if (product == null || !receipt.confirms(product)) {
      throw StateError('PRODUCT_MASTER_WRITE_NOT_CONFIRMED');
    }

    // Verified success must not become an invitation to repeat the mutation.
    try {
      await receipts.clear(scope);
    } catch (error) {
      _check(scope);

      throw ProductMasterWriteException(
        ProductMasterWriteFailure.cleanup,
        cause: error,
        confirmedProduct: product,
      );
    }

    _check(scope);

    return product;
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
