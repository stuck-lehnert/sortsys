import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/contract.dart' show jsonMap;
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/api/model.dart';
import 'package:sortsys_client/api/wire.dart';
import 'package:sortsys_client/features/products/product_categories_inputs.dart';
import 'package:sortsys_client/features/products/product_categories_receipt.dart';

const _nonce = '00112233445566778899aabbccddeeff';
const _fields = {
  'version',
  'scope',
  'nonce',
  'createdAt',
  'input',
  'baselineCategories',
  'dispatching',
  'acknowledgement',
};

void main() {
  test(
    'category storage normalization preserves first spellings and raw wire',
    () {
      final raw = [
        ' Zink ',
        'zink',
        'İ',
        'i\u0307',
        'I',
        'Σ',
        'ς',
        ' AΣ',
        'aς',
        'Straße',
        'STRASSE',
      ];
      final original = List<String>.of(raw);
      final input = models.ProductsCategoriesSetInput(
        id: 'product-1',
        categories: raw,
      );

      final stored = productCategoriesStoredValues(input);

      expect(stored, ['Zink', 'İ', 'I', 'Σ', 'ς', 'AΣ', 'Straße', 'STRASSE']);
      expect(input.categories, original);
      expect(raw, original);
      expect(input.categories.first, ' Zink ');
      expect(() {
        stored.clear();
      }, throwsUnsupportedError);
    },
  );

  test(
    'stored category trimming retains BOM but removes Rust NEL whitespace',
    () {
      final input = models.ProductsCategoriesSetInput(
        id: 'product-1',
        categories: ['\u0085Paint\u0085', '\ufeff', ' \ufeff '],
      );

      expect(productCategoriesStoredValues(input), ['Paint', '\ufeff']);
      expect(input.categories, ['\u0085Paint\u0085', '\ufeff', ' \ufeff ']);
    },
  );

  test('category input checks every member before normalization', () {
    for (final categories in [
      ['valid', ' '],
      ['valid', List.filled(128, 'a').join()],
      [String.fromCharCode(0xd800)],
    ]) {
      final input = models.ProductsCategoriesSetInput(
        id: 'product-1',
        categories: categories,
      );

      expect(() {
        checkProductCategoriesInput(input);
      }, throwsFormatException);
      expect(() {
        productCategoriesStoredValues(input);
      }, throwsFormatException);
    }
  });

  test(
    'category snapshots are exact multisets rather than sorted or folded',
    () {
      expect(
        sameProductCategoryValues(['A', 'B', 'A'], ['A', 'A', 'B']),
        isTrue,
      );
      expect(
        sameProductCategoryValues(['A', 'B', 'A'], ['A', 'B', 'B']),
        isFalse,
      );
      expect(sameProductCategoryValues(['A'], ['a']), isFalse);
      expect(sameProductCategoryValues(['A'], ['A', 'A']), isFalse);
    },
  );

  test('category readback needs known ID and exact normalized values', () {
    final input = _receipt().input;

    expect(productCategoriesInputMatches(input, _product(['A', 'B'])), isTrue);
    expect(productCategoriesInputMatches(input, _product(['a', 'B'])), isFalse);
    expect(
      productCategoriesInputMatches(input, _product(['A', 'B', 'A'])),
      isFalse,
    );
    expect(
      productCategoriesInputMatches(input, _product(['A', 'B'], id: 'other')),
      isFalse,
    );
  });

  test('category receipt copies raw input and baseline through dated wire', () {
    final categories = [' B ', 'b', 'A'];
    final baseline = ['Old'];
    final receipt = _receipt(categories: categories, baseline: baseline);

    categories.clear();
    baseline.clear();

    final decoded = ProductCategoriesWriteReceipt.decode(receipt.encode());

    expect(decoded.scope, 'scope');
    expect(decoded.nonce, _nonce);
    expect(decoded.createdAt, DateTime.utc(2026, 1, 2));
    expect(encodeRpcValue(decoded.input), {
      'id': 'product-1',
      'categories': [' B ', 'b', 'A'],
    });
    expect(decoded.baselineCategories, ['Old']);
    expect(decoded.dispatching, isFalse);
    expect(decoded.acknowledged, isFalse);
    expect(() {
      decoded.input.categories.clear();
    }, throwsUnsupportedError);
    expect(() {
      decoded.baselineCategories.clear();
    }, throwsUnsupportedError);
  });

  test(
    'category receipt stages accept exactly one genuine acknowledgement',
    () {
      final pending = _receipt();
      final started = pending.started();
      final confirmed = started.confirmed(
        const models.ProductsCategoriesSetOutput(success: true),
      );
      final decoded = ProductCategoriesWriteReceipt.decode(confirmed.encode());

      expect(started.dispatching, isTrue);
      expect(started.acknowledged, isFalse);
      expect(decoded.dispatching, isFalse);
      expect(decoded.acknowledgement?.success, isTrue);
      expect(started.started, throwsStateError);
      expect(confirmed.started, throwsStateError);
      expect(() {
        pending.confirmed(
          const models.ProductsCategoriesSetOutput(success: true),
        );
      }, throwsStateError);
      expect(() {
        confirmed.confirmed(
          const models.ProductsCategoriesSetOutput(success: true),
        );
      }, throwsStateError);
      expect(() {
        started.confirmed(
          const models.ProductsCategoriesSetOutput(success: false),
        );
      }, throwsFormatException);
    },
  );

  test('category receipts confirm owned fields only after dispatch', () {
    final pending = _receipt();
    final started = pending.started();
    final product = _product(['A', 'B'], name: 'Changed independently');

    expect(pending.confirms(product), isFalse);
    expect(started.confirms(product), isTrue);
    expect(started.confirms(_product(['A', 'B'], id: 'other')), isFalse);
    expect(started.confirms(_product(['A', 'Changed'])), isFalse);
  });

  test(
    'category receipt rejects every missing field and all unknown fields',
    () {
      for (final field in _fields) {
        final encoded = _change(_receipt(), (data) {
          data.remove(field);
        });

        expect(() {
          ProductCategoriesWriteReceipt.decode(encoded);
        }, throwsFormatException);
      }

      final encoded = _change(_receipt(), (data) {
        data['unknown'] = true;
      });

      expect(() {
        ProductCategoriesWriteReceipt.decode(encoded);
      }, throwsFormatException);
    },
  );

  test(
    'category receipt rejects foreign versions scopes and malformed nonces',
    () {
      for (final entry in [
        MapEntry('version', 2),
        MapEntry('scope', ''),
        MapEntry('nonce', _nonce.toUpperCase()),
        MapEntry('nonce', '$_nonce\n'),
        const MapEntry('nonce', 'short'),
      ]) {
        final encoded = _change(_receipt(), (data) {
          data[entry.key] = entry.value;
        });

        expect(() {
          ProductCategoriesWriteReceipt.decode(encoded);
        }, throwsFormatException);
      }
    },
  );

  test('category receipt requires a tagged valid operation date', () {
    for (final value in [null, '2026-01-02', DateTime.utc(99)]) {
      final encoded = _change(_receipt(), (data) {
        data['createdAt'] = value;
      });

      expect(() {
        ProductCategoriesWriteReceipt.decode(encoded);
      }, throwsFormatException);
    }
  });

  test(
    'category receipt rejects incompatible stage and acknowledgement types',
    () {
      for (final change in <void Function(Map<String, Object?>)>[
        (data) {
          data['dispatching'] = true;
          data['acknowledgement'] = {'success': true};
        },
        (data) {
          data['acknowledgement'] = {'success': false};
        },
        (data) {
          data['acknowledgement'] = true;
        },
        (data) {
          data['dispatching'] = 'true';
        },
      ]) {
        final encoded = _change(_receipt(), change);

        expect(() {
          ProductCategoriesWriteReceipt.decode(encoded);
        }, throwsFormatException);
      }
    },
  );

  test('category receipt rejects invalid and expanded mutation payloads', () {
    for (final input in [
      {'id': '', 'categories': <String>[]},
      {
        'id': 'product-1',
        'categories': [1],
      },
      {
        'id': 'product-1',
        'categories': [' '],
      },
      {
        'id': 'product-1',
        'categories': ['A'],
        'name': 'Not owned',
      },
    ]) {
      final encoded = _change(_receipt(), (data) {
        data['input'] = input;
      });

      expect(() {
        ProductCategoriesWriteReceipt.decode(encoded);
      }, throwsFormatException);
    }
  });

  test('category receipt bounds serialized UTF8 bytes before persistence', () {
    final receipt = _receipt(baseline: [List.filled(70000, 'ä').join()]);

    expect(receipt.encode, throwsFormatException);
    expect(() {
      ProductCategoriesWriteReceipt.decode(List.filled(131073, ' ').join());
    }, throwsFormatException);
  });

  test('category receipt baseline is a strict raw string list', () {
    final receipt = _receipt(baseline: [' Old ', 'Old', 'Old']);
    final decoded = ProductCategoriesWriteReceipt.decode(receipt.encode());

    expect(decoded.baselineCategories, [' Old ', 'Old', 'Old']);

    for (final value in [
      null,
      'Old',
      [1],
    ]) {
      final encoded = _change(receipt, (data) {
        data['baselineCategories'] = value;
      });

      expect(() {
        ProductCategoriesWriteReceipt.decode(encoded);
      }, throwsFormatException);
    }
  });

  test(
    'category clear receipt confirms only an empty known-target readback',
    () {
      final receipt = _receipt(categories: const []).started();

      expect(receipt.confirms(_product([])), isTrue);
      expect(receipt.confirms(_product(['Old'])), isFalse);
      expect(receipt.confirms(_product([], id: 'other')), isFalse);
    },
  );
}

ProductCategoriesWriteReceipt _receipt({
  List<String> categories = const [' B ', 'b', 'A'],
  List<String> baseline = const ['Old'],
}) {
  return ProductCategoriesWriteReceipt(
    scope: 'scope',
    nonce: _nonce,
    createdAt: DateTime.utc(2026, 1, 2),
    input: models.ProductsCategoriesSetInput(
      id: 'product-1',
      categories: categories,
    ),
    baselineCategories: baseline,
  );
}

models.Product _product(
  List<String> categories, {
  String id = 'product-1',
  String name = 'Paint',
}) {
  return models.Product(
    id: id,
    customId: 1,
    name: name,
    baseUnit: 'kg',
    otherUnits: models.ApplyPriceImportRowOtherUnits(const {}),
    categories: categories,
  );
}

String _change(
  ProductCategoriesWriteReceipt receipt,
  void Function(Map<String, Object?>) change,
) {
  final decoded = deserializeWire(jsonMap(jsonDecode(receipt.encode())));
  final data = Map<String, Object?>.from(readRpcObject(decoded, _fields));

  change(data);

  return jsonEncode(serializeWire(data));
}
