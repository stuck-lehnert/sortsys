import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/contract.dart' show jsonMap;
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/api/model.dart';
import 'package:sortsys_client/api/wire.dart';
import 'package:sortsys_client/features/products/product_price_receipt.dart';

void main() {
  test('price receipt preserves input and each durable stage across wire encoding', () {
    final prepared = _receipt();
    final started = prepared.started();
    final confirmed = started.confirmed(
      const models.ProductsPriceRecordsCreateOutput(id: 'price'),
    );

    for (final receipt in [prepared, started, confirmed]) {
      final decoded = ProductPriceWriteReceipt.decode(receipt.encode());

      expect(decoded.scope, receipt.scope);
      expect(decoded.nonce, receipt.nonce);
      expect(decoded.createdAt, receipt.createdAt);
      expect(decoded.dispatching, receipt.dispatching);
      expect(decoded.acknowledgement?.id, receipt.acknowledgement?.id);
      expect(productPriceInputKey(decoded.input), productPriceInputKey(receipt.input));
    }

    expect(prepared.dispatching, isFalse);
    expect(prepared.acknowledgement, isNull);
    expect(started.dispatching, isTrue);
    expect(confirmed.dispatching, isFalse);
    expect(confirmed.input.toWire().containsKey('vendorId'), isFalse);
    expect(confirmed.input.toWire()['comment'], '  invoice  ');
  });

  test('price receipt requires valid stage transitions and explicit nonempty acknowledgement', () {
    final prepared = _receipt();
    final started = prepared.started();
    final confirmed = started.confirmed(
      const models.ProductsPriceRecordsCreateOutput(id: 'price'),
    );

    expect(prepared.started().started, throwsStateError);
    expect(() => prepared.confirmed(
      const models.ProductsPriceRecordsCreateOutput(id: 'price')),
      throwsStateError);
    expect(() => started.confirmed(
      const models.ProductsPriceRecordsCreateOutput(id: '')),
      throwsFormatException);
    expect(confirmed.started, throwsStateError);
    expect(() => confirmed.confirmed(
      const models.ProductsPriceRecordsCreateOutput(id: 'other')),
      throwsStateError);
    expect(prepared.confirms(_record()), isFalse);
    expect(started.confirms(_record()), isFalse);
    expect(confirmed.confirms(_record()), isTrue);
  });

  test('price receipt rejects malformed scope nonce stage and envelope', () {
    final data = readRpcObject(
      deserializeWire(jsonMap(jsonDecode(_receipt().encode()))),
      const {
        'version',
        'scope',
        'nonce',
        'createdAt',
        'input',
        'dispatching',
        'acknowledgement',
      },
    );

    for (final change in <Map<String, Object?>>[
      {'version': 2},
      {'scope': ''},
      {'nonce': 'not-a-nonce'},
      {'dispatching': true, 'acknowledgement': {'id': 'price'}},
      {'acknowledgement': {'id': ''}},
      {'extra': true},
    ]) {
      final altered = {...data, ...change};
      final encoded = jsonEncode(serializeWire(altered));

      expect(() => ProductPriceWriteReceipt.decode(encoded), throwsFormatException);
    }

    final missing = {...data}..remove('dispatching');

    expect(() => ProductPriceWriteReceipt.decode(
      jsonEncode(serializeWire(missing))), throwsFormatException);
    expect(() => ProductPriceWriteReceipt.decode(
      List.filled(131073, 'x').join()), throwsFormatException);
  });

  test('price receipt rejects noncanonical input rather than enabling uncertain replay', () {
    for (final input in [
      _input(productId: ''),
      _input(price: double.infinity),
      _input(vendor: const RpcOptional.value('vendor')),
      _input(comment: const RpcOptional.absent()),
      _input(comment: const RpcOptional.undefined()),
      _input(comment: RpcOptional.value(List.filled(128, 'é').join())),
    ]) {
      expect(_receipt(input: input).encode, throwsFormatException);
    }

    final zero = _receipt(input: _input(price: 0));
    final negative = _receipt(input: _input(price: -2));

    expect(ProductPriceWriteReceipt.decode(zero.encode()).input.pricePerBaseUnit, 0);
    expect(ProductPriceWriteReceipt.decode(negative.encode()).input.pricePerBaseUnit, -2);
  });

  test('price readback checks acknowledged ID and every owned payload attribute', () {
    final receipt = _receipt().started().confirmed(
      const models.ProductsPriceRecordsCreateOutput(id: 'price'),
    );

    for (final record in [
      _record(id: 'different'),
      _record(productId: 'different'),
      _record(vendorId: 'vendor'),
      _record(timestamp: DateTime.utc(2024, 2, 4)),
      _record(price: 8),
      _record(purchase: true),
      _record(comment: 'different'),
    ]) {
      expect(receipt.confirms(record), isFalse);
    }

    expect(receipt.confirms(_record()), isTrue);
    final blank = _receipt(input: _input(comment: const RpcOptional.value('   ')))
        .started().confirmed(const models.ProductsPriceRecordsCreateOutput(id: 'price'));

    expect(blank.confirms(_record(comment: null)), isTrue);
    expect(blank.confirms(_record(comment: '')), isFalse);
  });

  test('price receipt roundtrips and verifies canonical explicit null comment', () {
    final receipt = _receipt(
      input: _input(comment: const RpcOptional.value(null)),
    ).started().confirmed(
      const models.ProductsPriceRecordsCreateOutput(id: 'price'),
    );
    final decoded = ProductPriceWriteReceipt.decode(receipt.encode());

    expect(decoded.input.comment.hasValue, isTrue);
    expect(decoded.input.comment.valueOrNull, isNull);
    expect(decoded.confirms(_record(comment: null)), isTrue);
    expect(decoded.confirms(_record(comment: '')), isFalse);
  });
}

ProductPriceWriteReceipt _receipt({models.ProductsPriceRecordsCreateInput? input}) {
  return ProductPriceWriteReceipt(
    scope: 'origin|tenant|actor|session',
    nonce: '0123456789abcdef0123456789abcdef',
    createdAt: DateTime.utc(2024, 2, 3, 12),
    input: input ?? _input(),
  );
}

models.ProductsPriceRecordsCreateInput _input({
  String productId = 'product',
  num price = -5,
  RpcOptional<String?> vendor = const RpcOptional.absent(),
  RpcOptional<String?> comment = const RpcOptional.value('  invoice  '),
}) {
  return models.ProductsPriceRecordsCreateInput(
    productId: productId,
    pricePerBaseUnit: price,
    timestamp: DateTime.utc(2024, 2, 3),
    isRealPurchase: false,
    vendorId: vendor,
    comment: comment,
  );
}

models.ProductsPriceRecordsListResultItem _record({
  String id = 'price',
  String productId = 'product',
  String? vendorId,
  DateTime? timestamp,
  num price = -5,
  bool purchase = false,
  String? comment = 'invoice',
}) {
  return models.ProductsPriceRecordsListResultItem(
    id: id,
    productId: productId,
    vendorId: vendorId,
    timestamp: timestamp ?? DateTime.utc(2024, 2, 3),
    price: price,
    isRealPurchase: purchase,
    comment: comment,
  );
}
