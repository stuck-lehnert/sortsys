import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'tool_draft.dart' show isToolScalarText;
import 'tool_receipt.dart';

final class SecureToolReceipts implements ToolReceiptStore {
  SecureToolReceipts()
    : _storage = const FlutterSecureStorage(
        iOptions: IOSOptions(
          accessibility: KeychainAccessibility.first_unlock_this_device,
        ),
      );

  final FlutterSecureStorage _storage;

  String _key(String scope) {
    if (scope.isEmpty || !isToolScalarText(scope)) {
      throw const FormatException('INVALID_TOOL_RECEIPT_SCOPE');
    }

    return 'sortsys.tool_write.v1.${base64UrlEncode(utf8.encode(scope))}';
  }

  @override
  Future<ToolWriteReceipt?> read(String scope) async {
    final encoded = await _storage.read(key: _key(scope));

    if (encoded == null) {
      return null;
    }

    final receipt = ToolWriteReceipt.decode(encoded);

    if (receipt.scope != scope) {
      throw const FormatException('TOOL_RECEIPT_SCOPE_MISMATCH');
    }

    return receipt;
  }

  @override
  Future<void> write(ToolWriteReceipt receipt) async {
    final encoded = receipt.encode();

    final current = await read(receipt.scope);

    if (current == null) {
      if (receipt.dispatching || receipt.acknowledged) {
        throw const FormatException('TOOL_RECEIPT_INTENT_REQUIRED');
      }
    } else {
      final unchanged = current.encode() == encoded;
      String? next;

      if (!current.dispatching && !current.acknowledged) {
        next = current.started().encode();
      } else if (current.dispatching) {
        final creation = receipt.creation;
        final update = receipt.updateAcknowledgement;

        if (current.createInput != null && creation != null) {
          next = current.confirmedCreate(creation).encode();
        } else if (current.updateInput != null && update != null) {
          next = current.confirmedUpdate(update).encode();
        }
      }

      if (!unchanged && encoded != next) {
        throw const FormatException('TOOL_RECEIPT_CHANGED');
      }
    }

    await _storage.write(key: _key(receipt.scope), value: encoded);
  }

  @override
  Future<void> clear(String scope) async {
    await _storage.delete(key: _key(scope));
  }
}
