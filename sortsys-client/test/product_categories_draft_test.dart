import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/features/products/product_categories_draft.dart';

void main() {
  test('copies product selections without reordering or normalizing', () {
    final categories = [' Zink ', 'İ', 'I', 'ΟΣ', 'οσ', 'Zink'];
    final product = models.Product(
      id: 'product-1',
      customId: 17,
      name: 'Paint',
      baseUnit: 'kg',
      otherUnits: models.ApplyPriceImportRowOtherUnits(const {}),
      categories: categories,
    );
    final draft = ProductCategoriesDraft.fromProduct(product);

    categories.clear();

    expect(draft.productId, 'product-1');
    expect(draft.categories, [' Zink ', 'İ', 'I', 'ΟΣ', 'οσ', 'Zink']);
    expect(draft.validate(), isEmpty);
    expect(() {
      draft.categories.add('Later');
    }, throwsUnsupportedError);
  });

  test(
    'copies constructor input and emits exact canonical raw wire values',
    () {
      final categories = [' B ', 'a', 'A', 'a'];
      final draft = ProductCategoriesDraft(
        productId: 'product / % 1',
        categories: categories,
      );

      categories[0] = 'Changed';

      final input = draft.setInput();

      expect(input.toWire(), {
        'id': 'product / % 1',
        'categories': [' B ', 'a', 'A', 'a'],
      });
      expect(() {
        input.categories.clear();
      }, throwsUnsupportedError);
    },
  );

  test('empty selection is a valid clear operation', () {
    final draft = ProductCategoriesDraft(productId: 'product-1');

    expect(draft.validate(), isEmpty);
    expect(draft.setInput().toWire(), {
      'id': 'product-1',
      'categories': <String>[],
    });
  });

  test('requires a known target and rejects invalid draft conversion', () {
    final draft = ProductCategoriesDraft(productId: '');

    expect(draft.validate(), {'id': ProductCategoriesDraftIssue.required});
    expect(draft.setInput, throwsFormatException);
  });

  test('trims exactly Unicode White_Space at the validation boundary', () {
    final whitespace = String.fromCharCodes([
      ...List.generate(5, (index) {
        return 0x0009 + index;
      }),
      0x0020,
      0x0085,
      0x00a0,
      0x1680,
      ...List.generate(11, (index) {
        return 0x2000 + index;
      }),
      0x2028,
      0x2029,
      0x202f,
      0x205f,
      0x3000,
    ]);

    expect(trimProductCategory(whitespace), '');
    expect(
      trimProductCategory('${whitespace}A${whitespace}B$whitespace'),
      'A${whitespace}B',
    );

    final draft = ProductCategoriesDraft(
      productId: 'product-1',
      categories: ['', whitespace],
    );

    expect(draft.validate(), {
      'category:0': ProductCategoriesDraftIssue.required,
      'category:1': ProductCategoriesDraftIssue.required,
    });
    expect(draft.setInput, throwsFormatException);
  });

  test('BOM and non-whitespace format characters remain category data', () {
    for (final value in ['\ufeff', '\u180e', '\u200b', '\u001c']) {
      final draft = ProductCategoriesDraft(
        productId: 'product-1',
        categories: [' $value '],
      );

      expect(trimProductCategory(' $value '), value);
      expect(draft.validate(), isEmpty);
      expect(draft.setInput().categories, [' $value ']);
    }
  });

  test('validates trimmed ASCII byte boundary without changing the wire', () {
    final boundary = List.filled(127, 'a').join();
    final draft = ProductCategoriesDraft(
      productId: 'product-1',
      categories: [' $boundary '],
    );
    final tooLong = ProductCategoriesDraft(
      productId: 'product-1',
      categories: ['${boundary}a'],
    );

    expect(draft.validate(), isEmpty);
    expect(draft.setInput().categories, [' $boundary ']);
    expect(tooLong.validate(), {
      'category:0': ProductCategoriesDraftIssue.tooLong,
    });
    expect(tooLong.setInput, throwsFormatException);
  });

  test('uses UTF8 bytes rather than UTF16 length for German categories', () {
    final boundary = '${List.filled(63, 'ä').join()}a';
    final oversized = [boundary, 'ä'].join();
    final tooLong = ProductCategoriesDraft(
      productId: 'product-1',
      categories: [oversized],
    );

    expect(utf8.encode(boundary).length, 127);
    expect(utf8.encode(oversized).length, 129);
    expect(
      ProductCategoriesDraft(
        productId: 'product-1',
        categories: [boundary],
      ).validate(),
      isEmpty,
    );
    expect(tooLong.validate(), {
      'category:0': ProductCategoriesDraftIssue.tooLong,
    });
  });

  test('preserves supplementary scalars and their UTF8 byte boundary', () {
    final boundary = '${List.filled(31, '😀').join()}abc';
    final oversized = [boundary, '😀'].join();
    final draft = ProductCategoriesDraft(
      productId: 'product-1',
      categories: ['\u0085$boundary\u0085'],
    );
    final tooLong = ProductCategoriesDraft(
      productId: 'product-1',
      categories: [oversized],
    );

    expect(utf8.encode(boundary).length, 127);
    expect(utf8.encode(oversized).length, 131);
    expect(trimProductCategory('\u0085$boundary\u0085'), boundary);
    expect(draft.validate(), isEmpty);
    expect(tooLong.validate(), {
      'category:0': ProductCategoriesDraftIssue.tooLong,
    });
  });

  test('checks every member before any server-side deduplication', () {
    final draft = ProductCategoriesDraft(
      productId: 'product-1',
      categories: ['valid', ' VALID ', ' ', List.filled(128, 'a').join()],
    );

    expect(draft.validate(), {
      'category:2': ProductCategoriesDraftIssue.required,
      'category:3': ProductCategoriesDraftIssue.tooLong,
    });
    expect(draft.setInput, throwsFormatException);
  });

  test('rejects unpaired surrogates that Rust JSON strings cannot accept', () {
    for (final value in [
      String.fromCharCode(0xd800),
      String.fromCharCode(0xdc00),
      String.fromCharCodes([0xd800, 0xd800]),
      String.fromCharCodes([0xdc00, 0xd800]),
      'A${String.fromCharCode(0xd800)}B',
    ]) {
      final draft = ProductCategoriesDraft(
        productId: 'product-1',
        categories: [value],
      );

      expect(draft.validate(), {
        'category:0': ProductCategoriesDraftIssue.invalidUnicode,
      });
      expect(draft.setInput, throwsFormatException);
    }
  });

  test('validation findings are immutable', () {
    final issues = ProductCategoriesDraft(productId: '').validate();

    expect(() {
      issues.clear();
    }, throwsUnsupportedError);
  });
}
