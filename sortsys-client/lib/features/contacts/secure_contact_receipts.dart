import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'contact_receipt.dart';

final class SecureContactReceipts implements ContactReceiptStore {
  SecureContactReceipts()
    : _storage = const FlutterSecureStorage(
        iOptions: IOSOptions(
          accessibility: KeychainAccessibility.first_unlock_this_device,
        ),
      );

  final FlutterSecureStorage _storage;

  String _key(String scope) {
    if (scope.isEmpty) {
      throw const FormatException('EMPTY_CONTACT_RECEIPT_SCOPE');
    }

    final encoded = base64UrlEncode(utf8.encode(scope));

    return 'sortsys.contact_write.v1.$encoded';
  }

  @override
  Future<ContactWriteReceipt?> read(String scope) async {
    final encoded = await _storage.read(key: _key(scope));

    if (encoded == null) {
      return null;
    }

    final receipt = ContactWriteReceipt.decode(encoded);

    if (receipt.scope != scope) {
      throw const FormatException('CONTACT_RECEIPT_SCOPE_MISMATCH');
    }

    return receipt;
  }

  @override
  Future<void> write(ContactWriteReceipt receipt) async {
    final encoded = receipt.encode();

    await _storage.write(key: _key(receipt.scope), value: encoded);
  }

  @override
  Future<void> clear(String scope) async {
    await _storage.delete(key: _key(scope));
  }
}
