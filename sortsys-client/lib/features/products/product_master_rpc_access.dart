import '../../api/generated/api.g.dart';
import '../../api/generated/models.g.dart' as models;
import '../../api/procedure.dart';
import 'product_master_inputs.dart';
import 'product_master_write_access.dart';
import 'product_read_repository.dart';

typedef ProductMasterWrite = Future<O> Function<I, O>(
  RpcMutation<I, O> mutation,
  I input,
);

final class ProductMasterRpcAccess implements ProductMasterWriteAccess {
  const ProductMasterRpcAccess({
    required this.scope,
    required this.read,
    required this.write,
    required this.isCurrent,
    required this.can,
    this.productId,
  });

  @override
  final String scope;

  final String? productId;
  final ProductRead read;
  final ProductMasterWrite write;
  final bool Function() isCurrent;
  final bool Function(String permission) can;

  @override
  void checkCurrent() {
    if (scope.isEmpty || productId?.isEmpty == true) {
      throw const FormatException('INVALID_PRODUCT_MASTER_OWNER');
    }

    if (!isCurrent() || !can('view:products')) {
      throw StateError('PRODUCT_MASTER_SCOPE_CHANGED');
    }
  }

  void _checkManage() {
    checkCurrent();

    if (!can('manage:products')) {
      throw StateError('PRODUCT_MASTER_WRITE_NOT_ALLOWED');
    }
  }

  @override
  void checkCreate(models.ProductsCreateInput input) {
    _checkManage();

    if (productId != null) {
      throw const FormatException('INVALID_PRODUCT_MASTER_CREATE_CONTEXT');
    }

    checkProductMasterCreateInput(input);
  }

  @override
  void checkUpdate(models.ProductsUpdateInput input) {
    _checkManage();

    if (productId == null || input.id != productId) {
      throw const FormatException('INVALID_PRODUCT_MASTER_UPDATE_CONTEXT');
    }

    checkProductMasterUpdateInput(input);
  }

  @override
  Future<models.ProductsCreateOutput> createProduct(
    models.ProductsCreateInput input,
  ) async {
    checkCreate(input);

    final result = await write(ApiMutations.productsCreate, input);
    checkCreate(input);

    if (result.id.isEmpty) {
      throw const FormatException('INVALID_PRODUCT_MASTER_CREATE_RESULT');
    }

    return result;
  }

  @override
  Future<models.ProductsUpdateOutput> updateProduct(
    models.ProductsUpdateInput input,
  ) async {
    checkUpdate(input);

    final result = await write(ApiMutations.productsUpdate, input);
    checkUpdate(input);

    if (!result.success) {
      throw const FormatException('INVALID_PRODUCT_MASTER_UPDATE_RESULT');
    }

    return result;
  }

  @override
  Future<models.Product?> getProduct(String id) async {
    checkCurrent();

    if (id.isEmpty || (productId != null && productId != id)) {
      throw const FormatException('INVALID_PRODUCT_MASTER_READBACK_OWNER');
    }

    final product = await read(
      ApiQueries.productsGet,
      models.ProductsGetInput(id: id),
    );
    checkCurrent();

    if (product.id != id) {
      throw const FormatException('PRODUCT_MASTER_READBACK_ID_MISMATCH');
    }

    return models.Product(
      id: product.id,
      customId: product.customId,
      name: product.name,
      brand: product.brand,
      description: product.description,
      regieReportName: product.regieReportName,
      baseUnit: product.baseUnit,
      otherUnits: models.ApplyPriceImportRowOtherUnits(
        Map.unmodifiable(product.otherUnits.values),
      ),
      categories: List.unmodifiable(product.categories),
    );
  }
}
