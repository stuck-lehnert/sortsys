import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/api.g.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/api/procedure.dart';
import 'package:sortsys_client/features/products/product_price_form_reads.dart';

void main() {
  test('price vendor lookup preserves exact query order and immutable results', () async {
    final source = [_vendor('two', 'Zinc'), _vendor('one', ' Alpha ')];
    final requests = <(String, Object?)>[];
    final reads = ProductPriceFormReads(
      productId: 'product',
      isCurrent: () {
        return true;
      },
      can: _permissions().contains,
      read: <I, O>(RpcQuery<I, O> query, I input) async {
        expect(query, same(ApiQueries.productsVendorsList));
        requests.add((query.path, (input as models.ProductsVendorsListInput).toWire()));

        return source as O;
      },
    );

    final result = await reads.vendors('  AlP  ');
    await reads.vendors('');

    expect(requests[0].$1, 'products.vendors.list');
    expect(requests[0].$2, {'search': '  AlP  '});
    expect(requests[1].$2, {'search': ''});
    expect(result.map((vendor) => vendor.name), ['Zinc', ' Alpha ']);
    source.clear();

    expect(result, hasLength(2));
    expect(() => result.clear(), throwsUnsupportedError);
  });

  test('price vendor lookup checks actual page entry and vendor roles before I/O', () async {
    for (final removed in _permissions()) {
      final permissions = _permissions()..remove(removed);
      var calls = 0;
      final reads = ProductPriceFormReads(
        productId: 'product',
        isCurrent: () {
          return true;
        },
        can: permissions.contains,
        read: <I, O>(RpcQuery<I, O> query, I input) async {
          calls++;

          return <models.ProductVendor>[] as O;
        },
      );

      await expectLater(reads.vendors(''), throwsStateError);

      expect(calls, 0);
    }

    var calls = 0;
    final invalid = ProductPriceFormReads(
      productId: '',
      isCurrent: () {
        return true;
      },
      can: _permissions().contains,
      read: <I, O>(RpcQuery<I, O> query, I input) async {
        calls++;

        return <models.ProductVendor>[] as O;
      },
    );

    await expectLater(invalid.vendors(''), throwsFormatException);

    expect(calls, 0);
  });

  test('price vendor lookup rejects owner and role changes after await', () async {
    for (final changed in ['owner', ..._permissions()]) {
      final permissions = _permissions();
      final result = Completer<List<models.ProductVendor>>();
      var current = true;
      final reads = ProductPriceFormReads(
        productId: 'product',
        isCurrent: () {
          return current;
        },
        can: permissions.contains,
        read: <I, O>(RpcQuery<I, O> query, I input) async {
          return await result.future as O;
        },
      );
      final pending = reads.vendors('vendor');
      final assertion = expectLater(pending, throwsStateError);

      if (changed == 'owner') {
        current = false;
      } else {
        permissions.remove(changed);
      }

      result.complete([_vendor('one', 'Vendor')]);
      await assertion;
    }
  });
}

Set<String> _permissions() {
  // The UI entry role differs from the backend's legacy create-role check.
  return {
    'view:products',
    'manage:productPriceRecords',
    'view:productVendors',
  };
}

models.ProductVendor _vendor(String id, String name) {
  return models.ProductVendor(
    id: id,
    name: name,
    createdAt: DateTime.utc(2024),
    modifiedAt: DateTime.utc(2024),
  );
}
