import '../../api/generated/models.g.dart' as models;
import '../../api/model.dart';

class ToolListFilter {
  const ToolListFilter({
    this.status,
    this.brand,
    this.category,
    this.archivedOnly = false,
  });

  final models.ToolsListRequestStatus? status;
  final String? brand;
  final String? category;
  final bool archivedOnly;

  factory ToolListFilter.fromUri(Uri uri) {
    final rawStatus = _firstParameter(uri, 'status');
    models.ToolsListRequestStatus? status;

    for (final option in models.ToolsListRequestStatus.values) {
      if (option.wireValue == rawStatus) {
        status = option;
        break;
      }
    }

    return ToolListFilter(
      status: status,
      brand: _firstParameter(uri, 'brand'),
      category: _firstParameter(uri, 'category'),
      archivedOnly: _firstParameter(uri, 'archived') == 'yes',
    );
  }

  models.ToolsListInput input(String search) {
    return models.ToolsListInput(
      search: search.isEmpty
          ? const RpcOptional.absent()
          : RpcOptional.value(search),
      status: RpcOptional.value(status),
      brand: RpcOptional.value(brand),
      category: RpcOptional.value(category),
    );
  }

  List<models.Tool> visibleRows(Iterable<models.Tool> tools) {
    return tools.where((tool) {
      return archivedOnly
          ? tool.archivedSince != null
          : tool.archivedSince == null;
    }).toList(growable: false);
  }
}

String? _firstParameter(Uri uri, String name) {
  final values = uri.queryParametersAll[name];

  if (values == null || values.isEmpty) {
    return null;
  }

  return values.first;
}
