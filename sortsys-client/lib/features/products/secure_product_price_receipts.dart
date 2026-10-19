import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'product_price_receipt.dart';

final class SecureProductPriceReceipts implements ProductPriceReceiptStore {
  SecureProductPriceReceipts()
    : _storage = const FlutterSecureStorage(
        iOptions: IOSOptions(
          accessibility: KeychainAccessibility.first_unlock_this_device,
        ),
      );

  final FlutterSecureStorage _storage;

  String _key(String scope) {
    final encoded = base64UrlEncode(utf8.encode(scope));

    return 'sortsys.product_price_write.v1.$encoded';
  }

  @override
  Future<ProductPriceWriteReceipt?> read(String scope) async {
    final encoded = await _storage.read(key: _key(scope));

    if (encoded == null) {
      return null;
    }

    final receipt = ProductPriceWriteReceipt.decode(encoded);

    if (receipt.scope != scope) {
      throw const FormatException('PRODUCT_PRICE_RECEIPT_SCOPE_MISMATCH');
    }

    return receipt;
  }

  @override
  Future<void> write(ProductPriceWriteReceipt receipt) async {
    final encoded = receipt.encode();

    await _storage.write(key: _key(receipt.scope), value: encoded);
  }

  @override
  Future<void> clear(String scope) async {
    await _storage.delete(key: _key(scope));
  }
}
