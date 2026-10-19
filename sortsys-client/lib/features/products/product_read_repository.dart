import '../../api/generated/api.g.dart';
import '../../api/generated/models.g.dart' as models;
import '../../api/model.dart';
import '../../api/procedure.dart';

typedef ProductRead = Future<O> Function<I, O>(RpcQuery<I, O> query, I input);

final class ProductReadRepository {
  ProductReadRepository({
    required this.productId,
    required this.read,
    required this.isCurrent,
    required this.can,
  });

  final String productId;
  final ProductRead read;
  final bool Function() isCurrent;
  final bool Function(String permission) can;

  void _checkScope(String permission) {
    if (productId.isEmpty) {
      throw const FormatException('INVALID_PRODUCT_ID');
    }

    if (!isCurrent() || !can('view:products') || !can(permission)) {
      throw StateError('PRODUCT_READ_SCOPE_CHANGED');
    }
  }

  Future<models.Product> get() async {
    _checkScope('view:products');

    final product = await read(
      ApiQueries.productsGet,
      models.ProductsGetInput(id: productId),
    );
    _checkScope('view:products');

    if (product.id != productId) {
      throw const FormatException('PRODUCT_RESPONSE_ID_MISMATCH');
    }

    return product;
  }

  Future<models.ProductVendor> vendorReference(String vendorId) async {
    _checkScope('view:productPriceRecords');
    _checkScope('view:productVendors');

    if (vendorId.isEmpty) {
      throw const FormatException('INVALID_PRICE_VENDOR_ID');
    }

    final vendor = await read(
      ApiQueries.productsVendorsGet,
      models.ProductsVendorsGetInput(id: vendorId),
    );
    _checkScope('view:productPriceRecords');
    _checkScope('view:productVendors');

    if (vendor.id != vendorId) {
      throw const FormatException('PRICE_VENDOR_RESPONSE_ID_MISMATCH');
    }

    return vendor;
  }

  Future<List<models.ProductsPriceRecordsListResultItem>> priceRecords() async {
    _checkScope('view:productPriceRecords');

    final records = await read(
      ApiQueries.productsPriceRecordsList,
      models.ProductsPriceRecordsListInput(
        productId: RpcOptional.value(productId),
      ),
    );
    _checkScope('view:productPriceRecords');

    for (final record in records) {
      if (record.productId != productId) {
        throw const FormatException('PRODUCT_PRICE_RESPONSE_ID_MISMATCH');
      }
    }

    return List.unmodifiable(records);
  }
}
