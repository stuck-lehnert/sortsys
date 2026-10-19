import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/api.g.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/api/model.dart';
import 'package:sortsys_client/api/procedure.dart';
import 'package:sortsys_client/features/products/product_read_repository.dart';

void main() {
  test('product detail uses the exact generated identifier request', () async {
    final reads = _ProductReads()..response = _product('product-1');
    final product = await _repository(reads).get();

    expect(product, same(reads.response));
    expect(reads.requests.single.$1, ApiQueries.productsGet.path);
    expect(reads.requests.single.$2, {'id': 'product-1'});
  });

  test('invalid, denied or stale product scope dispatches no request', () async {
    for (final scope in [
      (id: '', current: true, allowed: true),
      (id: 'product-1', current: false, allowed: true),
      (id: 'product-1', current: true, allowed: false),
    ]) {
      final reads = _ProductReads();
      final repository = _repository(
        reads,
        productId: scope.id,
        permissions: scope.allowed ? {'view:products'} : {},
        isCurrent: () {
          return scope.current;
        },
      );

      await expectLater(
        repository.get(),
        scope.id.isEmpty ? throwsFormatException : throwsStateError,
      );
      expect(reads.requests, isEmpty);
    }
  });

  test('wrong product detail response is rejected', () async {
    final reads = _ProductReads()..response = _product('another-product');

    await expectLater(_repository(reads).get(), throwsFormatException);
  });

  test('awaited product rejects changed session or revoked visibility', (
  ) async {
    for (final changeSession in [true, false]) {
      final pending = Completer<Object?>();
      final reads = _ProductReads()..response = pending.future;
      final permissions = {'view:products'};
      var current = true;
      final repository = _repository(
        reads,
        permissions: permissions,
        isCurrent: () {
          return current;
        },
      );
      final result = repository.get();

      if (changeSession) {
        current = false;
      } else {
        permissions.clear();
      }

      pending.complete(_product('product-1'));
      await expectLater(result, throwsStateError);
    }
  });

  test('price records use only the actual product filter and immutable rows', (
  ) async {
    final source = [_price('product-1')];
    final reads = _ProductReads()..response = source;
    final records = await _repository(
      reads,
      permissions: {'view:products', 'view:productPriceRecords'},
    ).priceRecords();

    expect(reads.requests.single.$1, ApiQueries.productsPriceRecordsList.path);
    expect(reads.requests.single.$2, {'productId': 'product-1'});
    expect(records.single, same(source.single));
    expect(() => records.add(_price('product-1')), throwsUnsupportedError);
    expect(source, hasLength(1));
  });

  test('prices require current owner and price visibility before and after', (
  ) async {
    final denied = _ProductReads();
    await expectLater(_repository(denied).priceRecords(), throwsStateError);
    expect(denied.requests, isEmpty);

    for (final change in ['owner', 'prices', 'session']) {
      final pending = Completer<Object?>();
      final reads = _ProductReads()..response = pending.future;
      final permissions = {'view:products', 'view:productPriceRecords'};
      var current = true;
      final repository = _repository(
        reads,
        permissions: permissions,
        isCurrent: () {
          return current;
        },
      );
      final result = repository.priceRecords();

      if (change == 'owner') {
        permissions.remove('view:products');
      } else if (change == 'prices') {
        permissions.remove('view:productPriceRecords');
      } else {
        current = false;
      }

      pending.complete([_price('product-1')]);
      await expectLater(result, throwsStateError);
    }
  });

  test('price vendor references require actual visibility and exact input', (
  ) async {
    final denied = _ProductReads()..response = _vendor('vendor-1');
    await expectLater(
      _repository(
        denied,
        permissions: {'view:products', 'view:productPriceRecords'},
      ).vendorReference('vendor-1'),
      throwsStateError,
    );
    expect(denied.requests, isEmpty);

    final reads = _ProductReads()..response = _vendor('vendor-1');
    final vendor = await _repository(
      reads,
      permissions: {
        'view:products', 'view:productPriceRecords', 'view:productVendors',
      },
    ).vendorReference('vendor-1');

    expect(vendor, same(reads.response));
    expect(reads.requests.single.$1, ApiQueries.productsVendorsGet.path);
    expect(reads.requests.single.$2, {'id': 'vendor-1'});
  });

  test('price vendor references reject changed owner, roles or session', (
  ) async {
    for (final change in [
      'view:products', 'view:productPriceRecords', 'view:productVendors', 'session',
    ]) {
      final pending = Completer<Object?>();
      final reads = _ProductReads()..response = pending.future;
      final permissions = {
        'view:products', 'view:productPriceRecords', 'view:productVendors',
      };
      var current = true;
      final repository = _repository(
        reads,
        permissions: permissions,
        isCurrent: () {
          return current;
        },
      );
      final result = repository.vendorReference('vendor-1');

      if (change == 'session') {
        current = false;
      } else {
        permissions.remove(change);
      }

      pending.complete(_vendor('vendor-1'));
      await expectLater(result, throwsStateError);
    }
  });

  test('price vendor references reject empty and mismatched identifiers', (
  ) async {
    final reads = _ProductReads()..response = _vendor('other-vendor');
    final repository = _repository(
      reads,
      permissions: {
        'view:products', 'view:productPriceRecords', 'view:productVendors',
      },
    );

    await expectLater(repository.vendorReference(''), throwsFormatException);
    expect(reads.requests, isEmpty);
    await expectLater(
      repository.vendorReference('vendor-1'),
      throwsFormatException,
    );
  });

  test('price records reject another product without silently filtering it', (
  ) async {
    final reads = _ProductReads()
      ..response = [_price('product-1'), _price('another-product')];

    await expectLater(
      _repository(
        reads,
        permissions: {'view:products', 'view:productPriceRecords'},
      ).priceRecords(),
      throwsFormatException,
    );
  });
}

ProductReadRepository _repository(
  _ProductReads reads, {
  String productId = 'product-1',
  Set<String>? permissions,
  bool Function()? isCurrent,
}) {
  final allowed = permissions ?? {'view:products'};

  return ProductReadRepository(
    productId: productId,
    read: reads.read,
    isCurrent: isCurrent ?? () {
      return true;
    },
    can: allowed.contains,
  );
}

final class _ProductReads {
  Object? response;
  final requests = <(String, Object?)>[];

  Future<O> read<I, O>(RpcQuery<I, O> query, I input) async {
    requests.add((query.path, encodeRpcValue(input)));

    final value = response;

    if (value is Future<Object?>) {
      return await value as O;
    }

    return value as O;
  }
}

models.Product _product(String id) {
  return models.Product(
    id: id,
    customId: 12,
    name: 'Cement',
    baseUnit: 'kg',
    otherUnits: const models.ApplyPriceImportRowOtherUnits({}),
    categories: const [],
  );
}

models.ProductVendor _vendor(String id) {
  return models.ProductVendor(
    id: id,
    name: 'Harbor supplies',
    createdAt: DateTime.utc(2026, 1, 1),
    modifiedAt: DateTime.utc(2026, 1, 1),
  );
}

models.ProductsPriceRecordsListResultItem _price(String productId) {
  return models.ProductsPriceRecordsListResultItem(
    id: 'price-1',
    productId: productId,
    timestamp: DateTime.utc(2026, 1, 1),
    price: 0,
    isRealPurchase: true,
  );
}
