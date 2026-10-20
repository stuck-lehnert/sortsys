import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'product_categories_receipt.dart';

final class SecureProductCategoriesReceipts
    implements ProductCategoriesReceiptStore {
  SecureProductCategoriesReceipts()
    : _storage = const FlutterSecureStorage(
        iOptions: IOSOptions(
          accessibility: KeychainAccessibility.first_unlock_this_device,
        ),
      );

  final FlutterSecureStorage _storage;

  String _key(String scope) {
    if (scope.isEmpty) {
      throw const FormatException('EMPTY_PRODUCT_CATEGORIES_RECEIPT_SCOPE');
    }

    final encoded = base64UrlEncode(utf8.encode(scope));

    return 'sortsys.product_categories_write.v1.$encoded';
  }

  @override
  Future<ProductCategoriesWriteReceipt?> read(String scope) async {
    final encoded = await _storage.read(key: _key(scope));

    if (encoded == null) {
      return null;
    }

    final receipt = ProductCategoriesWriteReceipt.decode(encoded);

    if (receipt.scope != scope) {
      throw const FormatException('PRODUCT_CATEGORIES_RECEIPT_SCOPE_MISMATCH');
    }

    return receipt;
  }

  @override
  Future<void> write(ProductCategoriesWriteReceipt receipt) async {
    final encoded = receipt.encode();

    await _storage.write(key: _key(receipt.scope), value: encoded);
  }

  @override
  Future<void> clear(String scope) async {
    await _storage.delete(key: _key(scope));
  }
}
