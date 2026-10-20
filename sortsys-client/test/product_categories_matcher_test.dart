import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/features/products/product_categories_matcher.dart';

void main() {
  test(
    'category lowercase uses default case conversion rather than folding',
    () {
      const examples = {
        'I': 'i',
        'İ': 'i\u0307',
        'I\u0307': 'i\u0307',
        'ı': 'ı',
        'ÄÖÜẞ': 'äöüß',
        'Straße': 'straße',
        'STRASSE': 'strasse',
        'ﬀ': 'ﬀ',
        'Σ': 'σ',
        'ΟΣ': 'ος',
        'ΟΣΑ': 'οσα',
        'Ος': 'ος',
        'οσ': 'οσ',
      };

      for (final entry in examples.entries) {
        expect(lowercaseProductCategory(entry.key), entry.value);
      }
    },
  );

  test('sigma context uses pinned cased and case-ignorable properties', () {
    const examples = {
      "AΣ'A": "aσ'a",
      "AΣ'": "aς'",
      'ªΣ': 'ªς',
      'ʕΣ': 'ʕσ',
      'AΣ\u0345A': 'aσ\u0345a',
      'AΣ\u0345': 'aς\u0345',
      'AΣ\u1acfA': 'aσ\u1acfa',
      'AΣ\u1acf': 'aς\u1acf',
      'A Σ': 'a σ',
    };

    for (final entry in examples.entries) {
      expect(lowercaseProductCategory(entry.key), entry.value);
    }
  });

  test('category mappings include scripts absent from native lowercase', () {
    const pairs = [
      (0x037f, 0x03f3),
      (0x0524, 0x0525),
      (0x10c7, 0x2d27),
      (0x13a0, 0xab70),
      (0x1c90, 0x10d0),
      (0x10400, 0x10428),
      (0x118a0, 0x118c0),
      (0x1e900, 0x1e922),
    ];

    for (final (source, expected) in pairs) {
      expect(
        lowercaseProductCategory(String.fromCharCode(source)),
        String.fromCharCode(expected),
      );
    }
  });

  test('category query trim follows ECMAScript instead of Rust or Dart', () {
    final whitespace = String.fromCharCodes([
      ...List.generate(5, (index) {
        return 0x0009 + index;
      }),
      0x0020,
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
      0xfeff,
    ]);

    expect(
      normalizeProductCategoryQuery([whitespace, 'A', whitespace].join()),
      'a',
    );
    expect(normalizeProductCategoryQuery(' \u0085A\u0085 '), '\u0085a\u0085');
    expect(normalizeProductCategoryQuery('\u180eA\u180e'), '\u180ea\u180e');
  });

  test(
    'empty category query shows all current selections only and copies them',
    () {
      final selected = List.generate(25, (index) {
        return ' Selected $index ';
      });
      final matches = matchProductCategories(
        options: ['Other'],
        query: ' \ufeff\t',
        selected: selected,
      );

      selected.clear();

      expect(matches.length, 25);
      expect(matches.first, ' Selected 0 ');
      expect(matches.last, ' Selected 24 ');
      expect(() {
        matches.clear();
      }, throwsUnsupportedError);
    },
  );

  test(
    'category matching keeps first20 source options and selected matches',
    () {
      final options = List.generate(25, (index) {
        return 'Group $index';
      });
      final matches = matchProductCategories(
        options: options,
        query: ' GROUP ',
        selected: ['Group 0', 'Group 24'],
      );

      expect(matches, options.take(20));
      expect(matches.first, 'Group 0');
      expect(matches, isNot(contains('Group 24')));
      expect(options.length, 25);
      expect(() {
        matches.add('New');
      }, throwsUnsupportedError);
    },
  );

  test(
    'category filtering preserves raw IDs and full JavaScript semantics',
    () {
      const options = ['İ', 'I', 'ΟΣ', 'οσ', 'Ος', 'Straße', 'STRASSE', ' A '];

      List<String> matches(String query) {
        return matchProductCategories(options: options, query: query);
      }

      expect(matches('i'), ['İ', 'I']);
      expect(matches('i\u0307'), ['İ']);
      expect(matches('ΟΣ'), ['ΟΣ', 'Ος']);
      expect(matches('σ'), ['οσ']);
      expect(matches('strasse'), ['STRASSE']);
      expect(matches(' A '), ['Straße', 'STRASSE', ' A ']);
      expect(matches('Unknown'), isEmpty);
    },
  );

  test(
    'category lowercase preserves partial UTF16 and does not normalize NFC',
    () {
      final partial = String.fromCharCodes([0xd800, 0x41, 0xdc00]);
      final expected = String.fromCharCodes([0xd800, 0x61, 0xdc00]);

      expect(lowercaseProductCategory(partial), expected);
      expect(lowercaseProductCategory('A\u0308'), 'a\u0308');
      expect(lowercaseProductCategory('Ä'), 'ä');
      expect(lowercaseProductCategory('A\u0308'), isNot('ä'));
    },
  );

  test(
    'sigma context crosses long case-ignorable runs without changing them',
    () {
      final marks = List.filled(25000, '\u0345').join();

      expect(
        lowercaseProductCategory(['AΣ', marks, 'A'].join()),
        ['aσ', marks, 'a'].join(),
      );
      expect(
        lowercaseProductCategory(['AΣ', marks].join()),
        ['aς', marks].join(),
      );
    },
  );
}
