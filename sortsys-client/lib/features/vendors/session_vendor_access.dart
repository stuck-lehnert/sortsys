import 'dart:convert';

import '../../state/session_controller.dart';
import 'vendor_rpc_access.dart';
import 'vendor_write_coordinator.dart';

VendorWriteAccess sessionVendorWriteAccess(
  SessionController session, {
  String? vendorId,
  bool Function()? isActive,
}) {
  final binding = session.binding;
  final scope = jsonEncode([
    session.instance?.origin.toString(),
    session.tenant,
    session.info?.userId,
    vendorId,
  ]);

  return VendorRpcAccess(
    scope: scope,
    vendorId: vendorId,
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
