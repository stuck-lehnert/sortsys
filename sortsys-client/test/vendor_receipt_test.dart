import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/contract.dart' show jsonMap;
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/api/model.dart';
import 'package:sortsys_client/api/wire.dart';
import 'package:sortsys_client/features/vendors/vendor_draft.dart';
import 'package:sortsys_client/features/vendors/vendor_receipt.dart';

void main() {
  test('vendor receipt roundtrips create and update durable stages', () {
    for (final update in [false, true]) {
      final prepared = _receipt(update: update);
      final started = prepared.started();
      final confirmed = update
          ? started.confirmedUpdate(
              const models.ProductsVendorsUpdateOutput(success: true),
            )
          : started.confirmedCreate(
              const models.ProductsVendorsCreateOutput(id: 'vendor'),
            );

      for (final receipt in [prepared, started, confirmed]) {
        final decoded = VendorWriteReceipt.decode(receipt.encode());

        expect(decoded.encode(), receipt.encode());
        expect(decoded.dispatching, receipt.dispatching);
        expect(decoded.acknowledged, receipt.acknowledged);
      }

      expect(prepared.acknowledged, isFalse);
      expect(started.dispatching, isTrue);
      expect(confirmed.dispatching, isFalse);
      expect(confirmed.acknowledged, isTrue);
    }
  });

  test(
    'vendor creation requires actual acknowledged ID and exact target fields',
    () {
      final prepared = _receipt();
      final started = prepared.started();
      final confirmed = started.confirmedCreate(
        const models.ProductsVendorsCreateOutput(id: 'vendor'),
      );

      expect(prepared.confirms(_vendor()), isFalse);
      expect(started.confirms(_vendor()), isFalse);
      expect(confirmed.confirms(_vendor()), isTrue);
      expect(confirmed.confirms(_vendor(id: 'similar')), isFalse);
      expect(confirmed.confirms(_vendor(name: 'Other')), isFalse);
      expect(confirmed.confirms(_vendor(description: 'Other')), isFalse);
    },
  );

  test(
    'vendor update recovery reads known target and preserves baseline identity',
    () {
      final prepared = _receipt(update: true);
      final started = prepared.started();

      expect(prepared.confirms(_vendor()), isFalse);
      expect(started.confirms(_vendor()), isTrue);
      expect(started.confirms(_vendor(id: 'other')), isFalse);
      expect(started.confirms(_vendor(name: 'Before')), isFalse);
      expect(started.confirms(_vendor(description: 'changed')), isFalse);
      expect(started.confirms(_vendor(createdAt: DateTime.utc(2023))), isFalse);
      expect(
        started.confirms(_vendor(modifiedAt: DateTime.utc(2024))),
        isFalse,
      );
      expect(sameVendorSnapshot(_vendor(), _vendor()), isTrue);
      expect(sameVendorSnapshot(_vendor(), _vendor(name: 'Other')), isFalse);
      expect(
        sameVendorSnapshot(
          _vendor(),
          _vendor(modifiedAt: DateTime.utc(2024, 3)),
        ),
        isFalse,
      );
    },
  );

  test('vendor stages reject wrong-kind and invalid acknowledgements', () {
    final create = _receipt();
    final update = _receipt(update: true);

    expect(create.started().started, throwsStateError);
    expect(() {
      create.confirmedCreate(
        const models.ProductsVendorsCreateOutput(id: 'vendor'),
      );
    }, throwsStateError);
    expect(() {
      create.started().confirmedUpdate(
        const models.ProductsVendorsUpdateOutput(success: true),
      );
    }, throwsStateError);
    expect(() {
      update.started().confirmedCreate(
        const models.ProductsVendorsCreateOutput(id: 'vendor'),
      );
    }, throwsStateError);
    expect(() {
      create.started().confirmedCreate(
        const models.ProductsVendorsCreateOutput(id: ''),
      );
    }, throwsFormatException);
    expect(() {
      update.started().confirmedUpdate(
        const models.ProductsVendorsUpdateOutput(success: false),
      );
    }, throwsFormatException);
  });

  test(
    'vendor version2 keeps strict version1 create and update receipts recoverable',
    () {
      for (final update in [false, true]) {
        final prepared = _receipt(update: update);
        final started = prepared.started();
        final confirmed = update
            ? started.confirmedUpdate(
                const models.ProductsVendorsUpdateOutput(success: true),
              )
            : started.confirmedCreate(
                const models.ProductsVendorsCreateOutput(id: 'vendor'),
              );

        for (final receipt in [prepared, started, confirmed]) {
          final data = readRpcObject(
            deserializeWire(jsonMap(jsonDecode(receipt.encode()))),
            _receiptFields,
          );
          final legacy = {...data, 'version': 1}
            ..remove('deleteInput')
            ..remove('deletionAcknowledgement');
          final decoded = VendorWriteReceipt.decode(
            jsonEncode(serializeWire(legacy)),
          );

          expect(decoded.encode(), receipt.encode());
          expect(decoded.nonce, receipt.nonce);
          expect(decoded.deleteInput, isNull);
          expect(() {
            VendorWriteReceipt.decode(
              jsonEncode(serializeWire({...legacy, 'deleteInput': null})),
            );
          }, throwsFormatException);
          expect(() {
            VendorWriteReceipt.decode(
              jsonEncode(serializeWire({...legacy, 'version': 2})),
            );
          }, throwsFormatException);
        }
      }
    },
  );

  test(
    'vendor deletion requires known baseline and a genuine correctly staged acknowledgement',
    () {
      final prepared = VendorWriteReceipt(
        scope: 'origin|tenant|actor|vendor',
        nonce: _nonce,
        createdAt: DateTime.utc(2024),
        deleteInput: const models.ProductsVendorsDeleteInput(id: 'vendor'),
        baseline: _vendor(name: 'Before'),
      );
      final started = prepared.started();
      final confirmed = started.confirmedDelete(
        const models.ProductsVendorsDeleteOutput(success: true),
      );

      for (final receipt in [prepared, started, confirmed]) {
        final decoded = VendorWriteReceipt.decode(receipt.encode());

        expect(decoded.encode(), receipt.encode());
        expect(decoded.deleteInput?.id, 'vendor');
        expect(decoded.baseline?.name, 'Before');
        expect(decoded.confirms(_vendor()), isFalse);
      }

      expect(prepared.deletionConfirmed, isFalse);
      expect(started.deletionConfirmed, isFalse);
      expect(confirmed.deletionConfirmed, isTrue);
      expect(() {
        prepared.confirmedDelete(
          const models.ProductsVendorsDeleteOutput(success: true),
        );
      }, throwsStateError);
      expect(() {
        started.confirmedDelete(
          const models.ProductsVendorsDeleteOutput(success: false),
        );
      }, throwsFormatException);
      expect(() {
        started.confirmedUpdate(
          const models.ProductsVendorsUpdateOutput(success: true),
        );
      }, throwsStateError);
      expect(
        VendorWriteReceipt(
          scope: prepared.scope,
          nonce: _nonce,
          createdAt: prepared.createdAt,
          deleteInput: prepared.deleteInput,
          baseline: _vendor(id: 'foreign'),
        ).encode,
        throwsFormatException,
      );
      expect(
        VendorWriteReceipt(
          scope: prepared.scope,
          nonce: _nonce,
          createdAt: prepared.createdAt,
          createInput: _receipt().createInput,
          deleteInput: prepared.deleteInput,
          baseline: prepared.baseline,
        ).encode,
        throwsFormatException,
      );
    },
  );

  test('vendor decoder rejects malformed and cross-kind envelopes', () {
    final data = readRpcObject(
      deserializeWire(jsonMap(jsonDecode(_receipt().encode()))),
      _receiptFields,
    );

    for (final change in <Map<String, Object?>>[
      {'version': 3},
      {'scope': ''},
      {'nonce': 'not-a-nonce'},
      {'extra': true},
      {
        'dispatching': true,
        'creation': {'id': 'vendor'},
      },
      {
        'updateAcknowledgement': {'success': true},
      },
      {
        'creation': {'id': ''},
      },
      {'baseline': encodeRpcValue(_vendor())},
      {'updateInput': encodeRpcValue(_receipt(update: true).updateInput)},
    ]) {
      final encoded = jsonEncode(serializeWire({...data, ...change}));

      expect(() {
        VendorWriteReceipt.decode(encoded);
      }, throwsFormatException);
    }

    final missing = {...data}..remove('dispatching');

    expect(() {
      VendorWriteReceipt.decode(jsonEncode(serializeWire(missing)));
    }, throwsFormatException);
    expect(() {
      VendorWriteReceipt.decode(List.filled(131073, 'x').join());
    }, throwsFormatException);
  });

  test(
    'vendor receipts reject noncanonical payloads without coercing input',
    () {
      for (final input in [
        const models.ProductsVendorsCreateInput(name: ''),
        const models.ProductsVendorsCreateInput(
          name: ' Padded ',
          description: RpcOptional.value(null),
        ),
        const models.ProductsVendorsCreateInput(name: 'Vendor'),
        const models.ProductsVendorsCreateInput(
          name: 'Vendor',
          description: RpcOptional.undefined(),
        ),
        const models.ProductsVendorsCreateInput(
          name: 'Vendor',
          description: RpcOptional.value(''),
        ),
        const models.ProductsVendorsCreateInput(
          name: 'Vendor',
          description: RpcOptional.value(' note '),
        ),
        models.ProductsVendorsCreateInput(
          name: List.filled(128, 'a').join(),
          description: const RpcOptional.value(null),
        ),
      ]) {
        final receipt = VendorWriteReceipt(
          scope: 'actor',
          nonce: _nonce,
          createdAt: DateTime.utc(2024),
          createInput: input,
        );

        expect(receipt.encode, throwsFormatException);
      }

      final invalid = VendorWriteReceipt(
        scope: 'actor',
        nonce: _nonce,
        createdAt: DateTime.utc(2024),
        updateInput: _receipt(update: true).updateInput,
        baseline: _vendor(id: 'foreign'),
      );

      expect(invalid.encode, throwsFormatException);
    },
  );
}

const _nonce = '0123456789abcdef0123456789abcdef';

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
  'deleteInput',
  'deletionAcknowledgement',
};

VendorWriteReceipt _receipt({bool update = false}) {
  return VendorWriteReceipt(
    scope: 'origin|tenant|actor',
    nonce: _nonce,
    createdAt: DateTime.utc(2024, 2),
    createInput: update ? null : const VendorDraft(name: 'After').createInput(),
    updateInput: update
        ? const VendorDraft(name: 'After', vendorId: 'vendor').updateInput()
        : null,
    baseline: update ? _vendor(name: 'Before') : null,
  );
}

models.ProductVendor _vendor({
  String id = 'vendor',
  String name = 'After',
  String? description,
  DateTime? createdAt,
  DateTime? modifiedAt,
}) {
  return models.ProductVendor(
    id: id,
    name: name,
    description: description,
    createdAt: createdAt ?? DateTime.utc(2024),
    modifiedAt: modifiedAt ?? DateTime.utc(2024, 2),
  );
}
