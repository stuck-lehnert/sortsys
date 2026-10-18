import '../../api/client.dart';
import '../../api/generated/api.g.dart';
import '../../api/generated/models.g.dart' as models;
import '../../api/model.dart';
import '../../api/procedure.dart';

typedef SearchRead = Future<O> Function<I, O>(RpcQuery<I, O> query, I input);

enum SearchResource {
  project('view:projects', 'projects', 'building'),
  tool('view:tools', 'tools', 'tools'),
  user('view:users', 'users', 'users'),
  product('view:products', 'products', 'package'),
  customer('view:customers', 'customers', 'building'),
  contact('view:contacts', 'contacts', 'users'),
  vendor('view:productVendors', 'products/vendors', 'truck-delivery'),
  deliveryNote(
    'view:deliveryNotes',
    'products/deliveryNotes',
    'truck-delivery',
  );

  const SearchResource(this.role, this.path, this.icon);

  final String role;
  final String path;
  final String icon;
}

final class SearchHit {
  const SearchHit({
    required this.resource,
    required this.id,
    required this.title,
    this.recordedAt,
  });

  final SearchResource resource;
  final String id;
  final String title;
  final DateTime? recordedAt;

  String get href {
    return '/${resource.path}/${Uri.encodeComponent(id)}';
  }

  factory SearchHit.fromResource(RpcValue value) {
    switch (value) {
      case models.Project():
        return SearchHit(
          resource: SearchResource.project,
          id: value.id,
          title: value.title,
        );
      case models.Tool():
        final label = value.label;
        var title = '${value.customId} ${value.brand} ${value.category}';

        if (label != null && label.isNotEmpty) {
          title = '$title $label';
        }

        return SearchHit(
          resource: SearchResource.tool,
          id: value.id,
          title: title,
        );
      case models.User():
        return SearchHit(
          resource: SearchResource.user,
          id: value.id,
          title: _personName(value.firstName, value.lastName),
        );
      case models.Product():
        final brand = value.brand;
        final name = brand == null || brand.isEmpty
            ? value.name
            : '$brand ${value.name}';

        return SearchHit(
          resource: SearchResource.product,
          id: value.id,
          title: '${value.customId} $name',
        );
      case models.Customer():
        return SearchHit(
          resource: SearchResource.customer,
          id: value.id,
          title: _salutation(value.salutation, value.name),
        );
      case models.Contact():
        final name = _personName(value.firstName, value.lastName);

        return SearchHit(
          resource: SearchResource.contact,
          id: value.id,
          title: _salutation(value.salutation, name),
        );
      case models.ProductVendor():
        return SearchHit(
          resource: SearchResource.vendor,
          id: value.id,
          title: value.name,
        );
      case models.DeliveryNote():
        return SearchHit(
          resource: SearchResource.deliveryNote,
          id: value.id,
          title: '#${value.autoId}',
          recordedAt: value.createdAt,
        );
      default:
        throw const FormatException('INVALID_GLOBAL_SEARCH_RESOURCE');
    }
  }
}

String _personName(String? first, String? last) {
  final names = [first, last].whereType<String>().where((name) {
    return name.isNotEmpty;
  });

  return names.join(' ');
}

String _salutation(String? salutation, String name) {
  if (salutation == null || salutation.isEmpty) {
    return name;
  }

  return '$salutation $name';
}

num? deliveryNoteSearchNumber(String query) {
  final normalized = query.trim();
  final digits = normalized.startsWith('#')
      ? normalized.substring(1).trimLeft()
      : normalized;
  final prefix = RegExp(r'^[+-]?[0-9]+').firstMatch(digits)?.group(0);

  if (prefix == null) {
    return null;
  }

  final number = num.tryParse(prefix);

  if (number == null || !number.isFinite) {
    return null;
  }

  return number;
}

final class SearchBatch {
  const SearchBatch({this.hits = const [], this.failures = const {}});

  final List<SearchHit> hits;
  final Map<SearchResource, Object> failures;
}

final class GlobalSearchRepository {
  const GlobalSearchRepository({
    required this.read,
    required this.can,
    required this.isCurrent,
  });

  final SearchRead read;
  final bool Function(String role) can;
  final bool Function() isCurrent;

  Future<SearchBatch> search(String query) async {
    final normalized = query.trim().toLowerCase();

    if (normalized.isEmpty || normalized.startsWith('>')) {
      return const SearchBatch();
    }

    _checkScope();

    final requests = <Future<SearchBatch>>[];

    for (final resource in SearchResource.values) {
      if (!can(resource.role)) {
        continue;
      }

      if (resource == SearchResource.deliveryNote &&
          deliveryNoteSearchNumber(normalized) == null) {
        continue;
      }

      requests.add(_searchResource(resource, normalized));
    }

    final responses = await Future.wait(requests);

    _checkScope();

    return SearchBatch(
      hits: List.unmodifiable([
        for (final response in responses) ...response.hits,
      ]),
      failures: Map.unmodifiable({
        for (final response in responses) ...response.failures,
      }),
    );
  }

  Future<SearchBatch> _searchResource(
    SearchResource resource,
    String query,
  ) async {
    try {
      _checkScope();

      final search = RpcOptional<String>.value(query);
      final Future<List<RpcValue>> response = switch (resource) {
        SearchResource.project => read(
          ApiQueries.projectsList,
          models.ProjectsListInput(search: search),
        ),
        SearchResource.tool => read(
          ApiQueries.toolsList,
          models.ToolsListInput(search: search),
        ),
        SearchResource.user => read(
          ApiQueries.usersList,
          models.UsersListInput(search: search),
        ),
        SearchResource.product => read(
          ApiQueries.productsList,
          models.ProductsListInput(search: search),
        ),
        SearchResource.customer => read(
          ApiQueries.customersList,
          models.CustomersListInput(search: search),
        ),
        SearchResource.contact => read(
          ApiQueries.contactsList,
          models.ContactsListInput(search: search),
        ),
        SearchResource.vendor => read(
          ApiQueries.productsVendorsList,
          models.ProductsVendorsListInput(search: search),
        ),
        SearchResource.deliveryNote => _findDeliveryNote(query),
      };

      final rows = await response;

      _checkScope();

      return SearchBatch(
        hits: List.unmodifiable(rows.take(8).map(SearchHit.fromResource)),
      );
    } catch (error) {
      if (resource == SearchResource.deliveryNote &&
          error is RpcException &&
          error.httpCode == 404) {
        return const SearchBatch();
      }

      return SearchBatch(failures: {resource: error});
    }
  }

  Future<List<RpcValue>> _findDeliveryNote(String query) async {
    final autoId = deliveryNoteSearchNumber(query);

    if (autoId == null) {
      return const [];
    }

    final request = models.DeliveryNotesGetRequestObjectSchemaE547a4fe(
      models.DeliveryNotesGetRequestVariant2(autoId: autoId),
    );

    final note = await read(ApiQueries.deliveryNotesGet, request);

    return [note];
  }

  Future<List<String>> recentActionIds() async {
    _checkScope();

    final rows = await read(
      ApiQueries.personalizationActionsList,
      const RpcOptional.value(
        models.PersonalizationActionsListRequest(limit: RpcOptional.value(10)),
      ),
    );

    _checkScope();

    final seen = <String>{};
    final ids = <String>[];

    for (final row in rows) {
      if (seen.add(row.actionId)) {
        ids.add(row.actionId);
      }
    }

    return List.unmodifiable(ids);
  }

  void _checkScope() {
    if (!isCurrent()) {
      throw StateError('GLOBAL_SEARCH_SCOPE_CHANGED');
    }
  }
}
