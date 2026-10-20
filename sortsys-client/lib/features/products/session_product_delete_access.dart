import 'dart:convert';

import '../../state/session_controller.dart';
import 'product_delete_rpc_access.dart';

ProductDeleteRpcAccess sessionProductDeleteAccess(
  SessionController session, {
  required String productId,
  bool Function()? isActive,
}) {
  final binding = session.binding;
  final scope = jsonEncode([
    session.instance?.origin.toString(),
    session.tenant,
    session.info?.userId,
    productId,
  ]);

  return ProductDeleteRpcAccess(
    scope: scope,
    productId: productId,
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
