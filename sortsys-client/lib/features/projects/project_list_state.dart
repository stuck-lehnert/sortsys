import 'dart:convert';
import 'dart:math' as math;

import '../../api/generated/models.g.dart' as api_models;

const projectPageSizes = [25, 50, 100];

enum ProjectSortColumn { title, address }

final class ProjectListState {
  const ProjectListState({
    this.finished = false,
    this.page = 0,
    this.pageSize = 25,
    this.sortColumn,
    this.descending = false,
  });

  final bool finished;
  final int page;
  final int pageSize;
  final ProjectSortColumn? sortColumn;
  final bool descending;

  factory ProjectListState.fromUri(Uri uri) {
    final parameters = uri.queryParameters;
    final rawSize = int.tryParse(parameters['pageSizeProjects'] ?? '');
    ProjectSortColumn? column;
    var descending = false;

    try {
      final raw = parameters['sortProjects'];
      final sorting = raw == null ? null : jsonDecode(raw);

      if (sorting is List<Object?> && sorting.length == 2) {
        final index = sorting[0];
        final order = sorting[1];

        if (index is int &&
            index >= 0 &&
            index < ProjectSortColumn.values.length &&
            (order == 'ASC' || order == 'DESC')) {
          column = ProjectSortColumn.values[index];
          descending = order == 'DESC';
        }

      }

    } on FormatException {
      // Invalid URL state leaves server row order intact.
    }

    return ProjectListState(
      finished: parameters['finished'] == 'yes',
      page: math.max(0, int.tryParse(parameters['pageProjects'] ?? '') ?? 0),
      pageSize: projectPageSizes.contains(rawSize) ? rawSize! : 25,
      sortColumn: column,
      descending: descending,
    );
  }

  Uri apply(
    Uri uri, {
    bool? finished,
    int? page,
    int? pageSize,
    ProjectSortColumn? toggleColumn,
  }) {
    final parameters = Map<String, String>.of(uri.queryParameters);
    final nextFinished = finished ?? this.finished;
    final nextPage = page ?? this.page;
    final nextSize = pageSize ?? this.pageSize;
    var column = sortColumn;
    var reverse = descending;

    if (toggleColumn != null) {
      if (column != toggleColumn) {
        column = toggleColumn;
        reverse = false;
      } else if (!reverse) {
        reverse = true;
      } else {
        column = null;
        reverse = false;
      }

    }

    parameters.remove('finished');
    parameters.remove('pageProjects');
    parameters.remove('pageSizeProjects');
    parameters.remove('sortProjects');

    if (nextFinished) {
      parameters['finished'] = 'yes';
    }

    if (nextPage > 0) {
      parameters['pageProjects'] = '$nextPage';
    }

    if (projectPageSizes.contains(nextSize) && nextSize != 25) {
      parameters['pageSizeProjects'] = '$nextSize';
    }

    if (column != null) {
      parameters['sortProjects'] = jsonEncode([
        column.index,
        reverse ? 'DESC' : 'ASC',
      ]);
    }

    return uri.replace(queryParameters: parameters);
  }

}

String projectAddress(api_models.ProjectAddress? address) {
  if (address == null) {
    return '';
  }

  final city = [address.zip.valueOrNull, address.city]
      .whereType<String>()
      .where((part) {
        return part.isNotEmpty;
      })

      .join(' ');

  if (city.isEmpty) {
    return address.streetAddress;
  }

  return '${address.streetAddress}, $city'.trim();
}

List<api_models.Project> sortedProjects(
  List<api_models.Project> rows,
  ProjectListState state,
) {
  final column = state.sortColumn;

  if (column == null) {
    return List.unmodifiable(rows);
  }

  final indexed = rows.indexed.toList();

  indexed.sort((left, right) {
    final a = column == ProjectSortColumn.title
        ? left.$2.title.toLowerCase()
        : projectAddress(left.$2.address).toLowerCase();
    final b = column == ProjectSortColumn.title
        ? right.$2.title.toLowerCase()
        : projectAddress(right.$2.address).toLowerCase();
    int comparison;

    if (a.isEmpty && b.isNotEmpty) {
      comparison = 1;
    } else if (b.isEmpty && a.isNotEmpty) {
      comparison = -1;
    } else {
      comparison = a.compareTo(b) * (state.descending ? -1 : 1);
    }

    return comparison == 0 ? left.$1.compareTo(right.$1) : comparison;
  });

  return List.unmodifiable(
    indexed.map((entry) {
      return entry.$2;
    }),

  );
}
