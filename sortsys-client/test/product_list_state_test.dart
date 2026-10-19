import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/features/products/product_list_state.dart';

void main() {
  test(
    'Products URL state uses first values and rejects invalid sort payloads',
    () {
      final uri = Uri(
        path: '/products',
        queryParameters: {
          'pageProducts': ['3', '9'],
          'pageSizeProducts': ['50', '100'],
          'sortProducts': [
            jsonEncode([2, 'DESC']),
            jsonEncode([0, 'ASC']),
          ],
        },
      );
      final state = ProductListState.fromUri(uri);

      expect(state.page, 3);
      expect(state.pageSize, 50);
      expect(state.column, ProductSortColumn.brand);
      expect(state.descending, isTrue);

      for (final payload in [
        'broken',
        'null',
        '[3,"ASC"]',
        '[-1,"ASC"]',
        '[0,"asc"]',
        '[true,"ASC"]',
        '[0,"ASC",1]',
      ]) {
        final invalid = ProductListState.fromUri(
          Uri(
            path: '/products',
            queryParameters: {
              'pageProducts': '-2',
              'pageSizeProducts': '99',
              'sortProducts': payload,
            },
          ),
        );

        expect(invalid.page, 0);
        expect(invalid.pageSize, 25);
        expect(invalid.column, isNull);
      }
    },
  );

  test(
    'Products sort cycle preserves filters, repeated values and fragments',
    () {
      final uri = Uri.parse(
        '/products?brand=A&category=B&keep=one&keep=two&pageProducts=3#prices',
      );
      final first = ProductListState.fromUri(uri)
          .apply(uri, toggleColumn: ProductSortColumn.name);
      final second = ProductListState.fromUri(first)
          .apply(first, toggleColumn: ProductSortColumn.name);
      final third = ProductListState.fromUri(second)
          .apply(second, toggleColumn: ProductSortColumn.name);

      expect(jsonDecode(first.queryParameters['sortProducts']!), [1, 'ASC']);
      expect(jsonDecode(second.queryParameters['sortProducts']!), [1, 'DESC']);
      expect(third.queryParameters.containsKey('sortProducts'), isFalse);
      expect(third.queryParametersAll['keep'], ['one', 'two']);
      expect(third.queryParameters['brand'], 'A');
      expect(third.queryParameters['category'], 'B');
      expect(third.fragment, 'prices');

      final resized = ProductListState.fromUri(third)
          .apply(third, page: 0, pageSize: 100);

      expect(resized.queryParameters.containsKey('pageProducts'), isFalse);
      expect(resized.queryParameters['pageSizeProducts'], '100');
      expect(resized.queryParametersAll['keep'], ['one', 'two']);
    },
  );

  test('product request sends only nullable category and retains filter values', () {
    final filter = ProductListFilter.fromUri(
      Uri.parse(
        '/products?category=%20Dry%20&category=ignored&brand=ACME&brand=ignored',
      ),
    );

    expect(filter.category, ' Dry ');
    expect(filter.brand, 'ACME');
    expect(filter.input().toWire(), {'category': ' Dry '});
    expect(const ProductListFilter().input().toWire(), {'category': null});
    expect(filter.hasFilter, isTrue);
    expect(const ProductListFilter(brand: '').hasFilter, isFalse);

    final uri = Uri.parse(
      '/products?brand=old&category=old&keep=one&keep=two&pageProducts=4#part',
    );
    final cleared = const ProductListFilter().apply(uri);

    expect(cleared.queryParameters.containsKey('brand'), isFalse);
    expect(cleared.queryParameters.containsKey('category'), isFalse);
    expect(cleared.queryParametersAll['keep'], ['one', 'two']);
    expect(cleared.queryParameters['pageProducts'], '4');
    expect(cleared.fragment, 'part');
  });

  test('brand matching is local, case insensitive, exact and nonmutating', () {
    final plain = _product('plain', 1, 'Cement', brand: 'Acme');
    final spaced = _product('spaced', 2, 'Plaster', brand: ' ACME ');
    final absent = _product('absent', 3, 'Sand');
    final products = [plain, spaced, absent];

    expect(const ProductListFilter(brand: 'aCME').filterBrand(products), [
      plain,
    ]);
    expect(const ProductListFilter(brand: ' acme ').filterBrand(products), [
      spaced,
    ]);
    expect(
      const ProductListFilter(brand: 'unknown').filterBrand(products),
      isEmpty,
    );
    expect(const ProductListFilter().filterBrand(products), products);
    expect(products, [plain, spaced, absent]);
  });

  test('product sorting is numeric, stable, lowercase and empty-last', () {
    final first = _product('first', 10, 'cement', brand: 'Beta');
    final second = _product('second', 2, 'CEMENT', brand: 'alpha');
    final empty = _product('empty', 3, '', brand: null);
    final products = [first, second, empty];

    expect(
      sortedProducts(
        products,
        const ProductListState(column: ProductSortColumn.number),
      ),
      [second, empty, first],
    );
    expect(
      sortedProducts(
        products,
        const ProductListState(column: ProductSortColumn.name),
      ),
      [first, second, empty],
    );
    expect(
      sortedProducts(
        products,
        const ProductListState(
          column: ProductSortColumn.brand,
          descending: true,
        ),
      ),
      [first, second, empty],
    );
    expect(sortedProducts(products, const ProductListState()), products);
    expect(products, [first, second, empty]);
  });
}

models.Product _product(String id, num number, String name, {String? brand}) {
  return models.Product(
    id: id,
    customId: number,
    name: name,
    brand: brand,
    baseUnit: 'kg',
    otherUnits: const models.ApplyPriceImportRowOtherUnits({}),
    categories: const [],
  );
}
