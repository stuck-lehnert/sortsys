import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/features/products/product_categories_receipt.dart';
import 'package:sortsys_client/features/products/secure_product_categories_receipts.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    // Only this in-memory plugin mock is used, never operator storage.
    FlutterSecureStorage.setMockInitialValues({});
  });

  test(
    'secure category receipts roundtrip raw selections and all durable stages',
    () async {
      final store = SecureProductCategoriesReceipts();
      final prepared = _receipt('origin|tenant|äctor|product');
      final started = prepared.started();
      final confirmed = started.confirmed(
        const models.ProductsCategoriesSetOutput(success: true),
      );

      for (final receipt in [prepared, started, confirmed]) {
        await store.write(receipt);

        final stored = (await store.read(receipt.scope))!;

        expect(stored.encode(), receipt.encode());
        expect(stored.input.categories, [' New ', 'new']);
        expect(
          await const FlutterSecureStorage().read(key: _key(receipt.scope)),
          receipt.encode(),
        );
      }
    },
  );

  test(
    'secure category receipts isolate actors products and targeted cleanup',
    () async {
      FlutterSecureStorage.setMockInitialValues({'unrelated': 'preserved'});
      final store = SecureProductCategoriesReceipts();
      final first = _receipt('origin|tenant|actor|product');
      final target = _receipt('origin|tenant|actor|other', productId: 'other');
      final actor = _receipt('origin|tenant|other|product');

      await store.write(first);
      await store.write(target);
      await store.write(actor);
      await store.clear(first.scope);

      expect(await store.read(first.scope), isNull);
      expect((await store.read(target.scope))!.input.id, 'other');
      expect((await store.read(actor.scope))!.scope, actor.scope);
      expect(
        await const FlutterSecureStorage().read(key: 'unrelated'),
        'preserved',
      );
    },
  );

  test(
    'secure category receipts reject foreign corrupt oversized and empty scopes',
    () async {
      const scope = 'origin|tenant|actor|product';
      final store = SecureProductCategoriesReceipts();

      for (final value in [
        _receipt('foreign').encode(),
        '{bad',
        List.filled(131073, 'x').join(),
      ]) {
        FlutterSecureStorage.setMockInitialValues({_key(scope): value});

        await expectLater(store.read(scope), throwsFormatException);
      }

      await expectLater(store.read(''), throwsFormatException);
      await expectLater(store.clear(''), throwsFormatException);
    },
  );

  test(
    'invalid category receipt writes leave the previous scoped intent intact',
    () async {
      const scope = 'origin|tenant|actor|product';
      final store = SecureProductCategoriesReceipts();
      final previous = _receipt(scope);

      await store.write(previous);

      for (final receipt in [
        _receipt(scope, nonce: 'invalid'),
        _receipt(scope, baseline: [List.filled(70000, 'ä').join()]),
      ]) {
        await expectLater(store.write(receipt), throwsFormatException);

        expect((await store.read(scope))!.encode(), previous.encode());
      }
    },
  );
}

String _key(String scope) {
  final encoded = base64UrlEncode(utf8.encode(scope));

  return 'sortsys.product_categories_write.v1.$encoded';
}

ProductCategoriesWriteReceipt _receipt(
  String scope, {
  String productId = 'product',
  String nonce = '0123456789abcdef0123456789abcdef',
  List<String> baseline = const ['Old'],
}) {
  return ProductCategoriesWriteReceipt(
    scope: scope,
    nonce: nonce,
    createdAt: DateTime.utc(2026, 1, 2),
    input: models.ProductsCategoriesSetInput(
      id: productId,
      categories: [' New ', 'new'],
    ),
    baselineCategories: baseline,
  );
}
