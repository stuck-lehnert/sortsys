import 'dart:async';

import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:provider/provider.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

import '../../api/generated/models.g.dart' as models;
import '../../state/session_controller.dart';
import '../../ui/text.dart';
import 'secure_vendor_receipts.dart';
import 'session_vendor_access.dart';
import 'vendor_dialog.dart';
import 'vendor_receipt.dart';
import 'vendor_write_coordinator.dart';

class VendorEditAction extends StatefulWidget {
  const VendorEditAction({
    super.key,
    required this.vendor,
    required this.onSaved,
  });

  final models.ProductVendor vendor;
  final ValueChanged<models.ProductVendor> onSaved;

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
          sameVendorSnapshot(widget.vendor, vendor);
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

  @override
  Widget build(BuildContext context) {
    final session = context.watch<SessionController>();

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
