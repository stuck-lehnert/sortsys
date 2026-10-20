import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/contract.dart' show jsonMap;
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/api/model.dart';
import 'package:sortsys_client/features/tools/tool_draft.dart';
import 'package:sortsys_client/features/tools/tool_receipt.dart';
import 'package:sortsys_client/features/tools/tool_write_inputs.dart';

const _createScope = '["https://example.test","tenant","actor",null]';
const _editScope = '["https://example.test","tenant","actor","tool"]';
const _nonce = '0123456789abcdef0123456789abcdef';

void main() {
  test('tool create receipt has exact bounded tagged v1 envelope', () {
    final receipt = _createReceipt();
    final envelope = jsonMap(jsonDecode(receipt.encode()));
    final data = jsonMap(envelope['json']);
    final decoded = ToolWriteReceipt.decode(receipt.encode());

    expect(envelope.keys.toSet(), {'json', 'meta'});
    expect(data.keys.toSet(), {
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
    });
    expect(data['version'], 1);
    expect(jsonMap(jsonMap(envelope['meta'])['values']), {
      'createdAt': ['Date'],
    });
    expect(decoded.encode(), receipt.encode());
    expect(decoded.acknowledged, isFalse);
    expect(decoded.dispatching, isFalse);
    expect(decoded.createInput!.toWire(), _create().toWire());
  });

  test('tool update receipt freezes all thirteen raw generated fields', () {
    final original = _tool();
    final receipt = _editReceipt(baseline: original);
    final decoded = ToolWriteReceipt.decode(receipt.encode());
    final frozen = receipt.baseline!;
    final detached = frozen.toWire();

    detached['brand'] = 'changed detached map';

    expect(identical(frozen, original), isFalse);
    expect(frozen.brand, ' Brand ');
    expect(frozen.category, ' Category ');
    expect(frozen.label, ' Model ');
    expect(frozen.status, models.ToolStatus.lost);
    expect(sameToolSnapshot(frozen, original), isTrue);
    expect(sameToolSnapshot(decoded.baseline!, original), isTrue);
    expect(decoded.updateInput!.toWire(), receipt.updateInput!.toWire());
    expect(frozen.toWire().keys.toSet(), {
      'id',
      'customId',
      'brand',
      'category',
      'label',
      'purchasePrice',
      'usageCostPerDay',
      'status',
      'available',
      'createdByUserId',
      'createdAt',
      'modifiedAt',
      'archivedSince',
    });
  });

  test('tool creation needs genuine matching ID acknowledgement', () {
    final prepared = _createReceipt();
    final dispatched = prepared.started();
    final matching = _writtenTool();
    final acknowledged = dispatched.confirmedCreate(
      const models.ToolsCreateOutput(id: 'tool'),
    );

    expect(prepared.confirms(matching), isFalse);
    expect(dispatched.confirms(matching), isFalse);
    expect(acknowledged.confirms(matching), isTrue);
    expect(acknowledged.confirms(_writtenTool({'id': 'other'})), isFalse);
    expect(acknowledged.confirms(_writtenTool({'customId': 43})), isFalse);
    expect(
      ToolWriteReceipt.decode(acknowledged.encode()).confirms(matching),
      isTrue,
    );
  });

  test('matching tool row cannot prove secondary tracking cost completion', () {
    final prepared = _editReceipt();
    final dispatched = prepared.started();
    final matching = _writtenTool();
    final acknowledged = dispatched.confirmedUpdate(
      const models.ToolsUpdateOutput(success: true),
    );

    expect(toolUpdateMatches(prepared.updateInput!, matching), isTrue);
    expect(prepared.confirms(matching), isFalse);
    expect(dispatched.confirms(matching), isFalse);
    expect(
      ToolWriteReceipt.decode(dispatched.encode()).confirms(matching),
      isFalse,
    );
    expect(acknowledged.confirms(matching), isTrue);
    expect(
      ToolWriteReceipt.decode(acknowledged.encode()).confirms(matching),
      isTrue,
    );
  });

  test(
    'tool receipt transitions reject replay false ACK and wrong operation',
    () {
      final create = _createReceipt();
      final edit = _editReceipt();
      final started = edit.started();
      final acknowledged = started.confirmedUpdate(
        const models.ToolsUpdateOutput(success: true),
      );

      expect(() {
        create.confirmedCreate(const models.ToolsCreateOutput(id: 'tool'));
      }, throwsStateError);
      expect(() {
        started.started();
      }, throwsStateError);
      expect(() {
        started.confirmedCreate(const models.ToolsCreateOutput(id: 'tool'));
      }, throwsStateError);
      expect(() {
        create.started().confirmedUpdate(
          const models.ToolsUpdateOutput(success: true),
        );
      }, throwsStateError);
      expect(() {
        create.started().confirmedCreate(
          const models.ToolsCreateOutput(id: ''),
        );
      }, throwsFormatException);
      expect(() {
        started.confirmedUpdate(const models.ToolsUpdateOutput(success: false));
      }, throwsFormatException);
      expect(() {
        acknowledged.started();
      }, throwsStateError);
      expect(() {
        acknowledged.confirmedUpdate(
          const models.ToolsUpdateOutput(success: true),
        );
      }, throwsStateError);
    },
  );

  test(
    'tool receipt rejects invalid owner nonce dates and intent combinations',
    () {
      expect(() {
        _createReceipt(scope: '');
      }, throwsFormatException);
      expect(() {
        ToolWriteReceipt(
          scope: _createScope,
          nonce: ''.padLeft(32, 'A'),
          createdAt: DateTime.utc(2024),
          createInput: _create(),
        );
      }, throwsFormatException);
      expect(() {
        ToolWriteReceipt(
          scope: _createScope,
          nonce: _nonce,
          createdAt: DateTime.utc(99),
          createInput: _create(),
        );
      }, throwsFormatException);
      expect(() {
        ToolWriteReceipt(
          scope: _editScope,
          nonce: _nonce,
          createdAt: DateTime.utc(2024),
          updateInput: _update(),
        );
      }, throwsFormatException);
      expect(() {
        ToolWriteReceipt(
          scope: _editScope,
          nonce: _nonce,
          createdAt: DateTime.utc(2024),
          createInput: _create(),
          updateInput: _update(),
          baseline: _tool(),
        );
      }, throwsFormatException);
      expect(() {
        _editReceipt(baseline: _tool({'id': 'foreign'}));
      }, throwsFormatException);
      expect(() {
        ToolWriteReceipt(
          scope: _createScope,
          nonce: _nonce,
          createdAt: DateTime.utc(2024),
          createInput: _create(),
          baseline: _tool(),
        );
      }, throwsFormatException);
    },
  );

  test(
    'tool receipt codec rejects missing extra and incompatible header fields',
    () {
      for (final key in jsonMap(_envelope(_createReceipt())['json']).keys) {
        final envelope = _envelope(_createReceipt());
        jsonMap(envelope['json']).remove(key);

        expect(() {
          ToolWriteReceipt.decode(jsonEncode(envelope));
        }, throwsFormatException);
      }

      for (final change in [
        {'version': 2},
        {'unexpected': true},
        {'dispatching': 'true'},
        {
          'creation': {'id': ''},
        },
        {
          'updateAcknowledgement': {'success': true},
        },
      ]) {
        final envelope = _envelope(_createReceipt());
        jsonMap(envelope['json']).addAll(change);

        expect(() {
          ToolWriteReceipt.decode(jsonEncode(envelope));
        }, throwsFormatException);
      }
    },
  );

  test('tool receipt codec requires exact canonical date annotations', () {
    final mutations = <void Function(Map<String, Object?>)>[
      (envelope) {
        envelope.remove('meta');
      },
      (envelope) {
        envelope['extra'] = true;
      },
      (envelope) {
        jsonMap(envelope['meta'])['extra'] = true;
      },
      (envelope) {
        jsonMap(
          jsonMap(envelope['meta'])['values'],
        ).remove('baseline.modifiedAt');
      },
      (envelope) {
        jsonMap(jsonMap(envelope['meta'])['values'])['nonce'] = ['Date'];
      },
      (envelope) {
        jsonMap(jsonMap(envelope['meta'])['values'])['createdAt'] = ['bigint'];
      },
      (envelope) {
        jsonMap(envelope['json'])['createdAt'] = '2024-02-31T00:00:00.000Z';
      },
      (envelope) {
        jsonMap(envelope['json'])['createdAt'] =
            '2024-01-01T01:00:00.000+01:00';
      },
    ];

    for (final mutate in mutations) {
      final envelope = _envelope(_editReceipt());
      mutate(envelope);

      expect(() {
        ToolWriteReceipt.decode(jsonEncode(envelope));
      }, throwsFormatException);
    }
  });

  test(
    'tool receipt size limit precedes JSON parsing and counts UTF8 bytes',
    () {
      final oversized = List.filled(65537, 'ä').join();
      final receipt = _createReceipt(scope: List.filled(65536, 'ä').join());
      final tooLarge = isA<FormatException>().having(
        (error) {
          return error.message;
        },
        'message',
        'TOOL_RECEIPT_TOO_LARGE',
      );

      expect(() {
        ToolWriteReceipt.decode(oversized);
      }, throwsA(tooLarge));
      expect(() {
        receipt.encode();
      }, throwsA(tooLarge));
    },
  );

  test(
    'tool full snapshot distinguishes every raw field and optional null',
    () {
      final original = _tool();
      final changes = <String, Object?>{
        'id': 'other',
        'customId': 43,
        'brand': 'Brand',
        'category': 'Category',
        'label': null,
        'purchasePrice': null,
        'usageCostPerDay': 0,
        'status': 'broken',
        'available': false,
        'createdByUserId': null,
        'createdAt': DateTime.utc(2025),
        'modifiedAt': DateTime.utc(2025, 2),
        'archivedSince': null,
      };

      expect(changes.length, 13);

      for (final change in changes.entries) {
        expect(
          sameToolSnapshot(original, _tool({change.key: change.value})),
          isFalse,
          reason: change.key,
        );
      }

      expect(
        sameToolSnapshot(_tool({'label': null}), _tool({'label': ''})),
        isFalse,
      );
      expect(
        sameToolSnapshot(
          _tool({'createdByUserId': null}),
          _tool({'createdByUserId': ''}),
        ),
        isFalse,
      );
    },
  );

  test('tool typed create rejects foreign fields numeric IDs and raw text', () {
    for (final change in [
      {'customId': 0},
      {'customId': 1.0},
      {'customId': 2147483648},
      {'brand': ' Brand '},
      {'category': ''},
      {'label': ''},
      {'purchasePrice': -1},
      {'purchasePrice': double.infinity},
      {'status': null},
      {'unexpected': true},
      {'label': List.filled(128, 'ä').join()},
    ]) {
      expect(() {
        copyToolCreateInput(_create(change));
      }, throwsFormatException);
    }

    final bom = String.fromCharCode(0xfeff);
    final nel = String.fromCharCode(0x0085);
    final normalized = ToolDraft(
      customId: '42',
      brand: '$nel$bom',
      category: 'Category',
      label: bom,
    ).createInput();
    final copied = copyToolCreateInput(normalized);

    expect(copied.brand, bom);
    expect(copied.label.value, bom);
  });

  test('tool typed updates require all six explicit owned fields', () {
    final update = _update();
    final fields = jsonMap(jsonMap(update.toWire())['data']).keys.toList();

    expect(fields.length, 6);

    for (final field in fields) {
      final data = jsonMap(jsonMap(update.toWire())['data']);
      data.remove(field);

      expect(() {
        copyToolUpdateInput(
          models.ToolsUpdateInput.fromWire({'id': 'tool', 'data': data}),
        );
      }, throwsFormatException);
    }

    expect(() {
      copyToolUpdateInput(
        const models.ToolsUpdateInput(
          id: 'tool',
          data: models.ToolsUpdateRequestData(brand: RpcOptional.undefined()),
        ),
      );
    }, throwsFormatException);

    for (final target in ['', String.fromCharCode(0xd800)]) {
      final invalid = models.ToolsUpdateInput(id: target, data: update.data);

      expect(() {
        copyToolUpdateInput(invalid);
      }, throwsFormatException);
    }
  });

  test(
    'tool typed costs reject exact integer loss and retain finite doubles',
    () {
      for (final field in ['purchasePrice', 'usageCostPerDay']) {
        for (final value in [9007199254740993, 9223372036854775807]) {
          final input = _create({field: value});

          expect(() {
            copyToolCreateInput(input);
          }, throwsFormatException);
        }

        for (final value in [0, 0.5, 5e-324, 1.7976931348623157e308]) {
          final input = copyToolCreateInput(_create({field: value}));
          final cost = field == 'purchasePrice'
              ? input.purchasePrice
              : input.usageCostPerDay;

          expect(cost.value, value);
        }
      }
    },
  );

  test(
    'tool genuine acknowledgement still requires every owned readback field',
    () {
      final receipt = _editReceipt().started().confirmedUpdate(
        const models.ToolsUpdateOutput(success: true),
      );
      final changes = <String, Object?>{
        'brand': 'other',
        'category': 'other',
        'label': null,
        'purchasePrice': null,
        'usageCostPerDay': null,
        'status': 'lost',
        'id': 'other',
      };

      expect(receipt.confirms(_writtenTool()), isTrue);

      for (final change in changes.entries) {
        expect(
          receipt.confirms(_writtenTool({change.key: change.value})),
          isFalse,
          reason: change.key,
        );
      }
    },
  );

  test('tool raw baseline rejects malformed scalars and invalid dates', () {
    for (final change in [
      {'brand': String.fromCharCode(0xd800)},
      {'id': ''},
      {'createdAt': DateTime.utc(99)},
      {'modifiedAt': DateTime.utc(99)},
      {'archivedSince': DateTime.utc(99)},
    ]) {
      expect(() {
        freezeToolWriteBaseline(_tool(change));
      }, throwsFormatException);
    }

    final bom = String.fromCharCode(0xfeff);
    final baseline = _tool({
      'brand': '${bom}Brand',
      'category': '${bom}Category',
      'label': bom,
      'createdByUserId': '${bom}actor',
    });
    final receipt = _editReceipt(baseline: baseline);
    final decoded = ToolWriteReceipt.decode(receipt.encode());

    expect(sameToolSnapshot(decoded.baseline!, baseline), isTrue);
    expect(decoded.baseline!.brand, '${bom}Brand');
    expect(decoded.baseline!.label, bom);
  });

  test(
    'tool receipts cannot store simultaneous dispatch or false acknowledgements',
    () {
      for (final change in [
        {
          'dispatching': true,
          'updateAcknowledgement': {'success': true},
        },
        {
          'updateAcknowledgement': {'success': false},
        },
        {
          'creation': {'id': 'tool'},
          'updateAcknowledgement': {'success': true},
        },
      ]) {
        final envelope = _envelope(_editReceipt());
        jsonMap(envelope['json']).addAll(change);

        expect(() {
          ToolWriteReceipt.decode(jsonEncode(envelope));
        }, throwsFormatException);
      }
    },
  );
}

