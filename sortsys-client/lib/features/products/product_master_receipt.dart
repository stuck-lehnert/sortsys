import 'dart:convert';

import '../../api/contract.dart' show jsonMap;
import '../../api/generated/models.g.dart' as models;
import '../../api/model.dart';
import '../../api/wire.dart';
import 'product_master_inputs.dart';

final class ProductMasterWriteReceipt {
  ProductMasterWriteReceipt({
    required this.scope,
    required this.nonce,
    required this.createdAt,
    models.ProductsCreateInput? createInput,
    models.ProductsUpdateInput? updateInput,
    models.Product? baseline,
    this.dispatching = false,
    this.creation,
    this.updateAcknowledgement,
  }) : createInput = createInput == null ? null : _copyCreate(createInput),
       updateInput = updateInput == null ? null : _copyUpdate(updateInput),
       baseline = baseline == null ? null : _copyProduct(baseline);

  final String scope;
  final String nonce;
  final DateTime createdAt;
  final models.ProductsCreateInput? createInput;
  final models.ProductsUpdateInput? updateInput;
  final models.Product? baseline;
  final bool dispatching;
  final models.ProductsCreateOutput? creation;
  final models.ProductsUpdateOutput? updateAcknowledgement;

  bool get acknowledged {
    return creation != null || updateAcknowledgement != null;
  }

  ProductMasterWriteReceipt started() {
    if (dispatching || acknowledged) {
      throw StateError('INVALID_PRODUCT_MASTER_RECEIPT_STAGE');
    }

    return _copy(dispatching: true);
  }

  ProductMasterWriteReceipt confirmedCreate(
    models.ProductsCreateOutput result,
  ) {
    if (createInput == null || !dispatching || acknowledged) {
      throw StateError('INVALID_PRODUCT_MASTER_RECEIPT_STAGE');
    }

    if (result.id.isEmpty) {
      throw const FormatException('INVALID_PRODUCT_MASTER_CREATE_ACK');
    }

    return _copy(dispatching: false, creation: result);
  }

  ProductMasterWriteReceipt confirmedUpdate(
    models.ProductsUpdateOutput result,
  ) {
    if (updateInput == null || !dispatching || acknowledged) {
      throw StateError('INVALID_PRODUCT_MASTER_RECEIPT_STAGE');
    }

    if (!result.success) {
      throw const FormatException('INVALID_PRODUCT_MASTER_UPDATE_ACK');
    }

    return _copy(dispatching: false, updateAcknowledgement: result);
  }

  ProductMasterWriteReceipt _copy({
    required bool dispatching,
    models.ProductsCreateOutput? creation,
    models.ProductsUpdateOutput? updateAcknowledgement,
  }) {
    return ProductMasterWriteReceipt(
      scope: scope,
      nonce: nonce,
      createdAt: createdAt,
      createInput: createInput,
      updateInput: updateInput,
      baseline: baseline,
      dispatching: dispatching,
      creation: creation,
      updateAcknowledgement: updateAcknowledgement,
    );
  }

  String encode() {
    _validate();

    final encoded = jsonEncode(
      serializeWire({
        'version': 1,
        'scope': scope,
        'nonce': nonce,
        'createdAt': createdAt,
        'createInput': encodeRpcValue(createInput),
        'updateInput': encodeRpcValue(updateInput),
        'baseline': encodeRpcValue(baseline),
        'dispatching': dispatching,
        'creation': encodeRpcValue(creation),
        'updateAcknowledgement': encodeRpcValue(updateAcknowledgement),
      }),
    );
    _checkSize(encoded);

    return encoded;
  }

  factory ProductMasterWriteReceipt.decode(String encoded) {
    _checkSize(encoded);

    final data = readRpcObject(
      deserializeWire(jsonMap(jsonDecode(encoded))),
      _receiptFields,
    );
    readRpcLiteral(data['version'], 1);

    if (data.length != _receiptFields.length ||
        !_receiptFields.every(data.containsKey)) {
      throw const FormatException('INVALID_PRODUCT_MASTER_RECEIPT');
    }

    final receipt = ProductMasterWriteReceipt(
      scope: readRpcString(data['scope']),
      nonce: readRpcString(data['nonce']),
      createdAt: readRpcDate(data['createdAt']),
      createInput: readRpcNullable(
        data['createInput'],
        models.ProductsCreateInput.fromWire,
      ),
      updateInput: readRpcNullable(
        data['updateInput'],
        models.ProductsUpdateInput.fromWire,
      ),
      baseline: readRpcNullable(data['baseline'], models.Product.fromWire),
      dispatching: readRpcBoolean(data['dispatching']),
      creation: readRpcNullable(
        data['creation'],
        models.ProductsCreateOutput.fromWire,
      ),
      updateAcknowledgement: readRpcNullable(
        data['updateAcknowledgement'],
        models.ProductsUpdateOutput.fromWire,
      ),
    );
    receipt._validate();

    return receipt;
  }

