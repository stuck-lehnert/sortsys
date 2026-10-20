import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

import '../../api/generated/models.g.dart' as models;
import '../../state/session_controller.dart';
import '../../ui/text.dart';
import 'secure_vendor_receipts.dart';
import 'session_vendor_access.dart';
import 'session_vendor_delete_dialog.dart';
import 'vendor_dialog.dart';
import 'vendor_receipt.dart';
import 'vendor_write_coordinator.dart';

class VendorEditAction extends StatefulWidget {
  const VendorEditAction({
    super.key,
    required this.vendor,
    required this.onSaved,
    this.onDeleted,
    this.isActive,
  });

  final models.ProductVendor vendor;
  final ValueChanged<models.ProductVendor> onSaved;
  final ValueChanged<String>? onDeleted;
  final bool Function()? isActive;

  @override
  State<VendorEditAction> createState() {
    return _VendorEditActionState();
  }
}

class _VendorEditActionState extends State<VendorEditAction> {
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
        session.info?.can('view:productVendors') == true &&
        session.info?.can('manage:productVendors') == true;
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

    if (!mounted || _opening || ModalRoute.of(context)?.isCurrent != true) {
      return false;
    }

    if (!_allowed(context.read<SessionController>())) {
      return false;
    }

    unawaited(_edit());

    return true;
  }

  Future<void> _edit() async {
    final session = context.read<SessionController>();

    if (_opening || !_allowed(session)) {
      return;
    }

    final binding = session.binding;
    final vendor = widget.vendor;

    bool current() {
      return mounted &&
          session.authenticated &&
          session.binding == binding &&
          session.info?.can('view:productVendors') == true &&
          sameVendorSnapshot(widget.vendor, vendor) &&
          (widget.isActive?.call() ?? true);
    }

    final coordinator = VendorWriteCoordinator(
      access: sessionVendorWriteAccess(
        session,
        vendorId: vendor.id,
        isActive: current,
      ),
      receipts: SecureVendorReceipts(),
    );
    models.ProductVendor? result;
    setState(() {
      _opening = true;
    });

    try {
      result = await showVendorDialog(
        context,
        vendor: vendor,
        coordinator: coordinator,
        queryIdentity: binding,
        isCurrent: current,
        canSave: () {
          return current() &&
              session.info?.can('manage:productVendors') == true;
        },
        changes: session,
      );
    } finally {
      if (mounted) {
        setState(() {
          _opening = false;
        });
      }
    }

    if (result != null && current()) {
      widget.onSaved(result);
    }
  }

  bool _deleteAllowed(SessionController session) {
    return widget.onDeleted != null &&
        session.authenticated &&
        canDeleteVendor((permission) {
          return session.info?.can(permission) == true;
        });
  }

  Future<void> _delete() async {
    final session = context.read<SessionController>();

    if (_opening ||
        !_deleteAllowed(session) ||
        ModalRoute.of(context)?.isCurrent != true) {
      return;
    }

    final binding = session.binding;
    final vendor = widget.vendor;

    bool current() {
      return mounted &&
          session.authenticated &&
          session.binding == binding &&
          session.info?.can('view:productVendors') == true &&
          sameVendorSnapshot(widget.vendor, vendor) &&
          (widget.isActive?.call() ?? true);
    }

    String? result;

    setState(() {
      _opening = true;
    });

    try {
      result = await showSessionVendorDeleteDialog(
        context,
        session,
        vendor: vendor,
        isActive: current,
      );
    } finally {
      if (mounted) {
        setState(() {
          _opening = false;
        });
      }
    }

    if (result == vendor.id && current()) {
      widget.onDeleted?.call(result!);
    }
  }

  @override
  Widget build(BuildContext context) {
    final session = context.watch<SessionController>();

    return VendorDetailMenu(
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
}

class VendorDetailMenu extends StatelessWidget {
  const VendorDetailMenu({
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
            onPressed: busy ? null : onEdit,
            style: itemStyle,
            leadingIcon: const SsIcon('edit', size: 16),
            child: Text(text(context, 'Bearbeiten', 'Edit')),
          ),
        if (onDelete != null)
          MenuItemButton(
            onPressed: busy ? null : onDelete,
            style: itemStyle,
            leadingIcon: const SsIcon('trash-can', size: 16),
            child: Text(text(context, 'Löschen', 'Delete')),
          ),
      ],
      builder: (context, controller, child) {
        return SsIconButton(
          icon: 'overflow-menu-vertical',
          label: text(context, 'Händleraktionen', 'Vendor actions'),
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
