import 'dart:convert';

import '../../api/contract.dart' show jsonMap;
import '../../api/generated/models.g.dart' as models;
import '../../api/model.dart';
import '../../api/wire.dart';

const _maximumReceiptBytes = 131072;

final class ProductPriceWriteReceipt {
  const ProductPriceWriteReceipt({
    required this.scope,
    required this.nonce,
    required this.createdAt,
    required this.input,
    this.dispatching = false,
    this.acknowledgement,
  });

  final String scope;
  final String nonce;
  final DateTime createdAt;
  final models.ProductsPriceRecordsCreateInput input;
  final bool dispatching;
  final models.ProductsPriceRecordsCreateOutput? acknowledgement;

  ProductPriceWriteReceipt started() {
    if (dispatching || acknowledgement != null) {
      throw StateError('INVALID_PRODUCT_PRICE_RECEIPT_STAGE');
    }

    return _copy(dispatching: true);
  }

  ProductPriceWriteReceipt confirmed(
    models.ProductsPriceRecordsCreateOutput result,
  ) {
    if (!dispatching || acknowledgement != null) {
      throw StateError('INVALID_PRODUCT_PRICE_RECEIPT_STAGE');
    }

    if (result.id.isEmpty) {
      throw const FormatException('INVALID_PRODUCT_PRICE_CREATE_RESULT');
    }

    return _copy(dispatching: false, acknowledgement: result);
  }

  ProductPriceWriteReceipt _copy({
    required bool dispatching,
    models.ProductsPriceRecordsCreateOutput? acknowledgement,
  }) {
    return ProductPriceWriteReceipt(
      scope: scope,
      nonce: nonce,
      createdAt: createdAt,
      input: input,
      dispatching: dispatching,
      acknowledgement: acknowledgement,
    );
  }

  String encode() {
    _validate();

    final data = <String, Object?>{
      'version': 1,
      'scope': scope,
      'nonce': nonce,
      'createdAt': createdAt,
      'input': encodeRpcValue(input),
      'dispatching': dispatching,
      'acknowledgement': encodeRpcValue(acknowledgement),
    };
    final encoded = jsonEncode(serializeWire(data));
    _checkSize(encoded);

    return encoded;
  }

  factory ProductPriceWriteReceipt.decode(String encoded) {
    _checkSize(encoded);

    final envelope = jsonMap(jsonDecode(encoded));
    final data = readRpcObject(deserializeWire(envelope), const {
      'version',
      'scope',
      'nonce',
      'createdAt',
      'input',
      'dispatching',
      'acknowledgement',
    });

    if (data.length != 7) {
      throw const FormatException('INVALID_PRODUCT_PRICE_RECEIPT');
    }

    readRpcLiteral(data['version'], 1);

    final receipt = ProductPriceWriteReceipt(
      scope: readRpcString(data['scope']),
      nonce: readRpcString(data['nonce']),
      createdAt: readRpcDate(data['createdAt']),
      input: models.ProductsPriceRecordsCreateInput.fromWire(data['input']),
      dispatching: readRpcBoolean(data['dispatching']),
      acknowledgement: readRpcNullable(
        data['acknowledgement'],
        models.ProductsPriceRecordsCreateOutput.fromWire,
      ),
    );
    receipt._validate();

    return receipt;
  }

  void _validate() {
    if (scope.isEmpty ||
        !RegExp(r'^[0-9a-f]{32}$').hasMatch(nonce) ||
        createdAt.year < 100) {
      throw const FormatException('INVALID_PRODUCT_PRICE_RECEIPT');
    }

    final acknowledgement = this.acknowledgement;

    if (acknowledgement != null &&
        (acknowledgement.id.isEmpty || dispatching)) {
      throw const FormatException('INVALID_PRODUCT_PRICE_RECEIPT_STAGE');
    }

    final comment = input.comment.valueOrNull;

    // Persist only the canonical form payload, including its vendor omission.
    if (input.productId.isEmpty ||
        !input.pricePerBaseUnit.isFinite ||
        !input.vendorId.isAbsent ||
        input.comment.isAbsent ||
        comment == null ||
        utf8.encode(comment.trim()).length > 255) {
      throw const FormatException('INVALID_PRODUCT_PRICE_RECEIPT_INPUT');
    }
  }

  bool confirms(models.ProductsPriceRecordsListResultItem record) {
    final acknowledgement = this.acknowledgement;

    if (acknowledgement == null || acknowledgement.id.isEmpty) {
      return false;
    }

    final comment = input.comment.valueOrNull?.trim();
    final normalizedComment = comment == null || comment.isEmpty ? null : comment;

    return record.id == acknowledgement.id &&
        record.productId == input.productId &&
        record.vendorId == null &&
        record.timestamp.isAtSameMomentAs(input.timestamp) &&
        record.price == input.pricePerBaseUnit &&
        record.isRealPurchase == input.isRealPurchase &&
        record.comment == normalizedComment;
  }
}

abstract interface class ProductPriceReceiptStore {
  Future<ProductPriceWriteReceipt?> read(String scope);

  Future<void> write(ProductPriceWriteReceipt receipt);

  Future<void> clear(String scope);
}

String productPriceInputKey(models.ProductsPriceRecordsCreateInput input) {
  return jsonEncode(serializeWire(encodeRpcValue(input)));
}

void _checkSize(String encoded) {
  if (utf8.encode(encoded).length > _maximumReceiptBytes) {
    throw const FormatException('PRODUCT_PRICE_RECEIPT_TOO_LARGE');
  }
}
