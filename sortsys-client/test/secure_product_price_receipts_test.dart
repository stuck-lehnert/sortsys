import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/api/model.dart';
import 'package:sortsys_client/features/products/product_price_receipt.dart';
import 'package:sortsys_client/features/products/secure_product_price_receipts.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    // All plugin operations below use only this in-memory platform mock.
    FlutterSecureStorage.setMockInitialValues({});
  });

  test(
    'secure price receipts preserve prepared dispatch and acknowledged stages',
    () async {
      final store = SecureProductPriceReceipts();
      final prepared = _receipt('origin|tenant|actor|product');
      final started = prepared.started();
      final confirmed = started.confirmed(
        const models.ProductsPriceRecordsCreateOutput(id: 'price'),
      );

      expect(await store.read(prepared.scope), isNull);

      for (final receipt in [prepared, started, confirmed]) {
        await store.write(receipt);
        final loaded = (await store.read(receipt.scope))!;

        expect(loaded.encode(), receipt.encode());
      }
    },
  );

  test(
    'secure price receipts isolate scopes and clear only the selected owner',
    () async {
      final store = SecureProductPriceReceipts();
      final first = _receipt('origin|tenant|actor|product');
      final second = _receipt('origin|tenant|other actor|product');

      await store.write(first);
      await store.write(second);
      await store.clear(first.scope);

      expect(await store.read(first.scope), isNull);
      expect((await store.read(second.scope))!.scope, second.scope);
    },
  );

  test('secure price receipts reject wrong-owner and malformed stored data', () async {
    const scope = 'origin|tenant|actor|product';
    final key =
        'sortsys.product_price_write.v1.${base64UrlEncode(utf8.encode(scope))}';
    final store = SecureProductPriceReceipts();
    FlutterSecureStorage.setMockInitialValues({
      key: _receipt('other').encode(),
    });

    await expectLater(store.read(scope), throwsFormatException);
    FlutterSecureStorage.setMockInitialValues({key: '{bad'});

    await expectLater(store.read(scope), throwsFormatException);
    FlutterSecureStorage.setMockInitialValues({
      key: List.filled(131073, 'x').join(),
    });

    await expectLater(store.read(scope), throwsFormatException);
  });
}

ProductPriceWriteReceipt _receipt(String scope) {
  return ProductPriceWriteReceipt(
    scope: scope,
    nonce: '0123456789abcdef0123456789abcdef',
    createdAt: DateTime.utc(2024),
    input: models.ProductsPriceRecordsCreateInput(
      productId: 'product',
      pricePerBaseUnit: 5,
      timestamp: DateTime.utc(2024),
      isRealPurchase: false,
      comment: const RpcOptional.value(''),
    ),
  );
}
