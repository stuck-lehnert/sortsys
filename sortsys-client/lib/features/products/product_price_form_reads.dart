import '../../api/generated/api.g.dart';
import '../../api/generated/models.g.dart' as models;
import '../../api/model.dart';
import 'product_read_repository.dart';

final class ProductPriceFormReads {
  ProductPriceFormReads({
    required this.productId,
    required this.read,
    required this.isCurrent,
    required this.can,
  });

  final String productId;
  final ProductRead read;
  final bool Function() isCurrent;
  final bool Function(String permission) can;

  void _check() {
    if (productId.isEmpty) {
      throw const FormatException('INVALID_PRICE_FORM_PRODUCT_ID');
    }

    if (!isCurrent() ||
        !can('view:products') ||
        !can('manage:productPriceRecords') ||
        !can('view:productVendors')) {
      throw StateError('PRODUCT_PRICE_FORM_SCOPE_CHANGED');
    }
  }

  Future<List<models.ProductVendor>> vendors(String search) async {
    _check();

    final vendors = await read(
      ApiQueries.productsVendorsList,
      models.ProductsVendorsListInput(search: RpcOptional.value(search)),
    );
    _check();

    return List.unmodifiable(vendors);
  }
}
