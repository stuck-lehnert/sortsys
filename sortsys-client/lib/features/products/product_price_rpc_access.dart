import '../../api/generated/api.g.dart';
import '../../api/generated/models.g.dart' as models;
import '../../api/model.dart';
import '../../api/procedure.dart';
import 'product_price_write_coordinator.dart';
import 'product_read_repository.dart';

typedef ProductPriceWrite = Future<O> Function<I, O>(
  RpcMutation<I, O> mutation,
  I input,
);

final class ProductPriceRpcAccess implements ProductPriceWriteAccess {
  ProductPriceRpcAccess({
    required this.scope,
    required this.productId,
    required this.read,
    required this.write,
    required this.isCurrent,
    required this.can,
  });

  @override
  final String scope;

  final String productId;
  final ProductRead read;
  final ProductPriceWrite write;
  final bool Function() isCurrent;
  final bool Function(String permission) can;

  @override
  void checkCurrent() {
    if (scope.isEmpty || productId.isEmpty) {
      throw const FormatException('INVALID_PRODUCT_PRICE_WRITE_OWNER');
    }

    if (!isCurrent() ||
        !can('view:products') ||
        !can('view:productPriceRecords')) {
      throw StateError('PRODUCT_PRICE_WRITE_SCOPE_CHANGED');
    }
  }

  @override
  void checkCreate(models.ProductsPriceRecordsCreateInput input) {
    checkCurrent();

    if (!can('manage:productPriceRecords')) {
      throw StateError('PRODUCT_PRICE_CREATE_NOT_ALLOWED');
    }

    if (input.productId != productId ||
        !input.pricePerBaseUnit.isFinite ||
        !input.vendorId.isAbsent) {
      throw const FormatException('INVALID_PRODUCT_PRICE_WRITE_INPUT');
    }
  }

  @override
  Future<models.ProductsPriceRecordsCreateOutput> createPrice(
    models.ProductsPriceRecordsCreateInput input,
  ) async {
    checkCreate(input);

    final result = await write(ApiMutations.productsPriceRecordsCreate, input);
    checkCreate(input);

    if (result.id.isEmpty) {
      throw const FormatException('INVALID_PRODUCT_PRICE_CREATE_RESULT');
    }

    return result;
  }

  @override
  Future<models.ProductsPriceRecordsListResultItem?> priceRecord(
    String recordId,
    String productId,
  ) async {
    checkCurrent();

    if (recordId.isEmpty || productId != this.productId) {
      throw const FormatException('INVALID_PRODUCT_PRICE_READBACK_OWNER');
    }

    // The API has a product-scoped list, not an invented price-record get.
    final rows = await read(
      ApiQueries.productsPriceRecordsList,
      models.ProductsPriceRecordsListInput(
        productId: RpcOptional.value(productId),
      ),
    );
    checkCurrent();

    models.ProductsPriceRecordsListResultItem? match;

    for (final row in rows) {
      if (row.productId != productId) {
        throw const FormatException('PRODUCT_PRICE_READBACK_OWNER_MISMATCH');
      }

      if (row.id != recordId) {
        continue;
      }

      if (match != null) {
        throw const FormatException('DUPLICATE_PRODUCT_PRICE_RESPONSE_ID');
      }

      match = row;
    }

    return match;
  }
}
