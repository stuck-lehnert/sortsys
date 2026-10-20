import '../../api/generated/api.g.dart';
import '../../api/generated/models.g.dart' as models;
import '../../api/procedure.dart';
import 'customer_delete_coordinator.dart';
import 'customer_delete_receipt.dart';

typedef CustomerDeleteRead =
    Future<O> Function<I, O>(RpcQuery<I, O> query, I input);
typedef CustomerDeleteWrite =
    Future<O> Function<I, O>(RpcMutation<I, O> mutation, I input);

final class CustomerDeleteRpcAccess implements CustomerDeleteAccess {
  const CustomerDeleteRpcAccess({
    required this.scope,
    required this.customerId,
    required this.read,
    required this.write,
    required this.isCurrent,
    required this.can,
  });

  @override
  final String scope;

  final String customerId;
  final CustomerDeleteRead read;
  final CustomerDeleteWrite write;
  final bool Function() isCurrent;
  final bool Function(String permission) can;

  @override
  void checkCurrent() {
    if (scope.isEmpty || customerId.isEmpty) {
      throw const FormatException('INVALID_CUSTOMER_DELETE_OWNER');
    }

    if (!isCurrent() || !can('view:customers')) {
      throw StateError('CUSTOMER_DELETE_SCOPE_CHANGED');
    }
  }

  @override
  void checkDelete(models.CustomersDeleteInput input) {
    checkCurrent();

    if (input.id != customerId) {
      throw const FormatException('INVALID_CUSTOMER_DELETE_TARGET');
    }

    if (!can('delete:customers')) {
      throw StateError('CUSTOMER_DELETE_FORBIDDEN');
    }
  }

  @override
  Future<models.Customer> getCustomer(String id) async {
    checkCurrent();

    if (id != customerId) {
      throw const FormatException('INVALID_CUSTOMER_DELETE_READ_TARGET');
    }

    final customer = await read(
      ApiQueries.customersGet,
      models.CustomersGetInput(id: id),
    );

    checkCurrent();

    if (customer.id != id) {
      throw const FormatException('CUSTOMER_DELETE_RESPONSE_ID_MISMATCH');
    }

    return freezeCustomerDeleteBaseline(customer);
  }

  @override
  Future<models.CustomersDeleteOutput> deleteCustomer(
    models.CustomersDeleteInput input,
  ) async {
    checkDelete(input);

    final request = models.CustomersDeleteInput(id: input.id);

    final result = await write(ApiMutations.customersDelete, request);

    // Losing delete permission must not erase a genuine acknowledgement.
    checkCurrent();

    if (!result.success) {
      throw const FormatException('INVALID_CUSTOMER_DELETE_RESULT');
    }

    return result;
  }
}
