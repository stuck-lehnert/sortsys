import 'package:flutter/widgets.dart';

import '../../api/generated/models.g.dart' as models;
import '../../state/session_controller.dart';
import 'contact_dialog.dart';
import 'contact_write_coordinator.dart';
import 'secure_contact_receipts.dart';
import 'session_contact_access.dart';

final _openContactDialogs = Expando<Set<String?>>('contact-write-dialogs');

Future<models.Contact?> showSessionContactDialog(
  BuildContext context,
  SessionController session, {
  models.Contact? contact,
  String initialQuery = '',
  bool Function()? isActive,
}) async {
  final binding = session.binding;
  final target = contact?.id;
  final openTargets = _openContactDialogs[session] ??= <String?>{};

  bool current() {
    return context.mounted &&
        (isActive?.call() ?? true) &&
        session.authenticated &&
        session.binding == binding &&
        session.info?.can('view:contacts') == true;
  }

  if (!current() ||
      session.info?.can('manage:contacts') != true ||
      openTargets.contains(target)) {
    return null;
  }

  final coordinator = ContactWriteCoordinator(
    access: sessionContactWriteAccess(
      session,
      contactId: target,
      isActive: current,
    ),
    receipts: SecureContactReceipts(),
  );
  openTargets.add(target);

  try {
    return await showContactDialog(
      context,
      contact: contact,
      initialQuery: initialQuery,
      coordinator: coordinator,
      queryIdentity: (binding, target),
      isCurrent: current,
      canSave: () {
        return current() && session.info?.can('manage:contacts') == true;
      },
      changes: session,
    );
  } finally {
    openTargets.remove(target);
  }
}
