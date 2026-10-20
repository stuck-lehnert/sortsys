import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../../api/model.dart';
import 'customer_draft.dart';
import 'customer_write.dart';

final class SecureCustomerReceipts implements CustomerReceiptStore {
  SecureCustomerReceipts()
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

    return 'sortsys.customer_write.v1.${base64UrlEncode(utf8.encode(scope))}';
  }

  CustomerWriteReceipt _decode(String encoded) {
    if (utf8.encode(encoded).length > 131072) {
      throw const FormatException('CUSTOMER_RECEIPT_TOO_LARGE');
    }

    const fields = {
      'version',
      'scope',
      'nonce',
      'stage',
      'target',
      'createInput',
      'updateInput',
      'customerId',
      'contactIds',
      'baselineContactIds',
    };

    final data = readRpcObject(jsonDecode(encoded), fields);

    if (data.length != fields.length || !fields.every(data.containsKey)) {
      throw const FormatException('INVALID_CUSTOMER_RECEIPT_ENVELOPE');
    }

    late CustomerWriteReceipt receipt;

    try {
      receipt = CustomerWriteReceipt.decode(encoded);
    } on ArgumentError {
      throw const FormatException('INVALID_CUSTOMER_RECEIPT_STAGE');
    }

    final target = receipt.target;
    final canonical = CustomerDraft(
      name: target.name,
      salutation: target.salutation.valueOrNull,
      address: target.address.valueOrNull,
      phoneNumbers: target.phoneNumbers.valueOrNull ?? const [],
      emailAddresses: target.emailAddresses.valueOrNull ?? const [],
    ).createInput();
    final targetFields = target.toWire();
    final create = receipt.createInput;
    final update = receipt.updateInput;
    final selected = receipt.contactIds;
    final previous = receipt.baselineContactIds;

    if (!RegExp(r'^[0-9a-f]{32}$').hasMatch(receipt.nonce) ||
        !_same(targetFields, canonical.toWire()) ||
        (create != null && !_same(create.toWire(), targetFields)) ||
        (create == null && update == null && selected == null) ||
        ((selected == null) != (previous == null))) {
      throw const FormatException('INVALID_CUSTOMER_RECEIPT_INTENT');
    }

    if (update != null) {
      final changes = update.data.toWire();

      if (changes.isEmpty ||
          changes.entries.any((entry) {
            return !targetFields.containsKey(entry.key) ||
                !_same(entry.value, targetFields[entry.key]);
          })) {
        throw const FormatException('INVALID_CUSTOMER_RECEIPT_UPDATE');
      }
    }

    for (final ids in [selected, previous]) {
      if (ids != null &&
          (ids.any((id) {
                return id.isEmpty;
              }) ||
              ids.toSet().length != ids.length)) {
        throw const FormatException('INVALID_CUSTOMER_RECEIPT_CONTACT_IDS');
      }
    }

    return receipt;
  }

  bool _same(Object? left, Object? right) {
    return jsonEncode(left) == jsonEncode(right);
  }

  @override
  Future<CustomerWriteReceipt?> read(String scope) async {
    final encoded = await _storage.read(key: _key(scope));

    if (encoded == null) {
      return null;
    }

    final receipt = _decode(encoded);

    if (receipt.scope != scope) {
      throw const FormatException('CUSTOMER_RECEIPT_SCOPE_MISMATCH');
    }

    return receipt;
  }

  @override
  Future<void> write(CustomerWriteReceipt receipt) async {
    final encoded = receipt.encode();

    _decode(encoded);

    await _storage.write(key: _key(receipt.scope), value: encoded);
  }

  @override
  Future<void> clear(String scope) async {
    await _storage.delete(key: _key(scope));
  }
}
