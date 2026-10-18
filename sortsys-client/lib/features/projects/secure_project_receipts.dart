import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'project_receipt.dart';

final class SecureProjectReceipts implements ProjectReceiptStore {
  SecureProjectReceipts()
    : _storage = const FlutterSecureStorage(
        iOptions: IOSOptions(
          accessibility: KeychainAccessibility.first_unlock_this_device,
        ),
      );

  final FlutterSecureStorage _storage;

  String _key(String scope) {
    final encoded = base64UrlEncode(utf8.encode(scope));

    return 'sortsys.project_write.v1.$encoded';
  }

  @override
  Future<ProjectWriteReceipt?> read(String scope) async {
    final encoded = await _storage.read(key: _key(scope));

    if (encoded == null) {
      return null;
    }

    final receipt = ProjectWriteReceipt.decode(encoded);

    if (receipt.scope != scope) {
      throw const FormatException('PROJECT_RECEIPT_SCOPE_MISMATCH');
    }

    return receipt;
  }

  @override
  Future<void> write(ProjectWriteReceipt receipt) async {
    final encoded = receipt.encode();

    await _storage.write(key: _key(receipt.scope), value: encoded);
  }

  @override
  Future<void> clear(String scope) async {
    await _storage.delete(key: _key(scope));
  }
}