  void _validate() {
    if (scope.isEmpty ||
        !RegExp(r'^[0-9a-f]{32}$').hasMatch(nonce) ||
        createdAt.year < 100 ||
        (createInput == null) == (updateInput == null)) {
      throw const FormatException('INVALID_PRODUCT_MASTER_RECEIPT');
    }

    if ((dispatching && acknowledged) ||
        creation?.id.isEmpty == true ||
        updateAcknowledgement?.success == false) {
      throw const FormatException('INVALID_PRODUCT_MASTER_RECEIPT_STAGE');
    }

    final create = createInput;
    final update = updateInput;
    final original = baseline;

    if (create != null) {
      if (original != null || updateAcknowledgement != null) {
        throw const FormatException('INVALID_PRODUCT_MASTER_CREATE_RECEIPT');
      }

      checkProductMasterCreateInput(create);
    } else if (update != null) {
      if (original == null ||
          original.id.isEmpty ||
          original.id != update.id ||
          creation != null ||
          !original.customId.isFinite ||
          original.customId < 0 ||
          original.customId > 2147483647 ||
          original.customId != original.customId.truncateToDouble()) {
        throw const FormatException('INVALID_PRODUCT_MASTER_UPDATE_RECEIPT');
      }

      checkProductMasterUpdateInput(update);
    }
  }

  bool confirms(models.Product product) {
    _validate();

    final create = createInput;
    final update = updateInput;
    final original = baseline;

    if (create != null) {
      // Similar rows never establish ownership without the actual create ID.
      return creation?.id == product.id &&
          product.customId == create.customId &&
          _matchesFields(
            product,
            create.name,
            create.baseUnit,
            create.brand,
            create.description,
            create.regieReportName,
            create.otherUnits.value,
          );
    }

    return update != null &&
        original != null &&
        (dispatching || updateAcknowledgement != null) &&
        product.customId == original.customId &&
        productMasterUpdateMatches(update, product);
  }
}

const _receiptFields = {
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

abstract interface class ProductMasterReceiptStore {
  Future<ProductMasterWriteReceipt?> read(String scope);

  Future<void> write(ProductMasterWriteReceipt receipt);

  Future<void> clear(String scope);
}

bool productMasterUpdateMatches(
  models.ProductsUpdateInput input,
  models.Product product,
) {
  checkProductMasterUpdateInput(input);

  final data = input.data;

  return product.id == input.id &&
      _matchesFields(
        product,
        data.name.value,
        data.baseUnit.value,
        data.brand,
        data.description,
        data.regieReportName,
        data.otherUnits.value,
      );
}

bool sameProductMasterSnapshot(models.Product left, models.Product right) {
  // Category membership belongs to a separate workflow, not this form payload.
  return left.id == right.id &&
      left.customId == right.customId &&
      left.name == right.name &&
      left.brand == right.brand &&
      left.description == right.description &&
      left.regieReportName == right.regieReportName &&
      left.baseUnit == right.baseUnit &&
      _sameUnits(left.otherUnits.values, right.otherUnits.values);
}

bool _matchesFields(
  models.Product product,
  String name,
  String baseUnit,
  RpcOptional<String?> brand,
  RpcOptional<String?> description,
  RpcOptional<String?> regieReportName,
  models.ApplyPriceImportRowOtherUnits units,
) {
  return product.name == name &&
      product.baseUnit == baseUnit &&
      product.brand == brand.valueOrNull &&
      product.description == description.valueOrNull &&
      product.regieReportName == regieReportName.valueOrNull &&
      _sameUnits(product.otherUnits.values, units.values);
}

bool _sameUnits(Map<String, num> left, Map<String, num> right) {
  if (left.length != right.length) {
    return false;
  }

  for (final entry in left.entries) {
    if (!right.containsKey(entry.key) || right[entry.key] != entry.value) {
      return false;
    }
  }

  return true;
}

models.ProductsCreateInput _copyCreate(models.ProductsCreateInput input) {
  return models.ProductsCreateInput(
    customId: input.customId,
    name: input.name,
    baseUnit: input.baseUnit,
    brand: input.brand,
    description: input.description,
    regieReportName: input.regieReportName,
    otherUnits: _copyUnits(input.otherUnits),
  );
}

models.ProductsUpdateInput _copyUpdate(models.ProductsUpdateInput input) {
  final data = input.data;

  return models.ProductsUpdateInput(
    id: input.id,
    data: models.ProductsUpdateRequestData(
      customId: data.customId,
      name: data.name,
      brand: data.brand,
      description: data.description,
      regieReportName: data.regieReportName,
      baseUnit: data.baseUnit,
      otherUnits: _copyUnits(data.otherUnits),
    ),
  );
}

RpcOptional<models.ApplyPriceImportRowOtherUnits> _copyUnits(
  RpcOptional<models.ApplyPriceImportRowOtherUnits> units,
) {
  return switch (units.presence) {
    RpcPresence.absent => const RpcOptional.absent(),
    RpcPresence.undefined => const RpcOptional.undefined(),
    RpcPresence.value => RpcOptional.value(
      models.ApplyPriceImportRowOtherUnits(
        Map.unmodifiable(units.value.values),
      ),
    ),
  };
}

models.Product _copyProduct(models.Product product) {
  return models.Product(
    id: product.id,
    customId: product.customId,
    name: product.name,
    brand: product.brand,
    description: product.description,
    regieReportName: product.regieReportName,
    baseUnit: product.baseUnit,
    otherUnits: models.ApplyPriceImportRowOtherUnits(
      Map.unmodifiable(product.otherUnits.values),
    ),
    categories: List.unmodifiable(product.categories),
  );
}

void _checkSize(String encoded) {
  if (utf8.encode(encoded).length > 131072) {
    throw const FormatException('PRODUCT_MASTER_RECEIPT_TOO_LARGE');
  }
}
