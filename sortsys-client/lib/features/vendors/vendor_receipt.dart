import 'dart:convert';

import '../../api/contract.dart' show jsonMap;
import '../../api/generated/models.g.dart' as models;
import '../../api/model.dart';
import '../../api/wire.dart';

final class VendorWriteReceipt {
  const VendorWriteReceipt({
    required this.scope,
    required this.nonce,
    required this.createdAt,
    this.createInput,
    this.updateInput,
    this.deleteInput,
    this.baseline,
    this.dispatching = false,
    this.creation,
    this.updateAcknowledgement,
    this.deletionAcknowledgement,
  });

  final String scope;
  final String nonce;
  final DateTime createdAt;
  final models.ProductsVendorsCreateInput? createInput;
  final models.ProductsVendorsUpdateInput? updateInput;
  final models.ProductsVendorsDeleteInput? deleteInput;
  final models.ProductVendor? baseline;
  final bool dispatching;
  final models.ProductsVendorsCreateOutput? creation;
  final models.ProductsVendorsUpdateOutput? updateAcknowledgement;
  final models.ProductsVendorsDeleteOutput? deletionAcknowledgement;

  bool get acknowledged {
    return creation != null ||
        updateAcknowledgement != null ||
        deletionAcknowledgement != null;
  }

  VendorWriteReceipt started() {
    if (dispatching || acknowledged) {
      throw StateError('INVALID_VENDOR_RECEIPT_STAGE');
    }

    return _copy(dispatching: true);
  }

  VendorWriteReceipt confirmedCreate(
    models.ProductsVendorsCreateOutput result,
  ) {
    if (createInput == null || !dispatching || acknowledged) {
      throw StateError('INVALID_VENDOR_RECEIPT_STAGE');
    }

    if (result.id.isEmpty) {
      throw const FormatException('INVALID_VENDOR_CREATE_ACKNOWLEDGEMENT');
    }

    return _copy(dispatching: false, creation: result);
  }

  VendorWriteReceipt confirmedUpdate(
    models.ProductsVendorsUpdateOutput result,
  ) {
    if (updateInput == null || !dispatching || acknowledged) {
      throw StateError('INVALID_VENDOR_RECEIPT_STAGE');
    }

    if (!result.success) {
      throw const FormatException('INVALID_VENDOR_UPDATE_ACKNOWLEDGEMENT');
    }

    return _copy(dispatching: false, updateAcknowledgement: result);
  }

  bool get deletionConfirmed {
    _validate();

    return deleteInput != null && deletionAcknowledgement?.success == true;
  }

  VendorWriteReceipt confirmedDelete(
    models.ProductsVendorsDeleteOutput result,
  ) {
    if (deleteInput == null || !dispatching || acknowledged) {
      throw StateError('INVALID_VENDOR_RECEIPT_STAGE');
    }

    if (!result.success) {
      throw const FormatException('INVALID_VENDOR_DELETE_ACKNOWLEDGEMENT');
    }

    return _copy(dispatching: false, deletionAcknowledgement: result);
  }

  VendorWriteReceipt _copy({
    required bool dispatching,
    models.ProductsVendorsCreateOutput? creation,
    models.ProductsVendorsUpdateOutput? updateAcknowledgement,
    models.ProductsVendorsDeleteOutput? deletionAcknowledgement,
  }) {
    return VendorWriteReceipt(
      scope: scope,
      nonce: nonce,
      createdAt: createdAt,
      createInput: createInput,
      updateInput: updateInput,
      deleteInput: deleteInput,
      baseline: baseline,
      dispatching: dispatching,
      creation: creation,
      updateAcknowledgement: updateAcknowledgement,
      deletionAcknowledgement: deletionAcknowledgement,
    );
  }

  String encode() {
    _validate();

    final encoded = jsonEncode(
      serializeWire({
        'version': 2,
        'scope': scope,
        'nonce': nonce,
        'createdAt': createdAt,
        'createInput': encodeRpcValue(createInput),
        'updateInput': encodeRpcValue(updateInput),
        'deleteInput': encodeRpcValue(deleteInput),
        'baseline': encodeRpcValue(baseline),
        'dispatching': dispatching,
        'creation': encodeRpcValue(creation),
        'updateAcknowledgement': encodeRpcValue(updateAcknowledgement),
        'deletionAcknowledgement': encodeRpcValue(deletionAcknowledgement),
      }),
    );
    _checkSize(encoded);

    return encoded;
  }

