import 'package:flutter/widgets.dart';

import '../../api/generated/models.g.dart' as models;
import '../../state/session_controller.dart';
import 'customer_delete_coordinator.dart';
import 'customer_delete_dialog.dart';
import 'secure_customer_delete_receipts.dart';
import 'session_customer_delete_access.dart';

final _openCustomerDeletes = Expando<bool>('customer-delete-dialogs');

bool canDeleteCustomer(bool Function(String permission) can) {
  return can('view:customers') && can('delete:customers');
}

Future<String?> showSessionCustomerDeleteDialog(
  BuildContext context,
  SessionController session, {
  required models.Customer customer,
  bool Function()? isActive,
}) async {
  final binding = session.binding;

  bool current() {
    return context.mounted &&
        (isActive?.call() ?? true) &&
        session.authenticated &&
        session.instance != null &&
        session.binding == binding &&
        session.info?.can('view:customers') == true;
  }

  bool permitted() {
    return current() && session.info?.can('delete:customers') == true;
  }

  if (customer.id.isEmpty ||
      !permitted() ||
      _openCustomerDeletes[session] == true) {
    return null;
  }

  _openCustomerDeletes[session] = true;

  try {
    final access = sessionCustomerDeleteAccess(
      session,
      customerId: customer.id,
      isActive: current,
    );
    final coordinator = CustomerDeleteCoordinator(
      access: access,
      receipts: SecureCustomerDeleteReceipts(),
    );

    return await showCustomerDeleteDialog(
      context,
      customer: customer,
      coordinator: coordinator,
      queryIdentity: (binding, customer.id),
      isCurrent: current,
      canDelete: permitted,
      changes: session,
    );
  } finally {
    _openCustomerDeletes[session] = false;
  }
}
