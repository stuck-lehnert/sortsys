import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/features/products/product_delete_coordinator.dart';
import 'package:sortsys_client/features/products/product_delete_receipt.dart';
import 'package:sortsys_client/features/products/product_draft.dart';
import 'package:sortsys_client/features/products/product_master_receipt.dart';
import 'package:sortsys_client/features/products/product_master_write_access.dart';
import 'package:sortsys_client/features/products/product_master_write_coordinator.dart';
import 'package:sortsys_client/features/products/secure_product_categories_receipts.dart';
import 'package:sortsys_client/features/products/secure_product_delete_receipts.dart';
import 'package:sortsys_client/features/products/secure_product_master_receipts.dart';
import 'package:sortsys_client/features/products/secure_product_price_receipts.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    // Receipt I/O remains in this in-memory plugin, never native storage.
    FlutterSecureStorage.setMockInitialValues({});
  });

  test(
    'secure product delete receipts persist all three forward stages',
    () async {
      final store = SecureProductDeleteReceipts();
      final prepared = _receipt('origin|tenant|äctor|product');
      final started = prepared.started();
      final acknowledged = started.confirmed(
        const models.ProductsDeleteOutput(success: true),
      );

      for (final receipt in [prepared, started, acknowledged]) {
        await store.write(receipt);

        expect((await store.read(receipt.scope))!.encode(), receipt.encode());
        expect(
          await const FlutterSecureStorage().read(key: _key(receipt.scope)),
          receipt.encode(),
        );
      }
    },
  );

  test(
    'secure product delete receipts isolate actors and targets with local cleanup',
    () async {
      FlutterSecureStorage.setMockInitialValues({'unrelated': 'preserved'});

      final store = SecureProductDeleteReceipts();
      final first = _receipt('origin|tenant|actor|product');
      final other = _receipt('origin|tenant|other|product');
      final target = _receipt(
        'origin|tenant|actor|other-product',
        productId: 'other-product',
      );

      await store.write(first);
      await store.write(other);
      await store.write(target);
      await store.clear(first.scope);

      expect(await store.read(first.scope), isNull);
      expect((await store.read(other.scope))!.encode(), other.encode());
      expect((await store.read(target.scope))!.encode(), target.encode());
      expect((await store.read(target.scope))!.input.id, 'other-product');
      expect(
        await const FlutterSecureStorage().read(key: 'unrelated'),
        'preserved',
      );
    },
  );

  test(
    'secure product delete receipts reject invalid scopes and envelopes',
    () async {
      const scope = 'origin|tenant|actor|product';
      final store = SecureProductDeleteReceipts();

      for (final encoded in [
        _receipt('foreign').encode(),
        '{bad',
        List.filled(131073, 'x').join(),
      ]) {
        FlutterSecureStorage.setMockInitialValues({_key(scope): encoded});

        await expectLater(store.read(scope), throwsFormatException);
        expect(
          await const FlutterSecureStorage().read(key: _key(scope)),
          encoded,
        );
      }

      await expectLater(store.read(''), throwsFormatException);
      await expectLater(store.clear(''), throwsFormatException);
    },
  );

  test(
    'invalid product delete writes retain the existing scoped intent',
    () async {
      const scope = 'origin|tenant|actor|product';
      final store = SecureProductDeleteReceipts();
      final previous = _receipt(scope);

      await store.write(previous);

      for (final receipt in [
        _receipt(scope, nonce: 'invalid'),
        _receipt(scope, name: List.filled(70000, 'ä').join()),
      ]) {
        await expectLater(store.write(receipt), throwsFormatException);
        expect((await store.read(scope))!.encode(), previous.encode());
      }
    },
  );

  test(
    'existing product master edit journal blocks deletion without dispatch',
    () async {
      const scope = 'origin|tenant|actor|product';
      final oldStore = SecureProductMasterReceipts();
      final deleteStore = SecureProductDeleteReceipts();
      final legacy = _legacy(scope);
      final access = _DeleteAccess(scope);
      final coordinator = ProductDeleteCoordinator(
        access: access,
        receipts: deleteStore,
        priceReceipts: SecureProductPriceReceipts(),
        categoryReceipts: SecureProductCategoriesReceipts(),
      );

      await oldStore.write(legacy);

      await expectLater(deleteStore.read(scope), throwsFormatException);
      await expectLater(
        deleteStore.write(_receipt(scope)),
        throwsFormatException,
      );
      await expectLater(
        coordinator.delete(baseline: _product(), confirmed: true),
        throwsFormatException,
      );
      expect(access.reads, 0);
      expect(access.writes, 0);
      expect((await oldStore.read(scope))!.encode(), legacy.encode());
      expect(
        await const FlutterSecureStorage().read(key: _key(scope)),
        legacy.encode(),
      );
    },
  );

  test(
    'pending product deletion blocks actual existing edit coordinator',
    () async {
      const scope = 'origin|tenant|actor|product';
      final deleteStore = SecureProductDeleteReceipts();
      final oldStore = SecureProductMasterReceipts();
      final pending = _receipt(scope).started();
      final access = _WriteAccess(scope);
      final coordinator = ProductMasterWriteCoordinator(
        access: access,
        receipts: oldStore,
      );

      await deleteStore.write(_receipt(scope));
      await deleteStore.write(pending);

      await expectLater(oldStore.read(scope), throwsFormatException);
      await expectLater(
        coordinator.save(
          ProductDraft(
            productId: 'product',
            customId: '10',
            name: 'Changed',
            baseUnit: 'kg',
            units: const [ProductUnitDraft(name: 'box', amount: '2')],
          ),
          baseline: _product(),
        ),
        throwsFormatException,
      );
      expect(access.writes, 0);
      expect((await deleteStore.read(scope))!.encode(), pending.encode());
    },
  );

  test(
    'product delete storage rejects skipped stages regressions and new owners',
    () async {
      const scope = 'origin|tenant|actor|product';
      final store = SecureProductDeleteReceipts();
      final prepared = _receipt(scope);
      final started = prepared.started();
      final acknowledged = started.confirmed(
        const models.ProductsDeleteOutput(success: true),
      );

      await expectLater(store.write(started), throwsFormatException);
      await expectLater(store.write(acknowledged), throwsFormatException);
      expect(await store.read(scope), isNull);

      await store.write(prepared);

      await expectLater(
        store.write(_receipt(scope, nonce: 'ffffffffffffffffffffffffffffffff')),
        throwsFormatException,
      );
      await expectLater(store.write(acknowledged), throwsFormatException);
      expect((await store.read(scope))!.encode(), prepared.encode());

      await store.write(started);

      await expectLater(store.write(prepared), throwsFormatException);
      expect((await store.read(scope))!.encode(), started.encode());

      await store.write(acknowledged);
      await store.write(acknowledged);

      await expectLater(store.write(started), throwsFormatException);
      expect((await store.read(scope))!.encode(), acknowledged.encode());
    },
  );
}

