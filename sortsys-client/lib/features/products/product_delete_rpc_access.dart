import '../../api/generated/api.g.dart';
import '../../api/generated/models.g.dart' as models;
import '../../api/procedure.dart';
import 'product_delete_coordinator.dart';
import 'product_delete_receipt.dart';

typedef ProductDeleteRead =
    Future<O> Function<I, O>(RpcQuery<I, O> query, I input);
typedef ProductDeleteWrite =
    Future<O> Function<I, O>(RpcMutation<I, O> mutation, I input);

final class ProductDeleteRpcAccess implements ProductDeleteAccess {
  const ProductDeleteRpcAccess({
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
  final ProductDeleteRead read;
  final ProductDeleteWrite write;
  final bool Function() isCurrent;
  final bool Function(String permission) can;

  @override
  void checkCurrent() {
    if (scope.isEmpty || productId.isEmpty) {
      throw const FormatException('INVALID_PRODUCT_DELETE_OWNER');
    }

    if (!isCurrent() || !can('view:products')) {
      throw StateError('PRODUCT_DELETE_SCOPE_CHANGED');
    }
  }

  @override
  void checkDelete(models.ProductsDeleteInput input) {
    checkCurrent();

    if (input.id != productId) {
      throw const FormatException('INVALID_PRODUCT_DELETE_TARGET');
    }

    if (!can('delete:products')) {
      throw StateError('PRODUCT_DELETE_FORBIDDEN');
    }
  }

  @override
  Future<models.Product> getProduct(String id) async {
    checkCurrent();

    if (id != productId) {
      throw const FormatException('INVALID_PRODUCT_DELETE_READ_TARGET');
    }

    final product = await read(
      ApiQueries.productsGet,
      models.ProductsGetInput(id: id),
    );

    checkCurrent();

    if (product.id != id) {
      throw const FormatException('PRODUCT_DELETE_RESPONSE_ID_MISMATCH');
    }

    return freezeProductDeleteBaseline(product);
  }

  @override
  Future<models.ProductsDeleteOutput> deleteProduct(
    models.ProductsDeleteInput input,
  ) async {
    checkDelete(input);

    final request = models.ProductsDeleteInput(id: input.id);

    final result = await write(ApiMutations.productsDelete, request);

    // Losing delete permission must not erase a genuine acknowledgement.
    checkCurrent();

    if (!result.success) {
      throw const FormatException('INVALID_PRODUCT_DELETE_RESULT');
    }

    return result;
  }
}
