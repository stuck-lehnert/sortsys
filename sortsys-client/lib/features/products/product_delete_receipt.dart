import 'dart:convert';

import '../../api/contract.dart' show jsonMap;
import '../../api/generated/models.g.dart' as models;
import '../../api/model.dart';
import '../../api/wire.dart';

final class ProductDeleteReceipt {
  ProductDeleteReceipt({
    required this.scope,
    required this.nonce,
    required this.createdAt,
    required models.ProductsDeleteInput input,
    required models.Product baseline,
    this.dispatching = false,
    this.acknowledgement,
  }) : input = models.ProductsDeleteInput(id: input.id),
       baseline = freezeProductDeleteBaseline(baseline);

  final String scope;
  final String nonce;
  final DateTime createdAt;
  final models.ProductsDeleteInput input;
  final models.Product baseline;
  final bool dispatching;
  final models.ProductsDeleteOutput? acknowledgement;

  bool get acknowledged {
    return acknowledgement != null;
  }

  ProductDeleteReceipt started() {
    _validate();

    if (dispatching || acknowledged) {
      throw StateError('INVALID_PRODUCT_DELETE_RECEIPT_STAGE');
    }

    return _copy(dispatching: true);
  }

  ProductDeleteReceipt confirmed(models.ProductsDeleteOutput result) {
    _validate();

    if (!dispatching || acknowledged) {
      throw StateError('INVALID_PRODUCT_DELETE_RECEIPT_STAGE');
    }

    if (!result.success) {
      throw const FormatException('INVALID_PRODUCT_DELETE_ACK');
    }

    return _copy(dispatching: false, acknowledgement: result);
  }

  ProductDeleteReceipt _copy({
    required bool dispatching,
    models.ProductsDeleteOutput? acknowledgement,
  }) {
    return ProductDeleteReceipt(
      scope: scope,
      nonce: nonce,
      createdAt: createdAt,
      input: input,
      baseline: baseline,
      dispatching: dispatching,
      acknowledgement: acknowledgement,
    );
  }

  String encode() {
    _validate();

    final encoded = jsonEncode(
      serializeWire({
        'version': 2,
        'operation': 'delete',
        'scope': scope,
        'nonce': nonce,
        'createdAt': createdAt,
        'input': encodeRpcValue(input),
        'baseline': encodeRpcValue(baseline),
        'dispatching': dispatching,
        'acknowledgement': encodeRpcValue(acknowledgement),
      }),
    );

    _checkSize(encoded);

    return encoded;
  }

  factory ProductDeleteReceipt.decode(String encoded) {
    _checkSize(encoded);

    final data = readRpcObject(
      deserializeWire(jsonMap(jsonDecode(encoded))),
      _fields,
    );

    readRpcLiteral(data['version'], 2);
    readRpcLiteral(data['operation'], 'delete');

    if (data.length != _fields.length || !_fields.every(data.containsKey)) {
      throw const FormatException('INVALID_PRODUCT_DELETE_RECEIPT');
    }

    final receipt = ProductDeleteReceipt(
      scope: readRpcString(data['scope']),
      nonce: readRpcString(data['nonce']),
      createdAt: readRpcDate(data['createdAt']),
      input: models.ProductsDeleteInput.fromWire(data['input']),
      baseline: models.Product.fromWire(data['baseline']),
      dispatching: readRpcBoolean(data['dispatching']),
      acknowledgement: readRpcNullable(
        data['acknowledgement'],
        models.ProductsDeleteOutput.fromWire,
      ),
    );

    receipt._validate();

    return receipt;
  }

  void _validate() {
    if (scope.isEmpty ||
        nonce.length != 32 ||
        !RegExp(r'^[0-9a-f]{32}$').hasMatch(nonce) ||
        createdAt.year < 100 ||
        input.id.isEmpty ||
        baseline.id != input.id) {
      throw const FormatException('INVALID_PRODUCT_DELETE_RECEIPT');
    }

    if ((dispatching && acknowledged) || acknowledgement?.success == false) {
      throw const FormatException('INVALID_PRODUCT_DELETE_RECEIPT_STAGE');
    }
  }
}

models.Product freezeProductDeleteBaseline(models.Product product) {
  final snapshot = models.Product.fromWire(product.toWire());

  return models.Product(
    id: snapshot.id,
    customId: snapshot.customId,
    name: snapshot.name,
    description: snapshot.description,
    regieReportName: snapshot.regieReportName,
    brand: snapshot.brand,
    baseUnit: snapshot.baseUnit,
    otherUnits: models.ApplyPriceImportRowOtherUnits(
      Map<String, num>.unmodifiable(snapshot.otherUnits.values),
    ),
    categories: List<String>.unmodifiable(snapshot.categories),
  );
}

bool sameProductDeleteBaseline(models.Product first, models.Product second) {
  if (first.id != second.id ||
      first.customId != second.customId ||
      first.name != second.name ||
      first.description != second.description ||
      first.regieReportName != second.regieReportName ||
      first.brand != second.brand ||
      first.baseUnit != second.baseUnit ||
      first.otherUnits.values.length != second.otherUnits.values.length ||
      first.categories.length != second.categories.length) {
    return false;
  }

  for (final entry in first.otherUnits.values.entries) {
    if (!second.otherUnits.values.containsKey(entry.key) ||
        second.otherUnits.values[entry.key] != entry.value) {
      return false;
    }
  }

  for (var index = 0; index < first.categories.length; index++) {
    if (first.categories[index] != second.categories[index]) {
      return false;
    }
  }

  return true;
}

const _fields = {
  'version',
  'operation',
  'scope',
  'nonce',
  'createdAt',
  'input',
  'baseline',
  'dispatching',
  'acknowledgement',
};

void _checkSize(String encoded) {
  const maxBytes = 128 * 1024;

  if (encoded.length > maxBytes || utf8.encode(encoded).length > maxBytes) {
    throw const FormatException('PRODUCT_DELETE_RECEIPT_TOO_LARGE');
  }
}

abstract interface class ProductDeleteReceiptStore {
  Future<ProductDeleteReceipt?> read(String scope);

  Future<void> write(ProductDeleteReceipt receipt);

  Future<void> clear(String scope);
}
