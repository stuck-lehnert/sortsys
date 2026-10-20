import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/features/products/product_delete_receipt.dart';

void main() {
  test(
    'product delete receipt round trips exact envelope and every durable stage',
    () {
      final prepared = _receipt();
      final dispatching = prepared.started();
      final acknowledged = dispatching.confirmed(
        const models.ProductsDeleteOutput(success: true),
      );

      for (final receipt in [prepared, dispatching, acknowledged]) {
        final encoded = receipt.encode();
        final decoded = ProductDeleteReceipt.decode(encoded);
        final envelope = jsonDecode(encoded) as Map<String, dynamic>;
        final data = envelope['json'] as Map<String, dynamic>;
        final annotations =
            (envelope['meta'] as Map<String, dynamic>)['values'];

        expect(decoded.encode(), encoded);
        expect(data.keys.toSet(), {
          'version',
          'operation',
          'scope',
          'nonce',
          'createdAt',
          'input',
          'baseline',
          'dispatching',
          'acknowledgement',
        });
        expect(data['version'], 2);
        expect(data['operation'], 'delete');
        expect(annotations, {
          'createdAt': ['Date'],
        });
        expect(sameProductDeleteBaseline(decoded.baseline, _product()), isTrue);
        expect(decoded.input.id, 'product');
        expect(decoded.scope, 'origin|tenant|actor|product');
        expect(decoded.nonce, '0123456789abcdef0123456789abcdef');
      }

      expect(prepared.dispatching, isFalse);
      expect(prepared.acknowledged, isFalse);
      expect(dispatching.dispatching, isTrue);
      expect(dispatching.acknowledged, isFalse);
      expect(acknowledged.dispatching, isFalse);
      expect(acknowledged.acknowledged, isTrue);
    },
  );

  test(
    'product delete receipt freezes nested units and raw legacy categories',
    () {
      final units = <String, num>{' Carton ': -2.5, 'Box': 3};
      final categories = [' Raw ', 'raw', 'raw'];
      final receipt = _receipt(
        baseline: _product(name: '  ', units: units, categories: categories),
      );
      final original = receipt.encode();

      units[' Carton '] = 99;
      units['new'] = 5;
      categories.clear();

      expect(receipt.encode(), original);
      expect(receipt.baseline.name, '  ');
      expect(receipt.baseline.otherUnits.values, {' Carton ': -2.5, 'Box': 3});
      expect(receipt.baseline.categories, [' Raw ', 'raw', 'raw']);
      expect(receipt.baseline.brand, ' Raw brand ');
      expect(receipt.baseline.description, ' Raw description ');
      expect(receipt.baseline.regieReportName, ' Raw report ');
      expect(receipt.baseline.baseUnit, ' pc ');

      expect(() {
        receipt.baseline.otherUnits.values['new'] = 1;
      }, throwsUnsupportedError);
      expect(() {
        receipt.baseline.categories.add('new');
      }, throwsUnsupportedError);
    },
  );

  test(
    'product delete codec rejects missing extra malformed and foreign intent',
    () {
      const fields = [
        'version',
        'operation',
        'scope',
        'nonce',
        'createdAt',
        'input',
        'baseline',
        'dispatching',
        'acknowledgement',
      ];

      for (final field in fields) {
        final envelope = _envelope();
        (envelope['json'] as Map<String, dynamic>).remove(field);

        expect(() {
          ProductDeleteReceipt.decode(jsonEncode(envelope));
        }, throwsFormatException);
      }

      for (final change in <void Function(Map<String, dynamic>)>[
        (data) {
          data['extra'] = true;
        },
        (data) {
          data['version'] = 1;
        },
        (data) {
          data['version'] = '2';
        },
        (data) {
          data['operation'] = 'update';
        },
        (data) {
          data['scope'] = '';
        },
        (data) {
          data['nonce'] = '0123456789ABCDEF0123456789ABCDEF';
        },
        (data) {
          data['nonce'] = 'short';
        },
        (data) {
          data['nonce'] = '0123456789abcdef0123456789abcdef\n';
        },
        (data) {
          data['dispatching'] = 'false';
        },
        (data) {
          data['input'] = {'id': 'other'};
        },
        (data) {
          data['input'] = {'id': ''};
        },
        (data) {
          data['baseline'] = null;
        },
        (data) {
          data['acknowledgement'] = {'success': false};
        },
        (data) {
          data['dispatching'] = true;
          data['acknowledgement'] = {'success': true};
        },
      ]) {
        final envelope = _envelope();

        change(envelope['json'] as Map<String, dynamic>);

        expect(() {
          ProductDeleteReceipt.decode(jsonEncode(envelope));
        }, throwsFormatException);
      }

      expect(() {
        ProductDeleteReceipt.decode('{bad');
      }, throwsFormatException);
    },
  );

  test(
    'product delete stages require dispatch and genuine acknowledgement',
    () {
      final prepared = _receipt();
      final dispatching = prepared.started();
      final acknowledged = dispatching.confirmed(
        const models.ProductsDeleteOutput(success: true),
      );

      expect(() {
        prepared.confirmed(const models.ProductsDeleteOutput(success: true));
      }, throwsStateError);
      expect(() {
        dispatching.started();
      }, throwsStateError);
      expect(() {
        dispatching.confirmed(
          const models.ProductsDeleteOutput(success: false),
        );
      }, throwsFormatException);
      expect(() {
        acknowledged.started();
      }, throwsStateError);
      expect(() {
        acknowledged.confirmed(
          const models.ProductsDeleteOutput(success: true),
        );
      }, throwsStateError);
    },
  );

  test('product delete receipt rejects untagged and pre100 journal dates', () {
    final envelope = _envelope();
    (envelope['meta'] as Map<String, dynamic>)['values'] = <String, dynamic>{};

    expect(() {
      ProductDeleteReceipt.decode(jsonEncode(envelope));
    }, throwsFormatException);
    expect(() {
      _receipt(createdAt: DateTime.utc(99)).encode();
    }, throwsFormatException);
  });

  test(
    'product delete receipt bounds UTF8 journal bytes before persistence',
    () {
      final small = _receipt(
        baseline: _product(name: List.filled(1000, 'ä').join()),
      );
      final oversized = _receipt(
        baseline: _product(name: List.filled(70000, 'ä').join()),
      );

      expect(
        ProductDeleteReceipt.decode(small.encode()).baseline.name.length,
        1000,
      );
      expect(oversized.baseline.name.length, lessThan(128 * 1024));
      expect(
        utf8.encode(oversized.baseline.name).length,
        greaterThan(128 * 1024),
      );
      expect(() {
        oversized.encode();
      }, throwsFormatException);
      expect(
        () {
          ProductDeleteReceipt.decode(List.filled(131073, 'x').join());
        },
        throwsA(
          isA<FormatException>().having(
            (error) {
              return error.message;
            },
            'message',
            'PRODUCT_DELETE_RECEIPT_TOO_LARGE',
          ),
        ),
      );
    },
  );

  test(
    'product delete baseline comparison owns every generated product field',
    () {
      final baseline = _product();
      final original = baseline.toWire();

      for (final change in <void Function(Map<String, dynamic>)>[
        (data) {
          data['id'] = 'other';
        },
        (data) {
          data['customId'] = 8;
        },
        (data) {
          data['name'] = 'Other';
        },
        (data) {
          data['description'] = null;
        },
        (data) {
          data['regieReportName'] = null;
        },
        (data) {
          data['brand'] = null;
        },
        (data) {
          data['baseUnit'] = 'other';
        },
        (data) {
          data['otherUnits'] = {'box': 99};
        },
        (data) {
          data['categories'] = ['different'];
        },
      ]) {
        final changed = Map<String, dynamic>.from(original);

        change(changed);

        expect(
          sameProductDeleteBaseline(baseline, models.Product.fromWire(changed)),
          isFalse,
        );
      }

      expect(
        sameProductDeleteBaseline(
          baseline,
          freezeProductDeleteBaseline(baseline),
        ),
        isTrue,
      );
    },
  );

  test(
    'product delete comparison ignores map order but owns raw list order',
    () {
      final baseline = _product(
        units: const {' B ': 2, 'A': 1},
        categories: const [' X ', 'x', 'x'],
      );
      final reordered = _product(
        units: const {'A': 1.0, ' B ': 2},
        categories: const [' X ', 'x', 'x'],
      );

      expect(sameProductDeleteBaseline(baseline, reordered), isTrue);
      expect(
        sameProductDeleteBaseline(
          baseline,
          _product(
            units: baseline.otherUnits.values,
            categories: ['x', 'x', ' X '],
          ),
        ),
        isFalse,
      );
      expect(
        sameProductDeleteBaseline(
          baseline,
          _product(units: baseline.otherUnits.values, categories: [' X ', 'x']),
        ),
        isFalse,
      );
      expect(
        sameProductDeleteBaseline(
          baseline,
          _product(
            units: const {'B': 2, 'A': 1},
            categories: baseline.categories,
          ),
        ),
        isFalse,
      );
    },
  );
}

Map<String, dynamic> _envelope() {
  return jsonDecode(_receipt().encode()) as Map<String, dynamic>;
}

ProductDeleteReceipt _receipt({models.Product? baseline, DateTime? createdAt}) {
  return ProductDeleteReceipt(
    scope: 'origin|tenant|actor|product',
    nonce: '0123456789abcdef0123456789abcdef',
    createdAt: createdAt ?? DateTime.utc(2024, 3),
    input: const models.ProductsDeleteInput(id: 'product'),
    baseline: baseline ?? _product(),
  );
}

models.Product _product({
  String name = ' Raw product ',
  Map<String, num> units = const {'box': 12},
  List<String> categories = const [' Raw ', 'raw', 'raw'],
}) {
  return models.Product(
    id: 'product',
    customId: 7,
    name: name,
    description: ' Raw description ',
    regieReportName: ' Raw report ',
    brand: ' Raw brand ',
    baseUnit: ' pc ',
    otherUnits: models.ApplyPriceImportRowOtherUnits(units),
    categories: categories,
  );
}
