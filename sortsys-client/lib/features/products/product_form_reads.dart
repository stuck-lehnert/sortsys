import '../../api/contract.dart';
import '../../api/generated/api.g.dart';
import 'product_read_repository.dart';

final class ProductFormReads {
  ProductFormReads({
    required this.read,
    required this.isCurrent,
    required this.can,
  });

  final ProductRead read;
  final bool Function() isCurrent;
  final bool Function(String permission) can;

  void _checkScope() {
    if (!isCurrent() || !can('view:products') || !can('manage:products')) {
      throw StateError('PRODUCT_FORM_SCOPE_CHANGED');
    }
  }

  Future<int?> suggestNumber() async {
    _checkScope();

    final value = await read(
      ApiQueries.productsSuggestNextCustomId,
      rpcUndefined,
    );

    _checkScope();

    if (!value.isFinite ||
        value < 0 ||
        value > 2147483647 ||
        value != value.truncateToDouble()) {
      throw const FormatException('INVALID_PRODUCT_NUMBER_SUGGESTION');
    }

    // The Webapp leaves the field unchanged for a zero suggestion.
    return value == 0 ? null : value.toInt();
  }

  Future<List<String>> units() async {
    _checkScope();

    final units = await read(ApiQueries.productsUnitsList, rpcUndefined);

    _checkScope();

    return List.unmodifiable(units);
  }
}
