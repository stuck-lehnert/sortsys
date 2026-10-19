import 'dart:convert';
import 'dart:math' as math;

import '../../api/model.dart';
import '../../api/generated/models.g.dart' as models;

const userPageSizes = [25, 50, 100];

enum UserSortColumn { firstName, lastName, contract }

final class UserListState {
  const UserListState({
    this.page = 0,
    this.pageSize = 25,
    this.column,
    this.descending = false,
    this.archivedOnly = false,
  });

  final int page;
  final int pageSize;
  final UserSortColumn? column;
  final bool descending;
  final bool archivedOnly;

  factory UserListState.fromUri(Uri uri) {
    String? parameter(String name) {
      return uri.queryParametersAll[name]?.first;
    }

    final size = int.tryParse(parameter('pageSizeUsers') ?? '');
    Object? sorting;

    try {
      sorting = jsonDecode(parameter('sortUsers') ?? 'null');
    } on FormatException {
      sorting = null;
    }

    UserSortColumn? column;
    var descending = false;

    if (sorting is List<Object?> && sorting.length == 2) {
      final index = sorting[0];
      final order = sorting[1];

      if (index is int &&
          index >= 0 &&
          index < UserSortColumn.values.length &&
          (order == 'ASC' || order == 'DESC')) {
        column = UserSortColumn.values[index];
        descending = order == 'DESC';
      }
    }

    return UserListState(
      page: math.max(0, int.tryParse(parameter('pageUsers') ?? '') ?? 0),
      pageSize: userPageSizes.contains(size) ? size! : 25,
      column: column,
      descending: descending,
      archivedOnly: parameter('archived') == 'yes',
    );
  }

  models.UsersListInput input() {
    return models.UsersListInput(
      includeArchived: archivedOnly
          ? const RpcOptional.value(true)
          : const RpcOptional.absent(),
    );
  }

  Uri apply(
    Uri uri, {
    int? page,
    int? pageSize,
    UserSortColumn? toggleColumn,
    bool? archivedOnly,
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

    for (final key in ['pageUsers', 'pageSizeUsers', 'sortUsers']) {
      parameters.remove(key);
    }

    if (nextPage > 0) {
      parameters['pageUsers'] = ['$nextPage'];
    }

    if (userPageSizes.contains(nextSize) && nextSize != 25) {
      parameters['pageSizeUsers'] = ['$nextSize'];
    }

    if (nextColumn != null) {
      parameters['sortUsers'] = [
        jsonEncode([nextColumn.index, nextDescending ? 'DESC' : 'ASC']),
      ];
    }

    if (archivedOnly != null) {
      parameters.remove('archived');

      if (archivedOnly) {
        parameters['archived'] = ['yes'];
      }
    }

    return uri.replace(queryParameters: parameters);
  }
}

String userListName(models.User user) {
  return [user.firstName, user.lastName]
      .whereType<String>()
      .where((value) {
        return value.isNotEmpty;
      })
      .join(' ');
}

String userColumnText(models.User user, UserSortColumn column, String locale) {
  return switch (column) {
    UserSortColumn.firstName => user.firstName,
    UserSortColumn.lastName => user.lastName ?? '',
    UserSortColumn.contract => switch (user.contractType) {
      models.UserContractType.internal =>
        locale == 'de' ? 'Intern' : 'Internal',
      models.UserContractType.externalValue =>
        locale == 'de' ? 'Extern' : 'External',
      models.UserContractType.subcontractor => 'SUB',
    },
  };
}

List<models.User> sortedUsers(
  List<models.User> users,
  UserListState state,
  String locale,
) {
  final visible = users.where((user) {
    return !state.archivedOnly || user.archivedAt != null;
  }).toList();
  final column = state.column;

  if (column == null) {
    return visible;
  }

  final indexed = visible.indexed.toList();

  indexed.sort((left, right) {
    final a = userColumnText(left.$2, column, locale).toLowerCase();
    final b = userColumnText(right.$2, column, locale).toLowerCase();
    int comparison;

    if (a.isEmpty && b.isNotEmpty) {
      comparison = 1;
    } else if (b.isEmpty && a.isNotEmpty) {
      comparison = -1;
    } else {
      comparison = a.compareTo(b) * (state.descending ? -1 : 1);
    }

    if (comparison == 0) {
      return left.$1.compareTo(right.$1);
    }

    return comparison;
  });

  return [for (final entry in indexed) entry.$2];
}
