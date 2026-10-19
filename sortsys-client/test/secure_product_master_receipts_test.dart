import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/features/products/product_draft.dart';
import 'package:sortsys_client/features/products/product_master_receipt.dart';
import 'package:sortsys_client/features/products/secure_product_master_receipts.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    // Plugin operations use only this in-memory mock, never operator storage.
    FlutterSecureStorage.setMockInitialValues({});
  });

  test(
    'secure product receipts roundtrip create and edit durable stages',
    () async {
      final store = SecureProductMasterReceipts();

      for (final update in [false, true]) {
        final prepared = _receipt('origin|tenant|äctor', update: update);
        final started = prepared.started();
        final confirmed = update
            ? started.confirmedUpdate(
                const models.ProductsUpdateOutput(success: true),
              )
            : started.confirmedCreate(
                const models.ProductsCreateOutput(id: 'product'),
              );

        for (final receipt in [prepared, started, confirmed]) {
          await store.write(receipt);

          expect((await store.read(receipt.scope))!.encode(), receipt.encode());
        }
      }
    },
  );

  test(
    'secure product receipts isolate actors and targets with local cleanup',
    () async {
      FlutterSecureStorage.setMockInitialValues({'unrelated': 'preserved'});
      final store = SecureProductMasterReceipts();
      final first = _receipt('origin|tenant|actor|create');
      final target = _receipt('origin|tenant|actor|product');
      final other = _receipt('origin|tenant|other|product');

      await store.write(first);
      await store.write(target);
      await store.write(other);
      await store.clear(first.scope);

      expect(await store.read(first.scope), isNull);
      expect((await store.read(target.scope))!.scope, target.scope);
      expect((await store.read(other.scope))!.scope, other.scope);
      expect(
        await const FlutterSecureStorage().read(key: 'unrelated'),
        'preserved',
      );
    },
  );

  test(
    'secure product receipts reject foreign malformed oversized or empty scope',
    () async {
      const scope = 'origin|tenant|actor';
      final key =
          'sortsys.product_master_write.v1.${base64UrlEncode(utf8.encode(scope))}';
      final store = SecureProductMasterReceipts();

      for (final value in [
        _receipt('foreign').encode(),
        '{bad',
        List.filled(131073, 'x').join(),
      ]) {
        FlutterSecureStorage.setMockInitialValues({key: value});

        await expectLater(store.read(scope), throwsFormatException);
      }

      await expectLater(store.read(''), throwsFormatException);
      await expectLater(store.clear(''), throwsFormatException);
    },
  );
}

ProductMasterWriteReceipt _receipt(String scope, {bool update = false}) {
  final draft = ProductDraft(
    productId: update ? 'product' : null,
    customId: '10',
    name: 'Product',
    baseUnit: 'kg',
    units: const [ProductUnitDraft(name: 'box', amount: '2')],
  );

  return ProductMasterWriteReceipt(
    scope: scope,
    nonce: '0123456789abcdef0123456789abcdef',
    createdAt: DateTime.utc(2024),
    createInput: update ? null : draft.createInput(),
    updateInput: update ? draft.updateInput() : null,
    baseline: update
        ? models.Product(
            id: 'product',
            customId: 10,
            name: 'Before',
            baseUnit: 'kg',
            otherUnits: models.ApplyPriceImportRowOtherUnits({'box': 1}),
            categories: [],
          )
        : null,
  );
}
