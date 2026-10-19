import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/contract.dart' show jsonMap;
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/api/model.dart';
import 'package:sortsys_client/api/wire.dart';
import 'package:sortsys_client/features/products/product_draft.dart';
import 'package:sortsys_client/features/products/product_master_receipt.dart';

void main() {
  test('product receipt roundtrips both kinds and all durable stages', () {
    for (final update in [false, true]) {
      final prepared = _receipt(update: update);
      final started = prepared.started();
      final confirmed = update
          ? started.confirmedUpdate(
              const models.ProductsUpdateOutput(success: true),
            )
          : started.confirmedCreate(
              const models.ProductsCreateOutput(id: 'product'),
            );

      for (final receipt in [prepared, started, confirmed]) {
        final decoded = ProductMasterWriteReceipt.decode(receipt.encode());

        expect(decoded.encode(), receipt.encode());
        expect(decoded.dispatching, receipt.dispatching);
        expect(decoded.acknowledged, receipt.acknowledged);
      }

      expect(prepared.confirms(_product()), isFalse);
      expect(started.confirms(_product()), update);
      expect(confirmed.confirms(_product()), isTrue);
    }
  });

  test('product creation requires genuine ID and every requested field', () {
    final started = _receipt().started();
    final confirmed = started.confirmedCreate(
      const models.ProductsCreateOutput(id: 'product'),
    );

    expect(started.confirms(_product()), isFalse);
    expect(confirmed.confirms(_product()), isTrue);
    expect(confirmed.confirms(_product(id: 'similar')), isFalse);
    expect(confirmed.confirms(_product(customId: 11)), isFalse);
    expect(confirmed.confirms(_product(name: 'Other')), isFalse);
    expect(confirmed.confirms(_product(brand: 'Other')), isFalse);
    expect(confirmed.confirms(_product(units: {'box': 3})), isFalse);
    expect(confirmed.confirms(_product(units: {})), isFalse);
  });

  test(
    'product update recovery owns known fields and compares unit values',
    () {
      final started = _receipt(update: true).started();

      expect(started.confirms(_product()), isTrue);
      expect(started.confirms(_product(id: 'other')), isFalse);
      expect(started.confirms(_product(customId: 11)), isFalse);
      expect(started.confirms(_product(name: 'Before')), isFalse);
      expect(started.confirms(_product(units: {'box': 3})), isFalse);
      expect(
        sameProductMasterSnapshot(
          _product(units: {'box': 2, 'pallet': 4}),
          _product(units: {'pallet': 4, 'box': 2}),
        ),
        isTrue,
      );
      expect(
        sameProductMasterSnapshot(_product(), _product(brand: 'Changed')),
        isFalse,
      );
      expect(
        productMasterUpdateMatches(started.updateInput!, _product()),
        isTrue,
      );
    },
  );

  test('product receipt copies nested intent and baseline collections', () {
    final inputUnits = <String, num>{'box': 2};
    final baselineUnits = <String, num>{'box': 1};
    final receipt = ProductMasterWriteReceipt(
      scope: 'scope',
      nonce: _nonce,
      createdAt: DateTime.utc(2024),
      updateInput: models.ProductsUpdateInput(
        id: 'product',
        data: models.ProductsUpdateRequestData(
          name: const RpcOptional.value('After'),
          baseUnit: const RpcOptional.value('kg'),
          brand: const RpcOptional.value(null),
          description: const RpcOptional.value(null),
          regieReportName: const RpcOptional.value(null),
          otherUnits: RpcOptional.value(
            models.ApplyPriceImportRowOtherUnits(inputUnits),
          ),
        ),
      ),
      baseline: _product(name: 'Before', units: baselineUnits),
    );

    inputUnits['box'] = 99;
    baselineUnits['box'] = 88;

    expect(receipt.updateInput!.data.otherUnits.value.values, {'box': 2});
    expect(receipt.baseline!.otherUnits.values, {'box': 1});
    expect(() {
      receipt.updateInput!.data.otherUnits.value.values['box'] = 3;
    }, throwsUnsupportedError);
    expect(receipt.baseline!.categories.clear, throwsUnsupportedError);
    expect(receipt.started().confirms(_product()), isTrue);
  });

  test('product receipt rejects malformed exact envelope and stages', () {
    final data = readRpcObject(
      deserializeWire(jsonMap(jsonDecode(_receipt().encode()))),
      _fields,
    );

    for (final change in <Map<String, Object?>>[
      {'version': 2},
      {'scope': ''},
      {'nonce': 'invalid'},
      {'extra': true},
      {
        'dispatching': true,
        'creation': {'id': 'product'},
      },
      {
        'creation': {'id': ''},
      },
      {
        'updateAcknowledgement': {'success': true},
      },
      {'baseline': encodeRpcValue(_product())},
      {'updateInput': encodeRpcValue(_receipt(update: true).updateInput)},
    ]) {
      expect(() {
        ProductMasterWriteReceipt.decode(
          jsonEncode(serializeWire({...data, ...change})),
        );
      }, throwsFormatException);
    }

    final missing = {...data}..remove('dispatching');

    expect(() {
      ProductMasterWriteReceipt.decode(jsonEncode(serializeWire(missing)));
    }, throwsFormatException);
    expect(() {
      ProductMasterWriteReceipt.decode(List.filled(131073, 'x').join());
    }, throwsFormatException);
  });

  test(
    'product receipt rejects wrong acknowledgements and invalid payload',
    () {
      final create = _receipt();
      final update = _receipt(update: true);

      expect(create.started().started, throwsStateError);
      expect(() {
        create.confirmedCreate(
          const models.ProductsCreateOutput(id: 'product'),
        );
      }, throwsStateError);
      expect(() {
        create.started().confirmedCreate(
          const models.ProductsCreateOutput(id: ''),
        );
      }, throwsFormatException);
      expect(() {
        create.started().confirmedUpdate(
          const models.ProductsUpdateOutput(success: true),
        );
      }, throwsStateError);
      expect(() {
        update.started().confirmedCreate(
          const models.ProductsCreateOutput(id: 'product'),
        );
      }, throwsStateError);
      expect(() {
        update.started().confirmedUpdate(
          const models.ProductsUpdateOutput(success: false),
        );
      }, throwsFormatException);
      expect(
        ProductMasterWriteReceipt(
          scope: 'scope',
          nonce: _nonce,
          createdAt: DateTime.utc(2024),
          createInput: const models.ProductsCreateInput(
            customId: 10,
            name: 'After',
            baseUnit: 'kg',
          ),
        ).encode,
        throwsFormatException,
      );
      expect(
        ProductMasterWriteReceipt(
          scope: 'scope',
          nonce: _nonce,
          createdAt: DateTime.utc(2024),
          updateInput: update.updateInput,
          baseline: _product(id: 'foreign'),
        ).encode,
        throwsFormatException,
      );
    },
  );
}

const _nonce = '0123456789abcdef0123456789abcdef';
const _fields = {
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

ProductMasterWriteReceipt _receipt({bool update = false}) {
  final draft = ProductDraft(
    productId: update ? 'product' : null,
    customId: '10',
    name: 'After',
    baseUnit: 'kg',
    units: const [ProductUnitDraft(name: 'box', amount: '2')],
  );

  return ProductMasterWriteReceipt(
    scope: 'scope',
    nonce: _nonce,
    createdAt: DateTime.utc(2024),
    createInput: update ? null : draft.createInput(),
    updateInput: update ? draft.updateInput() : null,
    baseline: update ? _product(name: 'Before', units: {'box': 1}) : null,
  );
}

models.Product _product({
  String id = 'product',
  num customId = 10,
  String name = 'After',
  String? brand,
  Map<String, num> units = const {'box': 2},
}) {
  return models.Product(
    id: id,
    customId: customId,
    name: name,
    brand: brand,
    baseUnit: 'kg',
    otherUnits: models.ApplyPriceImportRowOtherUnits(units),
    categories: [],
  );
}
