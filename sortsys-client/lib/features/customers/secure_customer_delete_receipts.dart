import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'customer_delete_receipt.dart';

final class SecureCustomerDeleteReceipts implements CustomerDeleteReceiptStore {
  SecureCustomerDeleteReceipts()
    : _storage = const FlutterSecureStorage(
        iOptions: IOSOptions(
          accessibility: KeychainAccessibility.first_unlock_this_device,
        ),
      );

  final FlutterSecureStorage _storage;

  String _key(String scope) {
    if (scope.isEmpty) {
      throw const FormatException('EMPTY_CUSTOMER_RECEIPT_SCOPE');
    }

    // Sharing the actor journal prevents delete and create/edit from overlapping.
    return 'sortsys.customer_write.v1.${base64UrlEncode(utf8.encode(scope))}';
  }

  @override
  Future<CustomerDeleteReceipt?> read(String scope) async {
    final encoded = await _storage.read(key: _key(scope));

    if (encoded == null) {
      return null;
    }

    // Existing create/edit envelopes fail closed rather than being overwritten.
    final receipt = CustomerDeleteReceipt.decode(encoded);

    if (receipt.scope != scope) {
      throw const FormatException('CUSTOMER_DELETE_RECEIPT_SCOPE_MISMATCH');
    }

    return receipt;
  }

  @override
  Future<void> write(CustomerDeleteReceipt receipt) async {
    final encoded = receipt.encode();

    // Validate before any storage access and permit only durable forward stages.
    final current = await read(receipt.scope);

    if (current == null) {
      if (receipt.dispatching || receipt.acknowledged) {
        throw const FormatException('CUSTOMER_DELETE_INTENT_REQUIRED');
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
        throw const FormatException('CUSTOMER_DELETE_RECEIPT_CHANGED');
      }
    }

    await _storage.write(key: _key(receipt.scope), value: encoded);
  }

  @override
  Future<void> clear(String scope) async {
    await _storage.delete(key: _key(scope));
  }
}
