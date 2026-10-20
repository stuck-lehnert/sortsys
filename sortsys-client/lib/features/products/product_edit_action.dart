import 'dart:async';

import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:provider/provider.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

import '../../api/generated/models.g.dart' as models;
import '../../state/session_controller.dart';
import '../../ui/text.dart';
import 'product_master_receipt.dart';
import 'session_product_master_dialog.dart';

typedef ProductEditActionBuilder =
    Widget Function(BuildContext context, VoidCallback? edit, bool busy);

class ProductEditAction extends StatefulWidget {
  const ProductEditAction({
    super.key,
    required this.product,
    required this.onSaved,
    this.builder,
    this.enabled = true,
    this.isActive,
  });

  final models.Product product;
  final ValueChanged<models.Product> onSaved;
  final ProductEditActionBuilder? builder;
  final bool enabled;
  final bool Function()? isActive;

  @override
  State<ProductEditAction> createState() {
    return _ProductEditActionState();
  }
}

class _ProductEditActionState extends State<ProductEditAction> {
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
        session.info?.can('view:products') == true &&
        session.info?.can('manage:products') == true;
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
        !widget.enabled ||
        widget.isActive?.call() == false ||
        ModalRoute.of(context)?.isCurrent != true) {
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
        !widget.enabled ||
        widget.isActive?.call() == false ||
        !_allowed(session) ||
        ModalRoute.of(context)?.isCurrent != true) {
      return;
    }

    final binding = session.binding;
    final product = widget.product;

    bool current() {
      return mounted &&
          session.authenticated &&
          session.binding == binding &&
          session.info?.can('view:products') == true &&
          sameProductMasterSnapshot(widget.product, product) &&
          (widget.isActive?.call() ?? true);
    }

    models.Product? result;

    setState(() {
      _opening = true;
    });

    try {
      result = await showSessionProductMasterDialog(
        context,
        session,
        product: product,
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
    VoidCallback? edit;

    if (_allowed(session)) {
      edit = () {
        unawaited(_edit());
      };
    }

    final busy = _opening || !widget.enabled;
    final builder = widget.builder;

    if (builder != null) {
      // Keep the keyboard/dialog owner outside a transient menu overlay.
      return builder(context, edit, busy);
    }

    if (edit == null) {
      return const SizedBox.shrink();
    }

    return SsButton(
      kind: SsButtonKind.ghost,
      onPressed: busy ? null : edit,
      child: Text(text(context, 'Bearbeiten', 'Edit')),
    );
  }
}
