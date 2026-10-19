import '../../api/contract.dart';
import '../../api/generated/api.g.dart';
import '../../api/procedure.dart';
import 'product_read_repository.dart';

final class ProductFilterOptions {
  ProductFilterOptions({
    required this.read,
    required this.isCurrent,
    required this.can,
  });

  final ProductRead read;
  final bool Function() isCurrent;
  final bool Function(String permission) can;

  void _checkScope() {
    if (!isCurrent() || !can('view:products')) {
      throw StateError('PRODUCT_FILTER_SCOPE_CHANGED');
    }
  }

  Future<List<String>> brands(String query) {
    return _load(ApiQueries.productsBrandsList, query);
  }

  Future<List<String>> categories(String query) {
    return _load(ApiQueries.productsCategoriesList, query);
  }

  Future<List<String>> _load(
    RpcQuery<RpcUndefined, List<String>> procedure,
    String query,
  ) async {
    _checkScope();

    final options = await read(procedure, rpcUndefined);

    _checkScope();

    final normalized = query.toLowerCase();
    final matches = options.where((option) {
      return option.toLowerCase().contains(normalized);
    });

    return List.unmodifiable(matches);
  }
}
