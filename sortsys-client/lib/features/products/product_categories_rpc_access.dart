import '../../api/generated/api.g.dart';
import '../../api/generated/models.g.dart' as models;
import '../../api/procedure.dart';
import 'product_categories_inputs.dart';
import 'product_categories_write_access.dart';
import 'product_read_repository.dart';

typedef ProductCategoriesWrite =
    Future<O> Function<I, O>(RpcMutation<I, O> mutation, I input);

final class ProductCategoriesRpcAccess implements ProductCategoriesWriteAccess {
  const ProductCategoriesRpcAccess({
    required this.scope,
    required this.productId,
    required this.read,
    required this.write,
    required this.isCurrent,
    required this.can,
  });

  @override
  final String scope;

  @override
  final String productId;

  final ProductRead read;
  final ProductCategoriesWrite write;
  final bool Function() isCurrent;
  final bool Function(String permission) can;

  @override
  void checkCurrent() {
    if (scope.isEmpty || productId.isEmpty) {
      throw const FormatException('INVALID_PRODUCT_CATEGORIES_OWNER');
    }

    if (!isCurrent() || !can('view:products')) {
      throw StateError('PRODUCT_CATEGORIES_SCOPE_CHANGED');
    }
  }

  @override
  void checkSet(models.ProductsCategoriesSetInput input) {
    checkCurrent();

    if (!can('manage:products')) {
      throw StateError('PRODUCT_CATEGORIES_WRITE_NOT_ALLOWED');
    }

    if (input.id != productId) {
      throw const FormatException('INVALID_PRODUCT_CATEGORIES_TARGET');
    }

    checkProductCategoriesInput(input);
  }

  @override
  Future<models.ProductsCategoriesSetOutput> setCategories(
    models.ProductsCategoriesSetInput input,
  ) async {
    checkSet(input);

    final request = models.ProductsCategoriesSetInput(
      id: input.id,
      categories: List.unmodifiable(input.categories),
    );

    final result = await write(ApiMutations.productsCategoriesSet, request);

    checkSet(request);

    if (!result.success) {
      throw const FormatException('INVALID_PRODUCT_CATEGORIES_SET_RESULT');
    }

    return result;
  }

  Future<List<String>> getCategories() async {
    checkCurrent();

    final categories = await read(
      ApiQueries.productsCategoriesList,
      const models.ProductsCategoriesListInput(),
    );

    checkCurrent();

    return List.unmodifiable(categories);
  }

  @override
  Future<models.Product?> getProduct(String id) async {
    checkCurrent();

    if (id.isEmpty || id != productId) {
      throw const FormatException('INVALID_PRODUCT_CATEGORIES_READBACK_OWNER');
    }

    final product = await read(
      ApiQueries.productsGet,
      models.ProductsGetInput(id: id),
    );

    checkCurrent();

    if (product.id != id) {
      throw const FormatException('PRODUCT_CATEGORIES_READBACK_ID_MISMATCH');
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
