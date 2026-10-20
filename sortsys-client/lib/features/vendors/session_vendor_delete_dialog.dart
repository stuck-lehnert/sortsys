import 'package:flutter/widgets.dart';

import '../../api/generated/models.g.dart' as models;
import '../../state/session_controller.dart';
import 'secure_vendor_receipts.dart';
import 'session_vendor_access.dart';
import 'vendor_delete_coordinator.dart';
import 'vendor_delete_dialog.dart';

final _openVendorDeletes = Expando<Set<String>>('vendor-delete-dialogs');

bool canDeleteVendor(bool Function(String permission) can) {
  return can('view:productVendors') && can('delete:productVendors');
}

Future<String?> showSessionVendorDeleteDialog(
  BuildContext context,
  SessionController session, {
  required models.ProductVendor vendor,
  bool Function()? isActive,
}) async {
  final binding = session.binding;

  bool current() {
    return context.mounted &&
        (isActive?.call() ?? true) &&
        session.authenticated &&
        session.binding == binding &&
        session.info?.can('view:productVendors') == true;
  }

  bool permitted() {
    return current() && session.info?.can('delete:productVendors') == true;
  }

  if (vendor.id.isEmpty || !permitted()) {
    return null;
  }

  final opened = _openVendorDeletes[session] ??= <String>{};

  if (!opened.add(vendor.id)) {
    return null;
  }

  try {
    final access = sessionVendorWriteAccess(
      session,
      vendorId: vendor.id,
      isActive: current,
    );

    if (access is! VendorDeleteAccess) {
      throw StateError('VENDOR_DELETE_ACCESS_UNAVAILABLE');
    }

    final coordinator = VendorDeleteCoordinator(
      access: access,
      receipts: SecureVendorReceipts(),
    );

    return await showVendorDeleteDialog(
      context,
      vendor: vendor,
      coordinator: coordinator,
      queryIdentity: binding,
      isCurrent: current,
      canDelete: permitted,
      changes: session,
    );
  } finally {
    opened.remove(vendor.id);
  }
}
