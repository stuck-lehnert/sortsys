import 'dart:convert';
import 'dart:math' as math;

import '../../api/generated/models.g.dart' as models;
import 'tool_detail_layout.dart';

const toolPageSizes = [25, 50, 100];

enum ToolSortColumn { number, status, brand, category, model }

final class ToolListState {
  const ToolListState({
    this.page = 0,
    this.pageSize = 25,
    this.column,
    this.descending = false,
  });

  final int page;
  final int pageSize;
  final ToolSortColumn? column;
  final bool descending;

  factory ToolListState.fromUri(Uri uri) {
    String? parameter(String name) {
      return uri.queryParametersAll[name]?.first;
    }

    final size = int.tryParse(parameter('pageSizeTools') ?? '');
    Object? sorting;

    try {
      sorting = jsonDecode(parameter('sortTools') ?? 'null');
    } on FormatException {
      sorting = null;
    }

    ToolSortColumn? column;
    var descending = false;

    if (sorting is List<Object?> && sorting.length == 2) {
      final index = sorting[0];
      final order = sorting[1];

      if (index is int &&
          index >= 0 &&
          index < ToolSortColumn.values.length &&
          (order == 'ASC' || order == 'DESC')) {
        column = ToolSortColumn.values[index];
        descending = order == 'DESC';
      }
    }

    return ToolListState(
      page: math.max(0, int.tryParse(parameter('pageTools') ?? '') ?? 0),
      pageSize: toolPageSizes.contains(size) ? size! : 25,
      column: column,
      descending: descending,
    );
  }

  Uri apply(
    Uri uri, {
    int? page,
    int? pageSize,
    ToolSortColumn? toggleColumn,
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

    for (final key in ['pageTools', 'pageSizeTools', 'sortTools']) {
      parameters.remove(key);
    }

    if (nextPage > 0) {
      parameters['pageTools'] = ['$nextPage'];
    }

    if (toolPageSizes.contains(nextSize) && nextSize != 25) {
      parameters['pageSizeTools'] = ['$nextSize'];
    }

    if (nextColumn != null) {
      parameters['sortTools'] = [
        jsonEncode([nextColumn.index, nextDescending ? 'DESC' : 'ASC']),
      ];
    }

    return uri.replace(queryParameters: parameters);
  }
}

String toolColumnText(
  models.Tool tool,
  ToolSortColumn column, {
  required bool german,
}) {
  final (statusDe, statusEn, _) = toolStatusPresentation(tool);

  return switch (column) {
    ToolSortColumn.number => toolNumber(tool.customId),
    ToolSortColumn.status => german ? statusDe : statusEn,
    ToolSortColumn.brand => tool.brand,
    ToolSortColumn.category => tool.category,
    ToolSortColumn.model => tool.label ?? '',
  };
}

List<models.Tool> sortedTools(
  List<models.Tool> rows,
  ToolListState state, {
  required bool german,
}) {
  final column = state.column;

  if (column == null) {
    return List.of(rows);
  }

  final indexed = rows.indexed.toList();
  indexed.sort((left, right) {
    int comparison;

    if (column == ToolSortColumn.number) {
      comparison = left.$2.customId.compareTo(right.$2.customId);
      comparison *= state.descending ? -1 : 1;
    } else {
      final a = toolColumnText(left.$2, column, german: german).toLowerCase();
      final b = toolColumnText(right.$2, column, german: german).toLowerCase();

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
