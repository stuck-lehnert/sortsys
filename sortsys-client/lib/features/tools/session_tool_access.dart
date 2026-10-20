import 'dart:convert';

import '../../state/session_controller.dart';
import 'tool_rpc_access.dart';

ToolRpcAccess sessionToolWriteAccess(
  SessionController session, {
  String? toolId,
  bool Function()? isActive,
}) {
  final binding = session.binding;
  final scope = jsonEncode([
    session.instance?.origin.toString(),
    session.tenant,
    session.info?.userId,
    toolId,
  ]);

  return ToolRpcAccess(
    scope: scope,
    toolId: toolId,
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
