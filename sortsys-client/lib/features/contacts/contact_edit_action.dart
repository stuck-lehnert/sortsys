import 'dart:async';

import 'package:flutter/services.dart';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

import '../../api/generated/models.g.dart' as models;
import '../../state/session_controller.dart';
import '../../ui/text.dart';
import 'contact_delete_receipt.dart';
import 'contact_receipt.dart';
import 'session_contact_delete_dialog.dart';
import 'session_contact_dialog.dart';

class ContactEditAction extends StatefulWidget {
  const ContactEditAction({
    super.key,
    required this.contact,
    required this.onSaved,
    this.onDeleted,
    this.isActive,
    this.ownerContext,
  });

  final models.Contact contact;
  final ValueChanged<models.Contact> onSaved;
  final ValueChanged<String>? onDeleted;
  final bool Function()? isActive;
  final BuildContext? ownerContext;

  @override
  State<ContactEditAction> createState() {
    return _ContactEditActionState();
  }
}

class _ContactEditActionState extends State<ContactEditAction> {
  bool _opening = false;

  @override
  void initState() {
    super.initState();

    HardwareKeyboard.instance.addHandler(_editKey);
  }

  @override
  void dispose() {
    HardwareKeyboard.instance.removeHandler(_editKey);

    super.dispose();
  }

  bool _allowed(SessionController session) {
    return session.authenticated &&
        session.info?.can('view:contacts') == true &&
        session.info?.can('manage:contacts') == true;
  }

  bool _editKey(KeyEvent event) {
    final keyboard = HardwareKeyboard.instance;

    if (event is! KeyDownEvent ||
        event.logicalKey != LogicalKeyboardKey.keyE ||
        !keyboard.isControlPressed ||
        keyboard.isAltPressed ||
        keyboard.isMetaPressed ||
        keyboard.isShiftPressed) {
      return false;
    }

    if (!mounted ||
        _opening ||
        !(widget.isActive?.call() ?? true) ||
        ModalRoute.of(context)?.isCurrent != true ||
        !_allowed(context.read<SessionController>())) {
      return false;
    }

    unawaited(_edit());

    return true;
  }

  Future<void> _edit() async {
    if (!mounted) {
      return;
    }

    final session = context.read<SessionController>();

    if (_opening ||
        !(widget.isActive?.call() ?? true) ||
        !_allowed(session) ||
        ModalRoute.of(context)?.isCurrent != true) {
      return;
    }

    final binding = session.binding;
    final contact = widget.contact;
    final ownerCurrent = widget.isActive;
    final ownerContext = widget.ownerContext ?? context;
    final onSaved = widget.onSaved;

    bool current() {
      return mounted &&
          ownerContext.mounted &&
          (ownerCurrent?.call() ?? true) &&
          session.authenticated &&
          session.binding == binding &&
          session.info?.can('view:contacts') == true &&
          sameContactSnapshot(widget.contact, contact);
    }

    models.Contact? result;

    setState(() {
      _opening = true;
    });

    try {
      result = await showSessionContactDialog(
        ownerContext,
        session,
        contact: contact,
        isActive: current,
      );
    } finally {
      if (mounted) {
        setState(() {
          _opening = false;
        });
      }
    }

    if (result != null && current()) {
      onSaved(result);
    }
  }

  bool _deleteAllowed(SessionController session) {
    return widget.onDeleted != null &&
        session.authenticated &&
        canDeleteContact((permission) {
          return session.info?.can(permission) == true;
        });
  }

  Future<void> _delete() async {
    if (!mounted) {
      return;
    }

    final session = context.read<SessionController>();

    if (_opening ||
        !(widget.isActive?.call() ?? true) ||
        !_deleteAllowed(session) ||
        ModalRoute.of(context)?.isCurrent != true) {
      return;
    }

    final binding = session.binding;
    final contact = freezeContactDeleteBaseline(widget.contact);
    final ownerCurrent = widget.isActive;
    final ownerContext = widget.ownerContext ?? context;
    final onDeleted = widget.onDeleted;

    bool current() {
      return mounted &&
          ownerContext.mounted &&
          (ownerCurrent?.call() ?? true) &&
          session.authenticated &&
          session.binding == binding &&
          session.info?.can('view:contacts') == true &&
          sameContactDeleteBaseline(widget.contact, contact);
    }

    String? id;

    setState(() {
      _opening = true;
    });

    try {
      id = await showSessionContactDeleteDialog(
        ownerContext,
        session,
        contact: contact,
        isActive: current,
      );
    } finally {
      if (mounted) {
        setState(() {
          _opening = false;
        });
      }
    }

    if (id == contact.id && current()) {
      onDeleted?.call(id!);
    }
  }

  @override
  Widget build(BuildContext context) {
    final session = context.watch<SessionController>();

    if (widget.onDeleted != null) {
      return ContactDetailMenu(
        busy: _opening,
        onEdit: _allowed(session)
            ? () {
                unawaited(_edit());
              }
            : null,
        onDelete: _deleteAllowed(session)
            ? () {
                unawaited(_delete());
              }
            : null,
      );
    }

    if (!_allowed(session)) {
      return const SizedBox.shrink();
    }

    return SsButton(
      kind: SsButtonKind.ghost,
      onPressed: _opening
          ? null
          : () {
              unawaited(_edit());
            },
      child: Text(text(context, 'Bearbeiten', 'Edit')),
    );
  }
}

class ContactDetailMenu extends StatelessWidget {
  const ContactDetailMenu({
    super.key,
    this.onEdit,
    this.onDelete,
    this.busy = false,
  });

  final VoidCallback? onEdit;
  final VoidCallback? onDelete;
  final bool busy;

  @override
  Widget build(BuildContext context) {
    if (onEdit == null && onDelete == null) {
      return const SizedBox.shrink();
    }

    final colors = SsTheme.of(context);
    final itemStyle = ButtonStyle(
      textStyle: WidgetStatePropertyAll(colors.body),
      foregroundColor: WidgetStateProperty.resolveWith((states) {
        if (states.contains(WidgetState.disabled)) {
          return colors.secondaryText;
        }

        return colors.text;
      }),
    );

    return MenuAnchor(
      style: MenuStyle(
        backgroundColor: WidgetStatePropertyAll(colors.surface),
        surfaceTintColor: const WidgetStatePropertyAll(Colors.transparent),
        elevation: const WidgetStatePropertyAll(0),
        side: WidgetStatePropertyAll(BorderSide(color: colors.border)),
        shape: const WidgetStatePropertyAll(RoundedRectangleBorder()),
      ),
      menuChildren: [
        if (onEdit != null)
          MenuItemButton(
            key: const ValueKey('contact-edit'),
            onPressed: busy ? null : onEdit,
            style: itemStyle,
            leadingIcon: const SsIcon('edit', size: 16),
            child: Text(text(context, 'Bearbeiten', 'Edit')),
          ),
        if (onDelete != null)
          MenuItemButton(
            key: const ValueKey('contact-delete'),
            onPressed: busy ? null : onDelete,
            style: itemStyle,
            leadingIcon: const SsIcon('trash-can', size: 16),
            child: Text(text(context, 'Löschen', 'Delete')),
          ),
      ],
      builder: (context, controller, child) {
        return SsIconButton(
          icon: 'overflow-menu-vertical',
          label: text(context, 'Kontaktaktionen', 'Contact actions'),
          onPressed: busy
              ? null
              : () {
                  if (controller.isOpen) {
                    controller.close();
                  } else {
                    controller.open();
                  }
                },
        );
      },
    );
  }
}
