import 'dart:convert';

import '../../state/session_controller.dart';
import 'customer_delete_rpc_access.dart';

CustomerDeleteRpcAccess sessionCustomerDeleteAccess(
  SessionController session, {
  required String customerId,
  bool Function()? isActive,
}) {
  final binding = session.binding;
  final scope = jsonEncode([
    session.instance?.origin.toString(),
    session.tenant,
    session.info?.userId,
  ]);

  return CustomerDeleteRpcAccess(
    scope: scope,
    customerId: customerId,
    read: session.read,
    write: session.write,
    isCurrent: () {
      return (isActive?.call() ?? true) &&
          session.authenticated &&
          session.instance != null &&
          session.binding == binding;
    },
    can: (permission) {
      return session.info?.can(permission) == true;
    },
  );
}
