import 'package:flutter/material.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

import '../../ui/text.dart';

class ProductDetailMenu extends StatelessWidget {
  const ProductDetailMenu({
    super.key,
    this.onRecordPrice,
    this.onEditCategories,
    this.onEdit,
    this.onDelete,
    this.busy = false,
  });

  final VoidCallback? onRecordPrice;
  final VoidCallback? onEditCategories;
  final VoidCallback? onEdit;
  final VoidCallback? onDelete;
  final bool busy;

  Widget _caption(String label, double maxWidth) {
    return ConstrainedBox(
      constraints: BoxConstraints(maxWidth: maxWidth),
      child: Text(label),
    );
  }

  @override
  Widget build(BuildContext context) {
    if (onRecordPrice == null &&
        onEditCategories == null &&
        onEdit == null &&
        onDelete == null) {
      return const SizedBox.shrink();
    }

    final colors = SsTheme.of(context);
    final captionWidth = (MediaQuery.sizeOf(context).width - 96)
        .clamp(80.0, 280.0)
        .toDouble();
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
        if (onRecordPrice != null)
          MenuItemButton(
            key: const ValueKey('product-record-price'),
            onPressed: busy ? null : onRecordPrice,
            style: itemStyle,
            leadingIcon: const SsIcon('price-record', size: 16),
            child: _caption(
              text(context, 'Preis verzeichnen', 'Record price'),
              captionWidth,
            ),
          ),
        if (onEditCategories != null)
          MenuItemButton(
            key: const ValueKey('product-edit-categories'),
            onPressed: busy ? null : onEditCategories,
            style: itemStyle,
            leadingIcon: const SsIcon('edit', size: 16),
            child: _caption(
              text(context, 'Kategorien bearbeiten', 'Edit categories'),
              captionWidth,
            ),
          ),
        if (onEdit != null)
          MenuItemButton(
            key: const ValueKey('product-edit'),
            onPressed: busy ? null : onEdit,
            style: itemStyle,
            leadingIcon: const SsIcon('edit', size: 16),
            child: _caption(text(context, 'Bearbeiten', 'Edit'), captionWidth),
          ),
        if (onDelete != null)
          MenuItemButton(
            key: const ValueKey('product-delete'),
            onPressed: busy ? null : onDelete,
            style: itemStyle,
            leadingIcon: const SsIcon('trash-can', size: 16),
            child: _caption(text(context, 'Löschen', 'Delete'), captionWidth),
          ),
      ],
      builder: (context, controller, child) {
        return SsIconButton(
          icon: 'overflow-menu-vertical',
          label: text(context, 'Produktaktionen', 'Product actions'),
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
