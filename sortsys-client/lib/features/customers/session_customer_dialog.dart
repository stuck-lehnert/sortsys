import 'package:flutter/widgets.dart';

import '../../api/generated/models.g.dart' as models;
import '../../state/session_controller.dart';
import '../contacts/session_contact_dialog.dart';
import 'customer_dialog.dart';
import 'customer_write.dart';
import 'secure_customer_receipts.dart';
import 'session_customer_access.dart';

final _openCustomerDialogs = Expando<bool>('customer-write-dialogs');

Future<String?> showSessionCustomerDialog(
  BuildContext context,
  SessionController session, {
  models.Customer? customer,
  String initialQuery = '',
  bool Function()? isActive,
}) async {
  final binding = session.binding;

  bool current() {
    return context.mounted &&
        (isActive?.call() ?? true) &&
        session.authenticated &&
        session.binding == binding &&
        session.info?.can('view:customers') == true;
  }

  if (!current() ||
      session.info?.can('manage:customers') != true ||
      _openCustomerDialogs[session] == true) {
    return null;
  }

  bool canCreateContact() {
    return current() &&
        session.info?.can('manage:customers') == true &&
        session.info?.can('view:contacts') == true &&
        session.info?.can('manage:contacts') == true;
  }

  Future<models.Contact?> createContact(String query) async {
    if (!canCreateContact()) {
      return null;
    }

    final created = await showSessionContactDialog(
      context,
      session,
      initialQuery: query,
      isActive: current,
    );

    if (!canCreateContact()) {
      return null;
    }

    return created;
  }

  final access = SessionCustomerAccess(session, isActive: current);
  final coordinator = CustomerWriteCoordinator(
    access: access,
    receipts: SecureCustomerReceipts(),
  );
  _openCustomerDialogs[session] = true;

  try {
    return await showCustomerDialog(
      context,
      customer: customer,
      initialQuery: initialQuery,
      coordinator: coordinator,
      loadContacts: access.searchContacts,
      createContact: createContact,
      canCreateContact: canCreateContact,
      queryIdentity: (binding, customer?.id),
      isCurrent: current,
      canSave: () {
        return current() && session.info?.can('manage:customers') == true;
      },
      changes: session,
    );
  } finally {
    _openCustomerDialogs[session] = false;
  }
}
