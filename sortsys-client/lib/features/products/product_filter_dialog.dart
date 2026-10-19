import 'package:flutter/material.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

import '../../ui/text.dart';
import 'product_list_state.dart';

class ProductFilterDialog extends StatefulWidget {
  const ProductFilterDialog({
    super.key,
    required this.initialFilter,
    required this.queryIdentity,
    required this.loadBrands,
    required this.loadCategories,
    required this.onApplied,
    required this.onCancel,
    this.enabled = true,
  });

  final ProductListFilter initialFilter;
  final Object queryIdentity;
  final Future<List<String>> Function(String) loadBrands;
  final Future<List<String>> Function(String) loadCategories;
  final ValueChanged<ProductListFilter> onApplied;
  final VoidCallback onCancel;
  final bool enabled;

  @override
  State<ProductFilterDialog> createState() {
    return _ProductFilterDialogState();
  }
}

class _ProductFilterDialogState extends State<ProductFilterDialog> {
  var _form = GlobalKey<FormState>();
  String? _brand;
  String? _category;

  @override
  void initState() {
    super.initState();

    _loadInitialFilter();
  }

  @override
  void didUpdateWidget(covariant ProductFilterDialog oldWidget) {
    super.didUpdateWidget(oldWidget);

    if (widget.queryIdentity == oldWidget.queryIdentity) {
      return;
    }

    _loadInitialFilter();
    _form = GlobalKey<FormState>();
  }

  void _loadInitialFilter() {
    final filter = widget.initialFilter;
    _brand = filter.brand?.isNotEmpty == true ? filter.brand : null;
    _category = filter.category?.isNotEmpty == true ? filter.category : null;
  }

  void _submit() {
    if (!widget.enabled || !_form.currentState!.validate()) {
      return;
    }

    widget.onApplied(ProductListFilter(brand: _brand, category: _category));
  }

  Widget _selection({
    required String label,
    required String name,
    required String? value,
    required Future<List<String>> Function(String) load,
    required ValueChanged<String?> onChanged,
  }) {
    if (value == null) {
      return SsAutocompleteField<String>(
        label: label,
        queryIdentity: (widget.queryIdentity, name),
        enabled: widget.enabled,
        loadOptions: load,
        displayString: (option) {
          return option;
        },
        loadingText: text(
          context,
          'Einträge werden geladen …',
          'Loading options …',
        ),
        emptyText: text(context, 'Keine Treffer', 'No matches'),
        failureText: text(
          context,
          'Einträge konnten nicht geladen werden.',
          'Options could not be loaded.',
        ),
        selectionRequiredText: text(
          context,
          'Eintrag aus der Liste auswählen.',
          'Choose an option from the list.',
        ),
        onChanged: (option) {
          if (option == null) {
            return;
          }

          onChanged(option);
        },
      );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(label, style: SsTheme.of(context).label),
        const SizedBox(height: 6),
        Row(
          children: [
            Expanded(
              child: SsSurface(
                padding: const EdgeInsets.all(9.6),
                child: Text(value),
              ),
            ),
            const SizedBox(width: 8),
            SsIconButton(
              icon: 'x',
              label: text(context, 'Auswahl entfernen', 'Remove selection'),
              onPressed: widget.enabled
                  ? () {
                      onChanged(null);
                    }
                  : null,
            ),
          ],
        ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    return Dialog(
      shape: const RoundedRectangleBorder(),
      insetPadding: const EdgeInsets.all(16),
      backgroundColor: SsTheme.of(context).surface,
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 640),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.all(16),
              child: Text(
                text(context, 'Produkte filtern', 'Filter products'),
                style: SsTheme.of(context).heading,
              ),
            ),
            Flexible(
              child: SingleChildScrollView(
                padding: const EdgeInsets.symmetric(horizontal: 16),
                child: Form(
                  key: _form,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      _selection(
                        label: text(context, 'Hersteller', 'Manufacturer'),
                        name: 'brand',
                        value: _brand,
                        load: widget.loadBrands,
                        onChanged: (value) {
                          setState(() {
                            _brand = value;
                          });
                        },
                      ),
                      const SizedBox(height: 16),
                      _selection(
                        label: text(context, 'Kategorie', 'Category'),
                        name: 'category',
                        value: _category,
                        load: widget.loadCategories,
                        onChanged: (value) {
                          setState(() {
                            _category = value;
                          });
                        },
                      ),
                      const SizedBox(height: 16),
                    ],
                  ),
                ),
              ),
            ),
            Padding(
              padding: const EdgeInsets.all(16),
              child: Wrap(
                alignment: WrapAlignment.end,
                spacing: 8,
                runSpacing: 8,
                children: [
                  SsButton(
                    kind: SsButtonKind.secondary,
                    onPressed: widget.onCancel,
                    child: Text(text(context, 'Abbrechen', 'Cancel')),
                  ),
                  SsButton(
                    onPressed: widget.enabled ? _submit : null,
                    child: Text(
                      text(context, 'Filter anwenden', 'Apply filter'),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
