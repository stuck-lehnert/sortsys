import 'dart:async';

import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:provider/provider.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

import '../../api/generated/models.g.dart' as models;
import '../../state/session_controller.dart';
import '../../ui/text.dart';
import 'contact_receipt.dart';
import 'session_contact_dialog.dart';

class ContactEditAction extends StatefulWidget {
  const ContactEditAction({
    super.key,
    required this.contact,
    required this.onSaved,
  });

  final models.Contact contact;
  final ValueChanged<models.Contact> onSaved;

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

    if (_opening ||
        !_allowed(session) ||
        ModalRoute.of(context)?.isCurrent != true) {
      return;
    }

    final binding = session.binding;
    final contact = widget.contact;

    bool current() {
      return mounted &&
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
        context,
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
