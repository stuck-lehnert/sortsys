import 'dart:convert';
import 'dart:math' as math;

import '../../api/generated/models.g.dart' as models;

const customerPageSizes = [25, 50, 100];

enum CustomerSortColumn { salutation, name, address, phone, email }

typedef _CustomerSort = ({CustomerSortColumn? column, bool descending});

final class CustomerListState {
  const CustomerListState({
    this.page = 0,
    this.pageSize = 25,
    this.sortColumn,
    this.descending = false,
  });

  final int page;
  final int pageSize;
  final CustomerSortColumn? sortColumn;
  final bool descending;

  factory CustomerListState.fromUri(Uri uri) {
    final parameters = uri.queryParameters;
    final size = int.tryParse(parameters['pageSizeCustomers'] ?? '');
    Object? rawSort;

    try {
      rawSort = jsonDecode(parameters['sortCustomers'] ?? 'null');
    } on FormatException {
      rawSort = null;
    }

    final sorting = _readSort(rawSort);

    return CustomerListState(
      page: math.max(0, int.tryParse(parameters['pageCustomers'] ?? '') ?? 0),
      pageSize: customerPageSizes.contains(size) ? size! : 25,
      sortColumn: sorting.column,
      descending: sorting.descending,
    );
  }

  Uri apply(
    Uri uri, {
    int? page,
    int? pageSize,
    CustomerSortColumn? toggleColumn,
  }) {
    final parameters = {
      for (final entry in uri.queryParametersAll.entries)
        entry.key: List<String>.of(entry.value),
    };
    final nextPage = page ?? this.page;
    final nextSize = pageSize ?? this.pageSize;
    var sorting = (column: sortColumn, descending: descending);

    if (toggleColumn != null) {
      sorting = _toggleSort(sorting, toggleColumn);
    }

    for (final key in ['pageCustomers', 'pageSizeCustomers', 'sortCustomers']) {
      parameters.remove(key);
    }

    if (nextPage > 0) {
      parameters['pageCustomers'] = ['$nextPage'];
    }

    if (customerPageSizes.contains(nextSize) && nextSize != 25) {
      parameters['pageSizeCustomers'] = ['$nextSize'];
    }

    if (sorting.column != null) {
      parameters['sortCustomers'] = [
        jsonEncode([
          sorting.column!.index,
          sorting.descending ? 'DESC' : 'ASC',
        ]),
      ];
    }

    return uri.replace(queryParameters: parameters);
  }
}

_CustomerSort _readSort(Object? raw) {
  if (raw is! List<Object?> || raw.length != 2) {
    return (column: null, descending: false);
  }

  final index = raw[0];
  final order = raw[1];

  if (index is! int ||
      index < 0 ||
      index >= CustomerSortColumn.values.length ||
      (order != 'ASC' && order != 'DESC')) {
    return (column: null, descending: false);
  }

  return (
    column: CustomerSortColumn.values[index],
    descending: order == 'DESC',
  );
}

_CustomerSort _toggleSort(_CustomerSort current, CustomerSortColumn column) {
  if (current.column != column) {
    return (column: column, descending: false);
  }

  if (!current.descending) {
    return (column: column, descending: true);
  }

  return (column: null, descending: false);
}

String customerName(models.Customer customer) {
  final salutation = customer.salutation;

  if (salutation == null || salutation.isEmpty) {
    return customer.name;
  }

  return '$salutation ${customer.name}';
}

String customerAddress(models.ProjectAddress? address) {
  if (address == null) {
    return '';
  }

  var city = address.city;
  final zip = address.zip.valueOrNull;

  if (zip != null && zip.isNotEmpty) {
    city = '$zip $city';
  }

  if (city.isEmpty) {
    return address.streetAddress;
  }

  return '${address.streetAddress}, $city'.trim();
}

String customerColumnText(
  models.Customer customer,
  CustomerSortColumn column, {
  String channelSeparator = '\n',
}) {
  return switch (column) {
    CustomerSortColumn.salutation => customer.salutation ?? '',
    CustomerSortColumn.name => customer.name,
    CustomerSortColumn.address => customerAddress(customer.address),
    CustomerSortColumn.phone =>
      customer.phoneNumbers
          .map((entry) {
            return entry.number;
          })
          .join(channelSeparator),
    CustomerSortColumn.email =>
      customer.emailAddresses
          .map((entry) {
            return entry.email;
          })
          .join(channelSeparator),
  };
}

List<models.Customer> sortedCustomers(
  List<models.Customer> rows,
  CustomerListState state,
) {
  final column = state.sortColumn;

  if (column == null) {
    return List<models.Customer>.unmodifiable(rows);
  }

  final indexed = rows.indexed.toList();

  indexed.sort((left, right) {
    final leftKey = customerColumnText(
      left.$2,
      column,
      channelSeparator: ' ',
    ).toLowerCase();
    final rightKey = customerColumnText(
      right.$2,
      column,
      channelSeparator: ' ',
    ).toLowerCase();
    int comparison;

    if (leftKey.isEmpty && rightKey.isNotEmpty) {
      comparison = 1;
    } else if (rightKey.isEmpty && leftKey.isNotEmpty) {
      comparison = -1;
    } else {
      comparison = leftKey.compareTo(rightKey) * (state.descending ? -1 : 1);
    }

    return comparison == 0 ? left.$1.compareTo(right.$1) : comparison;
  });

  return List<models.Customer>.unmodifiable(
    indexed.map((entry) {
      return entry.$2;
    }),
  );
}
