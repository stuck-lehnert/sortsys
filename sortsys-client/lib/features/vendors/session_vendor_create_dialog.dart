import 'package:flutter/widgets.dart';

import '../../api/generated/models.g.dart' as models;
import '../../state/session_controller.dart';
import 'secure_vendor_receipts.dart';
import 'session_vendor_access.dart';
import 'vendor_dialog.dart';
import 'vendor_write_coordinator.dart';

final _openVendorCreates = Expando<bool>('vendor-create-dialogs');

Future<models.ProductVendor?> showSessionVendorCreateDialog(
  BuildContext context,
  SessionController session, {
  String initialQuery = '',
  bool Function()? isActive,
}) async {
  if (_openVendorCreates[session] == true) {
    return null;
  }

  final binding = session.binding;

  bool current() {
    return context.mounted &&
        (isActive?.call() ?? true) &&
        session.authenticated &&
        session.binding == binding &&
        session.info?.can('view:productVendors') == true;
  }

  if (!current() || session.info?.can('manage:productVendors') != true) {
    return null;
  }

  final coordinator = VendorWriteCoordinator(
    access: sessionVendorWriteAccess(session, isActive: current),
    receipts: SecureVendorReceipts(),
  );
  _openVendorCreates[session] = true;

  try {
    return await showVendorDialog(
      context,
      initialQuery: initialQuery,
      coordinator: coordinator,
      queryIdentity: binding,
      isCurrent: current,
      canSave: () {
        return current() && session.info?.can('manage:productVendors') == true;
      },
      changes: session,
    );
  } finally {
    _openVendorCreates[session] = false;
  }
}
