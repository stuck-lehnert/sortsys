import 'dart:convert';
import 'dart:math' as math;

import '../../api/generated/models.g.dart' as models;
import '../customers/customer_list_state.dart';

const contactPageSizes = [25, 50, 100];

enum ContactSortColumn { salutation, firstName, lastName, address }

final class ContactListState {
  const ContactListState({
    this.page = 0,
    this.pageSize = 25,
    this.column,
    this.descending = false,
  });

  final int page;
  final int pageSize;
  final ContactSortColumn? column;
  final bool descending;

  factory ContactListState.fromUri(Uri uri) {
    String? parameter(String name) {
      return uri.queryParametersAll[name]?.first;
    }

    final size = int.tryParse(parameter('pageSizeContacts') ?? '');
    Object? sorting;

    try {
      sorting = jsonDecode(parameter('sortContacts') ?? 'null');
    } on FormatException {
      sorting = null;
    }

    ContactSortColumn? column;
    var descending = false;

    if (sorting is List<Object?> && sorting.length == 2) {
      final index = sorting[0];
      final order = sorting[1];

      if (index is int &&
          index >= 0 &&
          index < ContactSortColumn.values.length &&
          (order == 'ASC' || order == 'DESC')) {
        column = ContactSortColumn.values[index];
        descending = order == 'DESC';
      }
    }

    return ContactListState(
      page: math.max(0, int.tryParse(parameter('pageContacts') ?? '') ?? 0),
      pageSize: contactPageSizes.contains(size) ? size! : 25,
      column: column,
      descending: descending,
    );
  }

  Uri apply(
    Uri uri, {
    int? page,
    int? pageSize,
    ContactSortColumn? toggleColumn,
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

    for (final key in ['pageContacts', 'pageSizeContacts', 'sortContacts']) {
      parameters.remove(key);
    }

    if (nextPage > 0) {
      parameters['pageContacts'] = ['$nextPage'];
    }

    if (contactPageSizes.contains(nextSize) && nextSize != 25) {
      parameters['pageSizeContacts'] = ['$nextSize'];
    }

    if (nextColumn != null) {
      parameters['sortContacts'] = [
        jsonEncode([nextColumn.index, nextDescending ? 'DESC' : 'ASC']),
      ];
    }

    return uri.replace(queryParameters: parameters);
  }
}

String contactColumnText(models.Contact contact, ContactSortColumn column) {
  return switch (column) {
    ContactSortColumn.salutation => contact.salutation ?? '',
    ContactSortColumn.firstName => contact.firstName ?? '',
    ContactSortColumn.lastName => contact.lastName ?? '',
    ContactSortColumn.address => customerAddress(contact.address),
  };
}

List<models.Contact> sortedContacts(
  List<models.Contact> contacts,
  ContactListState state,
) {
  final column = state.column;

  if (column == null) {
    return List.of(contacts);
  }

  final indexed = contacts.indexed.toList();

  indexed.sort((left, right) {
    final a = contactColumnText(left.$2, column).toLowerCase();
    final b = contactColumnText(right.$2, column).toLowerCase();
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
