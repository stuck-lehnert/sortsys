import 'package:flutter/widgets.dart';

import '../../api/generated/models.g.dart' as models;
import '../../state/session_controller.dart';
import 'contact_delete_coordinator.dart';
import 'contact_delete_dialog.dart';
import 'secure_contact_delete_receipts.dart';
import 'session_contact_delete_access.dart';

final _openContactDeletes = Expando<bool>('contact-delete-dialogs');

bool canDeleteContact(bool Function(String permission) can) {
  return can('view:contacts') && can('delete:contacts');
}

Future<String?> showSessionContactDeleteDialog(
  BuildContext context,
  SessionController session, {
  required models.Contact contact,
  bool Function()? isActive,
}) async {
  final binding = session.binding;

  bool current() {
    return context.mounted &&
        (isActive?.call() ?? true) &&
        session.authenticated &&
        session.instance != null &&
        session.binding == binding &&
        session.info?.can('view:contacts') == true;
  }

  bool permitted() {
    return current() && session.info?.can('delete:contacts') == true;
  }

  if (contact.id.isEmpty ||
      !permitted() ||
      _openContactDeletes[session] == true) {
    return null;
  }

  _openContactDeletes[session] = true;

  try {
    final access = sessionContactDeleteAccess(
      session,
      contactId: contact.id,
      isActive: current,
    );
    final coordinator = ContactDeleteCoordinator(
      access: access,
      receipts: SecureContactDeleteReceipts(),
    );

    return await showContactDeleteDialog(
      context,
      contact: contact,
      coordinator: coordinator,
      queryIdentity: (binding, contact.id),
      isCurrent: current,
      canDelete: permitted,
      changes: session,
    );
  } finally {
    _openContactDeletes[session] = false;
  }
}
