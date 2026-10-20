import 'dart:async';

import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:provider/provider.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

import '../../api/generated/models.g.dart' as models;
import '../../state/session_controller.dart';
import '../../ui/text.dart';
import 'customer_draft.dart';
import 'session_customer_dialog.dart';

class CustomerEditAction extends StatefulWidget {
  const CustomerEditAction({
    super.key,
    required this.customer,
    required this.onSaved,
    this.isActive,
    this.ownerContext,
  });

  final models.Customer customer;
  final ValueChanged<String> onSaved;
  final bool Function()? isActive;
  final BuildContext? ownerContext;

  @override
  State<CustomerEditAction> createState() {
    return _CustomerEditActionState();
  }
}

class _CustomerEditActionState extends State<CustomerEditAction> {
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
        session.info?.can('view:customers') == true &&
        session.info?.can('manage:customers') == true;
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
        ModalRoute.of(context)?.isCurrent != true ||
        !_allowed(context.read<SessionController>())) {
      return false;
    }

    unawaited(_edit());

    return true;
  }

  Future<void> _edit() async {
    final session = context.read<SessionController>();

    if (_opening ||
        !_allowed(session) ||
        ModalRoute.of(context)?.isCurrent != true) {
      return;
    }

    final binding = session.binding;
    final customer = widget.customer;
    final ownerCurrent = widget.isActive;
    final ownerContext = widget.ownerContext ?? context;
    final onSaved = widget.onSaved;

    bool current() {
      return (ownerCurrent?.call() ?? mounted) &&
          session.authenticated &&
          session.binding == binding &&
          session.info?.can('view:customers') == true &&
          (mounted
              ? customerBaselineKey(widget.customer) ==
                    customerBaselineKey(customer)
              : ownerCurrent != null);
    }

    String? id;

    setState(() {
      _opening = true;
    });

    try {
      id = await showSessionCustomerDialog(
        ownerContext,
        session,
        customer: customer,
        isActive: current,
      );
    } finally {
      if (mounted) {
        setState(() {
          _opening = false;
        });
      }
    }

    if (id != null && current()) {
      onSaved(id);
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
