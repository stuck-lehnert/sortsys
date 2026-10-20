import 'package:flutter/widgets.dart';

import '../../api/generated/models.g.dart' as models;
import '../../state/session_controller.dart';
import 'product_delete_coordinator.dart';
import 'product_delete_dialog.dart';
import 'secure_product_categories_receipts.dart';
import 'secure_product_delete_receipts.dart';
import 'secure_product_price_receipts.dart';
import 'session_product_delete_access.dart';

final _openProductDeletes = Expando<bool>('product-delete-dialogs');

bool canDeleteProduct(bool Function(String permission) can) {
  return can('view:products') && can('delete:products');
}

Future<String?> showSessionProductDeleteDialog(
  BuildContext context,
  SessionController session, {
  required models.Product product,
  bool Function()? isActive,
}) async {
  final binding = session.binding;

  bool current() {
    return context.mounted &&
        (isActive?.call() ?? true) &&
        session.authenticated &&
        session.instance != null &&
        session.binding == binding &&
        session.info?.can('view:products') == true;
  }

  bool permitted() {
    return current() && session.info?.can('delete:products') == true;
  }

  if (product.id.isEmpty ||
      !permitted() ||
      _openProductDeletes[session] == true) {
    return null;
  }

  _openProductDeletes[session] = true;

  try {
    final access = sessionProductDeleteAccess(
      session,
      productId: product.id,
      isActive: current,
    );
    final coordinator = ProductDeleteCoordinator(
      access: access,
      receipts: SecureProductDeleteReceipts(),
      priceReceipts: SecureProductPriceReceipts(),
      categoryReceipts: SecureProductCategoriesReceipts(),
    );

    return await showProductDeleteDialog(
      context,
      product: product,
      coordinator: coordinator,
      queryIdentity: (binding, product.id),
      isCurrent: current,
      canDelete: permitted,
      changes: session,
    );
  } finally {
    _openProductDeletes[session] = false;
  }
}
