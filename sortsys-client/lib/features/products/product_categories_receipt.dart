import 'dart:convert';

import '../../api/contract.dart' show jsonMap;
import '../../api/generated/models.g.dart' as models;
import '../../api/model.dart';
import '../../api/wire.dart';
import 'product_categories_inputs.dart';

final class ProductCategoriesWriteReceipt {
  ProductCategoriesWriteReceipt({
    required this.scope,
    required this.nonce,
    required this.createdAt,
    required models.ProductsCategoriesSetInput input,
    required List<String> baselineCategories,
    this.dispatching = false,
    this.acknowledgement,
  }) : input = models.ProductsCategoriesSetInput(
         id: input.id,
         categories: List.unmodifiable(input.categories),
       ),
       baselineCategories = List.unmodifiable(baselineCategories);

  final String scope;
  final String nonce;
  final DateTime createdAt;
  final models.ProductsCategoriesSetInput input;
  final List<String> baselineCategories;
  final bool dispatching;
  final models.ProductsCategoriesSetOutput? acknowledgement;

  bool get acknowledged {
    return acknowledgement != null;
  }

  ProductCategoriesWriteReceipt started() {
    _validate();

    if (dispatching || acknowledged) {
      throw StateError('INVALID_PRODUCT_CATEGORIES_RECEIPT_STAGE');
    }

    return _copy(dispatching: true);
  }

  ProductCategoriesWriteReceipt confirmed(
    models.ProductsCategoriesSetOutput result,
  ) {
    _validate();

    if (!dispatching || acknowledged) {
      throw StateError('INVALID_PRODUCT_CATEGORIES_RECEIPT_STAGE');
    }

    if (!result.success) {
      throw const FormatException('INVALID_PRODUCT_CATEGORIES_ACK');
    }

    return _copy(dispatching: false, acknowledgement: result);
  }

  ProductCategoriesWriteReceipt _copy({
    required bool dispatching,
    models.ProductsCategoriesSetOutput? acknowledgement,
  }) {
    return ProductCategoriesWriteReceipt(
      scope: scope,
      nonce: nonce,
      createdAt: createdAt,
      input: input,
      baselineCategories: baselineCategories,
      dispatching: dispatching,
      acknowledgement: acknowledgement,
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
        'input': encodeRpcValue(input),
        'baselineCategories': baselineCategories,
        'dispatching': dispatching,
        'acknowledgement': encodeRpcValue(acknowledgement),
      }),
    );

    _checkSize(encoded);

    return encoded;
  }

  factory ProductCategoriesWriteReceipt.decode(String encoded) {
    _checkSize(encoded);

    final data = readRpcObject(
      deserializeWire(jsonMap(jsonDecode(encoded))),
      _receiptFields,
    );

    readRpcLiteral(data['version'], 1);

    if (data.length != _receiptFields.length ||
        !_receiptFields.every(data.containsKey)) {
      throw const FormatException('INVALID_PRODUCT_CATEGORIES_RECEIPT');
    }

    final receipt = ProductCategoriesWriteReceipt(
      scope: readRpcString(data['scope']),
      nonce: readRpcString(data['nonce']),
      createdAt: readRpcDate(data['createdAt']),
      input: models.ProductsCategoriesSetInput.fromWire(data['input']),
      baselineCategories: readRpcList(
        data['baselineCategories'],
        readRpcString,
      ),
      dispatching: readRpcBoolean(data['dispatching']),
      acknowledgement: readRpcNullable(
        data['acknowledgement'],
        models.ProductsCategoriesSetOutput.fromWire,
      ),
    );

    receipt._validate();

    return receipt;
  }

  void _validate() {
    if (scope.isEmpty ||
        nonce.length != 32 ||
        !RegExp(r'^[0-9a-f]{32}$').hasMatch(nonce) ||
        createdAt.year < 100) {
      throw const FormatException('INVALID_PRODUCT_CATEGORIES_RECEIPT');
    }

    if ((dispatching && acknowledged) || acknowledgement?.success == false) {
      throw const FormatException('INVALID_PRODUCT_CATEGORIES_RECEIPT_STAGE');
    }

    checkProductCategoriesInput(input);
  }

  bool confirms(models.Product product) {
    _validate();

    return (dispatching || acknowledged) &&
        productCategoriesInputMatches(input, product);
  }
}

const _receiptFields = {
  'version',
  'scope',
  'nonce',
  'createdAt',
  'input',
  'baselineCategories',
  'dispatching',
  'acknowledgement',
};

void _checkSize(String encoded) {
  const maxBytes = 128 * 1024;

  if (encoded.length > maxBytes || utf8.encode(encoded).length > maxBytes) {
    throw const FormatException('PRODUCT_CATEGORIES_RECEIPT_TOO_LARGE');
  }
}

abstract interface class ProductCategoriesReceiptStore {
  Future<ProductCategoriesWriteReceipt?> read(String scope);

  Future<void> write(ProductCategoriesWriteReceipt receipt);

  Future<void> clear(String scope);
}