  factory VendorWriteReceipt.decode(String encoded) {
    _checkSize(encoded);

    final data = readRpcObject(
      deserializeWire(jsonMap(jsonDecode(encoded))),
      _receiptFields,
    );
    final version = data['version'];
    final fields = version == 1 ? _legacyReceiptFields : _receiptFields;
    readRpcLiteral(version, version == 1 ? 1 : 2);

    if (data.length != fields.length || !fields.every(data.containsKey)) {
      throw const FormatException('INVALID_VENDOR_RECEIPT');
    }

    final receipt = VendorWriteReceipt(
      scope: readRpcString(data['scope']),
      nonce: readRpcString(data['nonce']),
      createdAt: readRpcDate(data['createdAt']),
      createInput: readRpcNullable(
        data['createInput'],
        models.ProductsVendorsCreateInput.fromWire,
      ),
      updateInput: readRpcNullable(
        data['updateInput'],
        models.ProductsVendorsUpdateInput.fromWire,
      ),
      deleteInput: readRpcNullable(
        data['deleteInput'],
        models.ProductsVendorsDeleteInput.fromWire,
      ),
      baseline: readRpcNullable(
        data['baseline'],
        models.ProductVendor.fromWire,
      ),
      dispatching: readRpcBoolean(data['dispatching']),
      creation: readRpcNullable(
        data['creation'],
        models.ProductsVendorsCreateOutput.fromWire,
      ),
      updateAcknowledgement: readRpcNullable(
        data['updateAcknowledgement'],
        models.ProductsVendorsUpdateOutput.fromWire,
      ),
      deletionAcknowledgement: readRpcNullable(
        data['deletionAcknowledgement'],
        models.ProductsVendorsDeleteOutput.fromWire,
      ),
    );
    receipt._validate();

    return receipt;
  }

  void _validate() {
    final operations = <Object?>[createInput, updateInput, deleteInput];
    final kinds = operations.where((input) {
      return input != null;
    }).length;

    if (scope.isEmpty ||
        !RegExp(r'^[0-9a-f]{32}$').hasMatch(nonce) ||
        createdAt.year < 100 ||
        kinds != 1) {
      throw const FormatException('INVALID_VENDOR_RECEIPT');
    }

    if ((dispatching && acknowledged) ||
        creation?.id.isEmpty == true ||
        updateAcknowledgement?.success == false ||
        deletionAcknowledgement?.success == false) {
      throw const FormatException('INVALID_VENDOR_RECEIPT_STAGE');
    }

    final create = createInput;
    final update = updateInput;
    final deletion = deleteInput;
    final original = baseline;

    if (create != null) {
      if (original != null ||
          updateAcknowledgement != null ||
          deletionAcknowledgement != null) {
        throw const FormatException('INVALID_VENDOR_CREATE_RECEIPT');
      }

      _checkFields(create.name, create.description);
    } else if (update != null) {
      if (original == null ||
          update.id.isEmpty ||
          original.id != update.id ||
          creation != null ||
          deletionAcknowledgement != null ||
          !update.data.name.hasValue) {
        throw const FormatException('INVALID_VENDOR_UPDATE_RECEIPT');
      }

      _checkFields(update.data.name.valueOrNull, update.data.description);
    } else if (deletion != null) {
      if (original == null ||
          deletion.id.isEmpty ||
          original.id != deletion.id ||
          creation != null ||
          updateAcknowledgement != null) {
        throw const FormatException('INVALID_VENDOR_DELETE_RECEIPT');
      }
    }
  }

  bool confirms(models.ProductVendor vendor) {
    _validate();

    final create = createInput;
    final update = updateInput;
    final original = baseline;

    if (create != null) {
      final id = creation?.id;

      // Similar rows never establish ownership of an unacknowledged creation.
      return id != null &&
          vendor.id == id &&
          vendor.name == create.name &&
          vendor.description == create.description.valueOrNull;
    }

    if (update == null ||
        original == null ||
        (!dispatching && updateAcknowledgement == null)) {
      return false;
    }

    // Updates recover only the already known target; they never dispatch again.
    return vendor.id == update.id &&
        vendor.name == update.data.name.valueOrNull &&
        vendor.description == update.data.description.valueOrNull &&
        vendor.createdAt.isAtSameMomentAs(original.createdAt) &&
        !vendor.modifiedAt.isBefore(original.modifiedAt);
  }
}

const _legacyReceiptFields = {
  'version',
  'scope',
  'nonce',
  'createdAt',
  'createInput',
  'updateInput',
  'baseline',
  'dispatching',
  'creation',
  'updateAcknowledgement',
};

const _receiptFields = {
  ..._legacyReceiptFields,
  'deleteInput',
  'deletionAcknowledgement',
};

abstract interface class VendorReceiptStore {
  Future<VendorWriteReceipt?> read(String scope);

  Future<void> write(VendorWriteReceipt receipt);

  Future<void> clear(String scope);
}

bool sameVendorSnapshot(models.ProductVendor left, models.ProductVendor right) {
  return left.id == right.id &&
      left.name == right.name &&
      left.description == right.description &&
      left.createdAt.isAtSameMomentAs(right.createdAt) &&
      left.modifiedAt.isAtSameMomentAs(right.modifiedAt);
}

void _checkFields(String? name, RpcOptional<String?> description) {
  final value = description.valueOrNull;

  if (name == null ||
      name.isEmpty ||
      name != name.trim() ||
      utf8.encode(name).length > 127 ||
      !description.hasValue ||
      (value != null &&
          (value.isEmpty ||
              value != value.trim() ||
              utf8.encode(value).length > 255))) {
    throw const FormatException('INVALID_VENDOR_RECEIPT_INPUT');
  }
}

void _checkSize(String encoded) {
  if (utf8.encode(encoded).length > 131072) {
    throw const FormatException('VENDOR_RECEIPT_TOO_LARGE');
  }
}
