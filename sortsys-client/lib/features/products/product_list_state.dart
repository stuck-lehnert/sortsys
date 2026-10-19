import 'dart:convert';
import 'dart:math' as math;

import '../../api/generated/models.g.dart' as models;
import '../../api/model.dart';

const productPageSizes = [25, 50, 100];

enum ProductSortColumn { number, name, brand }

final class ProductListFilter {
  const ProductListFilter({this.category, this.brand});

  factory ProductListFilter.fromUri(Uri uri) {
    return ProductListFilter(
      category: uri.queryParametersAll['category']?.first,
      brand: uri.queryParametersAll['brand']?.first,
    );
  }

  final String? category;
  final String? brand;

  bool get hasFilter {
    return category?.isNotEmpty == true || brand?.isNotEmpty == true;
  }

  models.ProductsListInput input() {
    return models.ProductsListInput(category: RpcOptional.value(category));
  }

  List<models.Product> filterBrand(List<models.Product> products) {
    final selected = brand;

    if (selected == null || selected.isEmpty) {
      return List.of(products);
    }

    final normalized = selected.toLowerCase();

    return products.where((product) {
      return (product.brand ?? '').toLowerCase() == normalized;
    }).toList();
  }

  Uri apply(Uri uri) {
    final parameters = {
      for (final entry in uri.queryParametersAll.entries)
        entry.key: List<String>.of(entry.value),
    };
    parameters.remove('brand');
    parameters.remove('category');

    if (brand != null) {
      parameters['brand'] = [brand!];
    }

    if (category != null) {
      parameters['category'] = [category!];
    }

    return uri.replace(queryParameters: parameters);
  }
}

final class ProductListState {
  const ProductListState({
    this.page = 0,
    this.pageSize = 25,
    this.column,
    this.descending = false,
  });

  final int page;
  final int pageSize;
  final ProductSortColumn? column;
  final bool descending;

  factory ProductListState.fromUri(Uri uri) {
    String? parameter(String name) {
      return uri.queryParametersAll[name]?.first;
    }

    final size = int.tryParse(parameter('pageSizeProducts') ?? '');
    Object? sorting;

    try {
      sorting = jsonDecode(parameter('sortProducts') ?? 'null');
    } on FormatException {
      sorting = null;
    }

    ProductSortColumn? column;
    var descending = false;

    if (sorting is List<Object?> && sorting.length == 2) {
      final index = sorting[0];
      final order = sorting[1];

      if (index is int &&
          index >= 0 &&
          index < ProductSortColumn.values.length &&
          (order == 'ASC' || order == 'DESC')) {
        column = ProductSortColumn.values[index];
        descending = order == 'DESC';
      }
    }

    return ProductListState(
      page: math.max(0, int.tryParse(parameter('pageProducts') ?? '') ?? 0),
      pageSize: productPageSizes.contains(size) ? size! : 25,
      column: column,
      descending: descending,
    );
  }

  Uri apply(
    Uri uri, {
    int? page,
    int? pageSize,
    ProductSortColumn? toggleColumn,
  }) {
    final parameters = {
      for (final entry in uri.queryParametersAll.entries)
        entry.key: List<String>.of(entry.value),
    };
    final nextPage = page ?? this.page;
    final nextSize = pageSize ?? this.pageSize;
    var nextColumn = column;
    var nextDescending = descending;

    if (toggleColumn != null) {
      if (column != toggleColumn) {
        nextColumn = toggleColumn;
        nextDescending = false;
      } else if (!descending) {
        nextDescending = true;
      } else {
        nextColumn = null;
        nextDescending = false;
      }
    }

    for (final key in ['pageProducts', 'pageSizeProducts', 'sortProducts']) {
      parameters.remove(key);
    }

    if (nextPage > 0) {
      parameters['pageProducts'] = ['$nextPage'];
    }

    if (productPageSizes.contains(nextSize) && nextSize != 25) {
      parameters['pageSizeProducts'] = ['$nextSize'];
    }

    if (nextColumn != null) {
      parameters['sortProducts'] = [
        jsonEncode([nextColumn.index, nextDescending ? 'DESC' : 'ASC']),
      ];
    }

    return uri.replace(queryParameters: parameters);
  }
}

List<models.Product> sortedProducts(
  List<models.Product> products,
  ProductListState state,
) {
  final column = state.column;

  if (column == null) {
    return List.of(products);
  }

  final indexed = products.indexed.toList();

  indexed.sort((left, right) {
    int comparison;

    if (column == ProductSortColumn.number) {
      comparison = left.$2.customId.compareTo(right.$2.customId);
      comparison *= state.descending ? -1 : 1;
    } else {
      final a =
          (column == ProductSortColumn.name
                  ? left.$2.name
                  : left.$2.brand ?? '')
              .toLowerCase();
      final b =
          (column == ProductSortColumn.name
                  ? right.$2.name
                  : right.$2.brand ?? '')
              .toLowerCase();

      if (a.isEmpty && b.isNotEmpty) {
        comparison = 1;
      } else if (b.isEmpty && a.isNotEmpty) {
        comparison = -1;
      } else {
        comparison = a.compareTo(b) * (state.descending ? -1 : 1);
      }
    }

    if (comparison == 0) {
      return left.$1.compareTo(right.$1);
    }

    return comparison;
  });

  return [for (final entry in indexed) entry.$2];
}
