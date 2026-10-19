import 'package:flutter/widgets.dart';

import '../../api/generated/models.g.dart' as models;
import '../../state/session_controller.dart';
import 'product_form_reads.dart';
import 'product_master_dialog.dart';
import 'product_master_write_coordinator.dart';
import 'secure_product_master_receipts.dart';
import 'session_product_master_access.dart';

final _openProductDialogs = Expando<Set<String?>>('product-master-dialogs');

Future<models.Product?> showSessionProductMasterDialog(
  BuildContext context,
  SessionController session, {
  models.Product? product,
  String initialQuery = '',
  bool Function()? isActive,
}) async {
  final binding = session.binding;
  final target = product?.id;
  final openTargets = _openProductDialogs[session] ??= <String?>{};

  bool current() {
    return context.mounted &&
        (isActive?.call() ?? true) &&
        session.authenticated &&
        session.binding == binding &&
        session.info?.can('view:products') == true;
  }

  if (!current() ||
      session.info?.can('manage:products') != true ||
      openTargets.contains(target)) {
    return null;
  }

  final coordinator = ProductMasterWriteCoordinator(
    access: sessionProductMasterWriteAccess(
      session,
      productId: target,
      isActive: current,
    ),
    receipts: SecureProductMasterReceipts(),
  );
  final reads = ProductFormReads(
    read: session.read,
    isCurrent: current,
    can: (permission) {
      return session.info?.can(permission) == true;
    },
  );
  openTargets.add(target);

  try {
    return await showProductMasterDialog(
      context,
      product: product,
      initialQuery: initialQuery,
      coordinator: coordinator,
      queryIdentity: (binding, target),
      isCurrent: current,
      canSave: () {
        return current() && session.info?.can('manage:products') == true;
      },
      loadUnits: reads.units,
      changes: session,
    );
  } finally {
    openTargets.remove(target);
  }
}
