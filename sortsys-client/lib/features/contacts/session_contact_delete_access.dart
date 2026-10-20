import 'dart:convert';

import '../../state/session_controller.dart';
import 'contact_delete_rpc_access.dart';

ContactDeleteRpcAccess sessionContactDeleteAccess(
  SessionController session, {
  required String contactId,
  bool Function()? isActive,
}) {
  final binding = session.binding;
  final scope = jsonEncode([
    session.instance?.origin.toString(),
    session.tenant,
    session.info?.userId,
    contactId,
  ]);

  return ContactDeleteRpcAccess(
    scope: scope,
    contactId: contactId,
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
