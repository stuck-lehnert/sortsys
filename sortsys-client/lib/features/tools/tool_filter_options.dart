import '../../api/contract.dart';
import '../../api/generated/api.g.dart';
import '../../api/procedure.dart';

typedef ToolFilterRead = Future<O> Function<I, O>(RpcQuery<I, O> query, I input);

final class ToolFilterOptions {
  ToolFilterOptions({
    required this.read,
    required this.isCurrent,
    required this.can,
  });

  final ToolFilterRead read;
  final bool Function() isCurrent;
  final bool Function(String permission) can;

  void _checkScope() {
    if (!isCurrent() || !can('view:tools')) {
      throw StateError('TOOL_FILTER_SCOPE_CHANGED');
    }
  }

  Future<List<String>> brands(String query) {
    return _options(ApiQueries.toolsBrands, query);
  }

  Future<List<String>> categories(String query) {
    return _options(ApiQueries.toolsCategories, query);
  }

  Future<List<String>> _options(
    RpcQuery<RpcUndefined, List<String>> procedure,
    String query,
  ) async {
    _checkScope();

    final options = await read(procedure, rpcUndefined);
    _checkScope();

    final normalized = query.trim().toLowerCase();

    return List.unmodifiable(options.where((option) {
      return option.toLowerCase().contains(normalized);
    }));
  }
}