String _key(String scope) {
  return 'sortsys.product_master_write.v1.${base64UrlEncode(utf8.encode(scope))}';
}

models.Product _product({String id = 'product', String name = 'Product'}) {
  return models.Product(
    id: id,
    customId: 10,
    name: name,
    baseUnit: 'kg',
    otherUnits: const models.ApplyPriceImportRowOtherUnits({'box': 2}),
    categories: const ['original'],
  );
}

ProductDeleteReceipt _receipt(
  String scope, {
  String nonce = '0123456789abcdef0123456789abcdef',
  String name = 'Product',
  String productId = 'product',
}) {
  return ProductDeleteReceipt(
    scope: scope,
    nonce: nonce,
    createdAt: DateTime.utc(2024, 3),
    input: models.ProductsDeleteInput(id: productId),
    baseline: _product(id: productId, name: name),
  );
}

ProductMasterWriteReceipt _legacy(String scope) {
  final draft = ProductDraft(
    productId: 'product',
    customId: '10',
    name: 'Changed',
    baseUnit: 'kg',
    units: const [ProductUnitDraft(name: 'box', amount: '2')],
  );

  return ProductMasterWriteReceipt(
    scope: scope,
    nonce: '0123456789abcdef0123456789abcdef',
    createdAt: DateTime.utc(2024, 3),
    updateInput: draft.updateInput(),
    baseline: _product(),
  );
}

final class _DeleteAccess implements ProductDeleteAccess {
  _DeleteAccess(this.scope);

  @override
  String get productId {
    return 'product';
  }

  @override
  final String scope;

  int reads = 0;
  int writes = 0;

  @override
  void checkCurrent() {
    // Domain fixture; no session or authentication is replaced.
  }

  @override
  void checkDelete(models.ProductsDeleteInput input) {
    checkCurrent();
  }

  @override
  Future<models.Product> getProduct(String id) async {
    reads++;

    return _product();
  }

  @override
  Future<models.ProductsDeleteOutput> deleteProduct(
    models.ProductsDeleteInput input,
  ) async {
    writes++;

    return const models.ProductsDeleteOutput(success: true);
  }
}

final class _WriteAccess implements ProductMasterWriteAccess {
  _WriteAccess(this.scope);

  @override
  final String scope;

  int writes = 0;

  @override
  void checkCurrent() {
    // The actual existing coordinator owns write and journal decisions.
  }

  @override
  void checkCreate(models.ProductsCreateInput input) {
    checkCurrent();
  }

  @override
  void checkUpdate(models.ProductsUpdateInput input) {
    checkCurrent();
  }

  @override
  Future<models.Product?> getProduct(String id) async {
    return _product();
  }

  @override
  Future<models.ProductsCreateOutput> createProduct(
    models.ProductsCreateInput input,
  ) async {
    writes++;

    return const models.ProductsCreateOutput(id: 'unexpected-create');
  }

  @override
  Future<models.ProductsUpdateOutput> updateProduct(
    models.ProductsUpdateInput input,
  ) async {
    writes++;

    return const models.ProductsUpdateOutput(success: true);
  }
}
