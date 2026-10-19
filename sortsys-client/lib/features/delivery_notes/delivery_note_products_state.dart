import 'dart:convert';
import 'dart:math' as math;

import '../../api/generated/models.g.dart' as models;
import 'delivery_note_quantities.dart';

enum DeliveryProductSort { averagePrice, cost }

const deliveryProductPageSizes = [25, 50, 100];

final class DeliveryNoteProductsState {
  const DeliveryNoteProductsState({
    this.page = 0,
    this.pageSize = 25,
    this.column,
    this.descending = false,
  });

  final int page;
  final int pageSize;
  final DeliveryProductSort? column;
  final bool descending;

  factory DeliveryNoteProductsState.fromUri(Uri uri) {
    String? parameter(String key) {
      return uri.queryParametersAll[key]?.first;
    }

    final size = int.tryParse(parameter('pageSizeProducts') ?? '');
    Object? sorting;

    try {
      sorting = jsonDecode(parameter('sortProducts') ?? 'null');
    } on FormatException {
      sorting = null;
    }

    DeliveryProductSort? column;
    var descending = false;

    if (sorting is List<Object?> && sorting.length == 2) {
      final index = sorting[0];
      final order = sorting[1];

      // The first three canonical product columns have no sort keys.
      if (index is int &&
          (index == 3 || index == 4) &&
          (order == 'ASC' || order == 'DESC')) {
        column = DeliveryProductSort.values[index - 3];
        descending = order == 'DESC';
      }
    }

    return DeliveryNoteProductsState(
      page: math.max(0, int.tryParse(parameter('pageProducts') ?? '') ?? 0),
      pageSize: deliveryProductPageSizes.contains(size) ? size! : 25,
      column: column,
      descending: descending,
    );
  }

  Uri apply(
    Uri uri, {
    int? page,
    int? pageSize,
    DeliveryProductSort? toggleColumn,
  }) {
    final parameters = {
      for (final entry in uri.queryParametersAll.entries)
        entry.key: List<String>.of(entry.value),
    };
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

    final nextPage = page ?? this.page;
    final nextSize = pageSize ?? this.pageSize;

    for (final key in ['pageProducts', 'pageSizeProducts', 'sortProducts']) {
      parameters.remove(key);
    }

    if (nextPage > 0) {
      parameters['pageProducts'] = ['$nextPage'];
    }

    if (deliveryProductPageSizes.contains(nextSize) && nextSize != 25) {
      parameters['pageSizeProducts'] = ['$nextSize'];
    }

    if (nextColumn != null) {
      parameters['sortProducts'] = [
        jsonEncode([nextColumn.index + 3, nextDescending ? 'DESC' : 'ASC']),
      ];
    }

    return uri.replace(queryParameters: parameters);
  }
}

List<models.DeliveryNoteRecordsItem> sortedDeliveryProducts(
  List<models.DeliveryNoteRecordsItem> records,
  models.DeliveryNotesCostsGetOutput? costs,
  DeliveryNoteProductsState state,
) {
  final column = state.column;

  if (column == null) {
    return List.of(records);
  }

  num value(models.DeliveryNoteRecordsItem record) {
    return switch (column) {
      DeliveryProductSort.averagePrice =>
        deliveryAverageUnitPrice(costs, record.id, record.quantity) ?? 0,
      DeliveryProductSort.cost => deliveryRecordCost(costs, record.id) ?? 0,
    };
  }

  final indexed = records.indexed.toList();

  indexed.sort((left, right) {
    final comparison = value(left.$2).compareTo(value(right.$2));

    if (comparison == 0) {
      return left.$1.compareTo(right.$1);
    }

    return state.descending ? -comparison : comparison;
  });

  return [for (final entry in indexed) entry.$2];
}