models.ToolsCreateInput _create([Map<String, Object?> changes = const {}]) {
  return models.ToolsCreateInput.fromWire({
    'customId': 42,
    'brand': 'Brand',
    'category': 'Category',
    'label': 'Model',
    'purchasePrice': 0.25,
    'usageCostPerDay': 12.5,
    ...changes,
  });
}

models.ToolsUpdateInput _update() {
  return models.ToolsUpdateInput.fromWire({
    'id': 'tool',
    'data': {
      'brand': 'Brand',
      'category': 'Category',
      'label': 'Model',
      'purchasePrice': 0.25,
      'usageCostPerDay': 12.5,
      'status': null,
    },
  });
}

models.Tool _tool([Map<String, Object?> changes = const {}]) {
  return models.Tool.fromWire({
    'id': 'tool',
    'customId': 42,
    'brand': ' Brand ',
    'category': ' Category ',
    'label': ' Model ',
    'purchasePrice': 0.25,
    'usageCostPerDay': 12.5,
    'status': 'lost',
    'available': true,
    'createdByUserId': 'actor',
    'createdAt': DateTime.utc(2024),
    'modifiedAt': DateTime.utc(2024, 2),
    'archivedSince': DateTime.utc(2024, 3),
    ...changes,
  });
}

models.Tool _writtenTool([Map<String, Object?> changes = const {}]) {
  return _tool({...jsonMap(jsonMap(_update().toWire())['data']), ...changes});
}

ToolWriteReceipt _createReceipt({String scope = _createScope}) {
  return ToolWriteReceipt(
    scope: scope,
    nonce: _nonce,
    createdAt: DateTime.utc(2024),
    createInput: _create(),
  );
}

ToolWriteReceipt _editReceipt({models.Tool? baseline}) {
  return ToolWriteReceipt(
    scope: _editScope,
    nonce: _nonce,
    createdAt: DateTime.utc(2024),
    updateInput: _update(),
    baseline: baseline ?? _tool(),
  );
}

Map<String, Object?> _envelope(ToolWriteReceipt receipt) {
  return jsonMap(jsonDecode(receipt.encode()));
}
