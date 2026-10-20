import 'package:flutter/widgets.dart';

import '../../api/generated/models.g.dart' as models;
import '../../state/session_controller.dart';
import 'product_categories_dialog.dart';
import 'product_categories_write_coordinator.dart';
import 'secure_product_categories_receipts.dart';
import 'session_product_categories_access.dart';

final _openCategoryDialogs = Expando<Set<String>>('product-category-dialogs');

Future<models.Product?> showSessionProductCategoriesDialog(
  BuildContext context,
  SessionController session, {
  required models.Product product,
  bool Function()? isActive,
}) async {
  final binding = session.binding;
  final target = product.id;
  final openTargets = _openCategoryDialogs[session] ??= <String>{};

  bool current() {
    return context.mounted &&
        (isActive?.call() ?? true) &&
        session.authenticated &&
        session.instance != null &&
        session.binding == binding &&
        session.info?.can('view:products') == true;
  }

  if (target.isEmpty ||
      !current() ||
      session.info?.can('manage:products') != true ||
      openTargets.contains(target)) {
    return null;
  }

  final access = sessionProductCategoriesAccess(
    session,
    productId: target,
    isActive: current,
  );
  final coordinator = ProductCategoriesWriteCoordinator(
    access: access,
    receipts: SecureProductCategoriesReceipts(),
  );
  openTargets.add(target);

  try {
    return await showProductCategoriesDialog(
      context,
      product: product,
      coordinator: coordinator,
      queryIdentity: (binding, target),
      isCurrent: current,
      canSave: () {
        return current() && session.info?.can('manage:products') == true;
      },
      loadCategories: access.getCategories,
      changes: session,
    );
  } finally {
    openTargets.remove(target);
  }
}
