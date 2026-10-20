import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'product_delete_receipt.dart';

final class SecureProductDeleteReceipts implements ProductDeleteReceiptStore {
  SecureProductDeleteReceipts()
    : _storage = const FlutterSecureStorage(
        iOptions: IOSOptions(
          accessibility: KeychainAccessibility.first_unlock_this_device,
        ),
      );

  final FlutterSecureStorage _storage;

  String _key(String scope) {
    if (scope.isEmpty) {
      throw const FormatException('EMPTY_PRODUCT_RECEIPT_SCOPE');
    }

    // Sharing the product-master journal blocks incompatible edits and deletion.
    return 'sortsys.product_master_write.v1.${base64UrlEncode(utf8.encode(scope))}';
  }

  @override
  Future<ProductDeleteReceipt?> read(String scope) async {
    final encoded = await _storage.read(key: _key(scope));

    if (encoded == null) {
      return null;
    }

    // Existing master-write envelopes fail closed rather than being overwritten.
    final receipt = ProductDeleteReceipt.decode(encoded);

    if (receipt.scope != scope) {
      throw const FormatException('PRODUCT_DELETE_RECEIPT_SCOPE_MISMATCH');
    }

    return receipt;
  }

  @override
  Future<void> write(ProductDeleteReceipt receipt) async {
    final encoded = receipt.encode();

    // Validate before any storage access and permit only durable forward stages.
    final current = await read(receipt.scope);

    if (current == null) {
      if (receipt.dispatching || receipt.acknowledged) {
        throw const FormatException('PRODUCT_DELETE_INTENT_REQUIRED');
      }
    } else {
      final unchanged = current.encode() == encoded;
      String? next;

      if (!current.dispatching && !current.acknowledged) {
        next = current.started().encode();
      } else if (current.dispatching && receipt.acknowledgement != null) {
        next = current.confirmed(receipt.acknowledgement!).encode();
      }

      if (!unchanged && encoded != next) {
        throw const FormatException('PRODUCT_DELETE_RECEIPT_CHANGED');
      }
    }

    await _storage.write(key: _key(receipt.scope), value: encoded);
  }

  @override
  Future<void> clear(String scope) async {
    await _storage.delete(key: _key(scope));
  }
}
