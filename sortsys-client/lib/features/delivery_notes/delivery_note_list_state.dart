import 'dart:convert';
import 'dart:math' as math;

import '../../api/generated/models.g.dart' as models;

const deliveryNotePageSizes = [25, 50, 100];

enum DeliveryNoteSortColumn { number, created, effective, comment }

final class DeliveryNoteListState {
  const DeliveryNoteListState({
    this.page = 0,
    this.pageSize = 25,
    this.column,
    this.descending = false,
  });

  final int page;
  final int pageSize;
  final DeliveryNoteSortColumn? column;
  final bool descending;

  factory DeliveryNoteListState.fromUri(Uri uri) {
    String? parameter(String name) {
      return uri.queryParametersAll[name]?.first;
    }

    final size = int.tryParse(parameter('pageSizeDeliveryNotes') ?? '');
    Object? sorting;

    try {
      sorting = jsonDecode(parameter('sortDeliveryNotes') ?? 'null');
    } on FormatException {
      sorting = null;
    }

    DeliveryNoteSortColumn? column;
    var descending = false;

    if (sorting is List<Object?> && sorting.length == 2) {
      final index = sorting[0];
      final order = sorting[1];

      if (index is int &&
          index >= 0 &&
          index < DeliveryNoteSortColumn.values.length &&
          (order == 'ASC' || order == 'DESC')) {
        column = DeliveryNoteSortColumn.values[index];
        descending = order == 'DESC';
      }
    }

    return DeliveryNoteListState(
      page: math.max(0, int.tryParse(parameter('pageDeliveryNotes') ?? '') ?? 0),
      pageSize: deliveryNotePageSizes.contains(size) ? size! : 25,
      column: column,
      descending: descending,
    );
  }

  Uri apply(
    Uri uri, {
    int? page,
    int? pageSize,
    DeliveryNoteSortColumn? toggleColumn,
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

    for (final key in [
      'pageDeliveryNotes',
      'pageSizeDeliveryNotes',
      'sortDeliveryNotes',
    ]) {
      parameters.remove(key);
    }

    if (nextPage > 0) {
      parameters['pageDeliveryNotes'] = ['$nextPage'];
    }

    if (deliveryNotePageSizes.contains(nextSize) && nextSize != 25) {
      parameters['pageSizeDeliveryNotes'] = ['$nextSize'];
    }

    if (nextColumn != null) {
      parameters['sortDeliveryNotes'] = [
        jsonEncode([nextColumn.index, nextDescending ? 'DESC' : 'ASC']),
      ];
    }

    return uri.replace(queryParameters: parameters);
  }
}

String deliveryNoteNumber(models.DeliveryNote note) {
  return note.autoId.toString().replaceFirst(RegExp(r'\.0$'), '');
}

List<models.DeliveryNote> sortedDeliveryNotes(
  List<models.DeliveryNote> notes,
  DeliveryNoteListState state,
) {
  final column = state.column;

  if (column == null) {
    return List.of(notes);
  }

  final indexed = notes.indexed.toList();

  indexed.sort((left, right) {
    int comparison;

    if (column == DeliveryNoteSortColumn.comment) {
      final a = (left.$2.comment ?? '').toLowerCase();
      final b = (right.$2.comment ?? '').toLowerCase();

      if (a.isEmpty && b.isNotEmpty) {
        comparison = 1;
      } else if (b.isEmpty && a.isNotEmpty) {
        comparison = -1;
      } else {
        comparison = a.compareTo(b) * (state.descending ? -1 : 1);
      }
    } else {
      comparison = switch (column) {
        DeliveryNoteSortColumn.number => left.$2.autoId.compareTo(right.$2.autoId),
        DeliveryNoteSortColumn.created => left.$2.createdAt.compareTo(right.$2.createdAt),
        DeliveryNoteSortColumn.effective => left.$2.effectiveTimestamp.compareTo(
          right.$2.effectiveTimestamp,
        ),
        DeliveryNoteSortColumn.comment => 0,
      };
      comparison *= state.descending ? -1 : 1;
    }

    if (comparison == 0) {
      return left.$1.compareTo(right.$1);
    }

    return comparison;
  });

  return [for (final entry in indexed) entry.$2];
}
