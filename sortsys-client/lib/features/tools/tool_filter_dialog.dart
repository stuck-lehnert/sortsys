import 'package:flutter/material.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

import '../../api/generated/models.g.dart' as models;
import '../../ui/text.dart';
import 'tool_list_filter.dart';

Uri applyToolFilters(Uri uri, ToolListFilter filter) {
  final parameters = {
    for (final entry in uri.queryParametersAll.entries)
      entry.key: List<String>.of(entry.value),
  };

  for (final key in ['status', 'brand', 'category']) {
    parameters.remove(key);
  }

  final status = filter.status;
  final brand = filter.brand;
  final category = filter.category;

  if (status != null) {
    parameters['status'] = [status.wireValue];
  }

  if (brand != null) {
    parameters['brand'] = [brand];
  }

  if (category != null) {
    parameters['category'] = [category];
  }

  return uri.replace(queryParameters: parameters);
}

Uri toolArchiveUri(Uri uri, {required bool archivedOnly}) {
  final parameters = {
    for (final entry in uri.queryParametersAll.entries)
      entry.key: List<String>.of(entry.value),
  };
  parameters.remove('archived');

  if (archivedOnly) {
    parameters['archived'] = ['yes'];
  }

  return uri.replace(queryParameters: parameters);
}

class ToolFilterDialog extends StatefulWidget {
  const ToolFilterDialog({
    super.key,
    required this.initialFilter,
    required this.queryIdentity,
    required this.loadBrands,
    required this.loadCategories,
    required this.onApplied,
    required this.onCancel,
    this.enabled = true,
  });

  final ToolListFilter initialFilter;
  final Object queryIdentity;
  final Future<List<String>> Function(String) loadBrands;
  final Future<List<String>> Function(String) loadCategories;
  final ValueChanged<ToolListFilter> onApplied;
  final VoidCallback onCancel;
  final bool enabled;

  @override
  State<ToolFilterDialog> createState() {
    return _ToolFilterDialogState();
  }
}

class _ToolFilterDialogState extends State<ToolFilterDialog> {
  var _form = GlobalKey<FormState>();
  late String _status;
  String? _brand;
  String? _category;

  @override
  void initState() {
    super.initState();

    _loadInitialFilter();
  }

  @override
  void didUpdateWidget(covariant ToolFilterDialog oldWidget) {
    super.didUpdateWidget(oldWidget);

    if (widget.queryIdentity == oldWidget.queryIdentity) {
      return;
    }

    _loadInitialFilter();
    _form = GlobalKey<FormState>();
  }

  void _loadInitialFilter() {
    final initial = widget.initialFilter;
    _status = initial.status?.wireValue ?? 'none';
    _brand = initial.brand?.isNotEmpty == true ? initial.brand : null;
    _category = initial.category?.isNotEmpty == true ? initial.category : null;
  }

  void _submit() {
    if (!widget.enabled || !_form.currentState!.validate()) {
      return;
    }

    models.ToolsListRequestStatus? status;

    for (final option in models.ToolsListRequestStatus.values) {
      if (option.wireValue == _status) {
        status = option;
        break;
      }
    }

    widget.onApplied(ToolListFilter(
      status: status,
      brand: _brand,
      category: _category,
      archivedOnly: widget.initialFilter.archivedOnly,
    ));
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
        loadingText: text(context, 'Einträge werden geladen …', 'Loading options …'),
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
                text(context, 'Werkzeuge filtern', 'Filter tools'),
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
                      SsSelectField<String>(
                        label: text(context, 'Status', 'Status'),
                        value: _status,
                        options: [
                          SsOption(
                            value: 'none',
                            label: text(context, 'Nicht ausgewählt', 'Not selected'),
                          ),
                          SsOption(
                            value: 'available',
                            label: text(context, 'Verfügbar', 'Available'),
                          ),
                          SsOption(
                            value: 'unavailable',
                            label: text(context, 'Gebucht', 'Booked'),
                          ),
                          SsOption(
                            value: 'lost',
                            label: text(context, 'Abhanden', 'Missing'),
                          ),
                          SsOption(
                            value: 'broken',
                            label: text(context, 'Defekt', 'Broken'),
                          ),
                        ],
                        onChanged: widget.enabled
                            ? (value) {
                                setState(() {
                                  _status = value;
                                });
                              }
                            : null,
                      ),
                      const SizedBox(height: 16),
                      _selection(
                        label: text(context, 'Marke', 'Brand'),
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
                    child: Text(text(context, 'Filter anwenden', 'Apply filters')),
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
