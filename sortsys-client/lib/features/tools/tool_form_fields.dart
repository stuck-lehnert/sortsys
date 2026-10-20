import 'package:flutter/widgets.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

import '../../api/generated/models.g.dart' as models;
import '../../ui/text.dart';
import 'tool_draft.dart';
import 'tool_form_reads.dart';
import 'tool_suggestions.dart';

final class ToolFormValues {
  factory ToolFormValues(ToolDraft seed) {
    final id = seed.toolId;

    if ((id != null && (id.isEmpty || !isToolScalarText(id))) ||
        (id == null && seed.status != null)) {
      throw const FormatException('INVALID_TOOL_FORM_CONTEXT');
    }

    return ToolFormValues._(seed);
  }

  ToolFormValues._(ToolDraft seed)
    : toolId = seed.toolId,
      customId = TextEditingController(text: seed.customId),
      brand = TextEditingController(text: seed.brand),
      category = TextEditingController(text: seed.category),
      label = TextEditingController(text: seed.label),
      purchasePrice = TextEditingController(text: seed.purchasePrice),
      usageCostPerDay = TextEditingController(text: seed.usageCostPerDay),
      status = seed.status;

  final String? toolId;
  final TextEditingController customId;
  final TextEditingController brand;
  final TextEditingController category;
  final TextEditingController label;
  final TextEditingController purchasePrice;
  final TextEditingController usageCostPerDay;
  models.ToolStatus? status;

  bool get isEditing {
    return toolId != null;
  }

  ToolDraft draft() {
    return ToolDraft(
      toolId: toolId,
      customId: customId.text,
      brand: brand.text,
      category: category.text,
      label: label.text,
      purchasePrice: purchasePrice.text,
      usageCostPerDay: usageCostPerDay.text,
      status: status,
    );
  }

  void dispose() {
    customId.dispose();
    brand.dispose();
    category.dispose();
    label.dispose();
    purchasePrice.dispose();
    usageCostPerDay.dispose();
  }
}

class ToolFormFields extends StatefulWidget {
  const ToolFormFields({
    super.key,
    required this.values,
    required this.queryIdentity,
    this.reads,
    this.enabled = true,
    this.isCurrent,
    this.onChanged,
  });

  final ToolFormValues values;
  final Object queryIdentity;
  final ToolFormReads? reads;
  final bool enabled;
  final bool Function()? isCurrent;
  final VoidCallback? onChanged;

  @override
  State<ToolFormFields> createState() {
    return _ToolFormFieldsState();
  }
}

class _ToolFormFieldsState extends State<ToolFormFields> {
  int _epoch = 0;
  int _numberRevision = 0;
  bool _suggesting = false;
  bool _numberFailed = false;

  @override
  void initState() {
    super.initState();
    widget.values.customId.addListener(_numberEdited);
  }

  @override
  void didUpdateWidget(covariant ToolFormFields oldWidget) {
    super.didUpdateWidget(oldWidget);

    if (oldWidget.values != widget.values) {
      oldWidget.values.customId.removeListener(_numberEdited);
      widget.values.customId.addListener(_numberEdited);
    }

    if (oldWidget.values != widget.values ||
        oldWidget.queryIdentity != widget.queryIdentity ||
        oldWidget.reads != widget.reads ||
        oldWidget.enabled != widget.enabled) {
      _epoch++;
      _suggesting = false;
      _numberFailed = false;
    }
  }

  @override
  void dispose() {
    _epoch++;
    widget.values.customId.removeListener(_numberEdited);
    super.dispose();
  }

  void _numberEdited() {
    // Reverting an edit must not revive an older number suggestion.
    _numberRevision++;
  }

  bool get _current {
    if (!mounted || !widget.enabled || !(widget.isCurrent?.call() ?? true)) {
      return false;
    }

    final reads = widget.reads;

    if (reads == null) {
      return true;
    }

    if (reads.access.toolId != widget.values.toolId) {
      return false;
    }

    try {
      reads.access.checkCurrent();

      return reads.access.can('manage:tools');
    } on StateError {
      return false;
    }
  }

  bool _owns(int epoch, ToolFormValues values) {
    return epoch == _epoch && identical(values, widget.values) && _current;
  }

  void _changed(int epoch, ToolFormValues values) {
    if (!_owns(epoch, values)) {
      return;
    }

    widget.onChanged?.call();
  }

  void _numberChanged(int epoch, ToolFormValues values) {
    if (!_owns(epoch, values)) {
      return;
    }

    if (_numberFailed) {
      setState(() {
        _numberFailed = false;
      });
    }

    _changed(epoch, values);
  }

  Future<void> _suggestNumber(int epoch, ToolFormValues values) async {
    final reads = widget.reads;

    if (!_owns(epoch, values) ||
        _suggesting ||
        values.isEditing ||
        reads == null) {
      return;
    }

    final initialValue = values.customId.value;
    final initialRevision = _numberRevision;
    int? number;

    setState(() {
      _suggesting = true;
      _numberFailed = false;
    });

    try {
      number = await reads.suggestNumber();
    } on Object {
      if (_owns(epoch, values)) {
        setState(() {
          _numberFailed = true;
        });
      }

      return;
    } finally {
      if (mounted && epoch == _epoch) {
        setState(() {
          _suggesting = false;
        });
      }
    }

    // A late suggestion must not overwrite manual edits or a replacement owner.
    if (!_owns(epoch, values) ||
        !identical(reads, widget.reads) ||
        _numberRevision != initialRevision ||
        values.customId.value != initialValue ||
        number == null) {
      return;
    }

    final value = number.toString();
    values.customId.value = TextEditingValue(
      text: value,
      selection: TextSelection.collapsed(offset: value.length),
    );

    _changed(epoch, values);
  }

  Future<List<String>> _loadSuggestions(
    int epoch,
    ToolFormValues values, {
    required bool brands,
  }) {
    if (!_owns(epoch, values)) {
      return Future.value(const []);
    }

    final reads = widget.reads;

    if (reads == null) {
      return Future.value(const []);
    }

    return brands ? reads.brands() : reads.categories();
  }

  String? _validate(String field, int epoch, ToolFormValues values) {
    if (!_owns(epoch, values)) {
      return null;
    }

    final issue = values.draft().validate()[field];

    return switch (issue) {
      null => null,
      ToolDraftIssue.required => text(context, 'Pflichtfeld', 'Required field'),
      ToolDraftIssue.positiveInteger => text(
        context,
        'Geben Sie eine ganze Zahl von 1 bis 2147483647 ein.',
        'Enter a whole number from 1 to 2147483647.',
      ),
      ToolDraftIssue.nonnegativeNumber => text(
        context,
        'Geben Sie 0 oder eine positive Zahl ein '
            '(Dezimalstellen mit Komma oder Punkt).',
        'Enter zero or a positive number (comma or point for decimals).',
      ),
      ToolDraftIssue.tooLong => text(
        context,
        'Verwenden Sie höchstens ${field == 'label' ? 255 : 127} UTF-8-Bytes.',
        'Use at most ${field == 'label' ? 255 : 127} UTF-8 bytes.',
      ),
      ToolDraftIssue.invalidText => text(
        context,
        'Bitte prüfen Sie die eingegebenen Zeichen.',
        'Please check the entered characters.',
      ),
      ToolDraftIssue.invalidContext => text(
        context,
        'Bitte öffnen Sie das Formular erneut.',
        'Please reopen the form.',
      ),
    };
  }

  Widget _divider() {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 20),
      child: Container(height: 1, color: SsTheme.of(context).border),
    );
  }

  @override
  Widget build(BuildContext context) {
    final values = widget.values;
    final epoch = _epoch;
    final enabled = _current;
    final queryIdentity = (epoch, widget.queryIdentity, values.toolId);
    final numberLabel = text(
      context,
      'Nummer automatisch vorschlagen',
      'Suggest a number automatically',
    );

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        if (values.isEditing)
          SsSelectField<String>(
            label: text(context, 'Status', 'Status'),
            value: values.status?.name ?? 'none',
            options: [
              SsOption(
                value: 'none',
                label: text(context, 'Kein Status', 'No status'),
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
            onChanged: !enabled
                ? null
                : (status) {
                    if (!_owns(epoch, values) ||
                        !const {'none', 'lost', 'broken'}.contains(status)) {
                      return;
                    }

                    setState(() {
                      values.status = switch (status) {
                        'lost' => models.ToolStatus.lost,
                        'broken' => models.ToolStatus.broken,
                        _ => null,
                      };
                    });

                    _changed(epoch, values);
                  },
          )
        else
          SsTextField(
            label: text(context, 'Nummer', 'Number'),
            controller: values.customId,
            kind: SsTextFieldKind.integer,
            enabled: enabled,
            helper: text(
              context,
              'Interne Werkzeugnummer für Suche, Listen und Zuordnung.',
              'Internal tool number used for search, lists, and assignments.',
            ),
            error: !_numberFailed
                ? null
                : text(
                    context,
                    'Es konnte keine Nummer vorgeschlagen werden.',
                    'A number could not be suggested.',
                  ),
            suffix: Padding(
              padding: const EdgeInsetsDirectional.only(end: 8),
              child: SsIconButton(
                icon: 'magic',
                iconSize: 16,
                borderless: true,
                label: numberLabel,
                tooltip: numberLabel,
                onPressed: !enabled || _suggesting || widget.reads == null
                    ? null
                    : () {
                        _suggestNumber(epoch, values);
                      },
              ),
            ),
            validator: (_) {
              return _validate('customId', epoch, values);
            },
            onChanged: (_) {
              _numberChanged(epoch, values);
            },
          ),
        _divider(),
        SsSuggestionField(
          label: text(context, 'Marke', 'Brand'),
          controller: values.brand,
          queryIdentity: queryIdentity,
          loadSuggestions: () {
            return _loadSuggestions(epoch, values, brands: true);
          },
          matchSuggestions: matchToolSuggestions,
          isCurrent: () {
            return _owns(epoch, values);
          },
          enabled: enabled,
          validator: (_) {
            return _validate('brand', epoch, values);
          },
          onChanged: (_) {
            _changed(epoch, values);
          },
        ),
        const SizedBox(height: 12),
        SsSuggestionField(
          label: text(context, 'Kategorie', 'Category'),
          controller: values.category,
          queryIdentity: queryIdentity,
          loadSuggestions: () {
            return _loadSuggestions(epoch, values, brands: false);
          },
          matchSuggestions: matchToolSuggestions,
          isCurrent: () {
            return _owns(epoch, values);
          },
          enabled: enabled,
          validator: (_) {
            return _validate('category', epoch, values);
          },
          onChanged: (_) {
            _changed(epoch, values);
          },
        ),
        const SizedBox(height: 12),
        SsTextField(
          label: text(context, 'Modell', 'Model'),
          controller: values.label,
          enabled: enabled,
          helper: text(
            context,
            'Modellbezeichnung oder ergänzende Typangabe.',
            'Model name or additional type information.',
          ),
          validator: (_) {
            return _validate('label', epoch, values);
          },
          onChanged: (_) {
            _changed(epoch, values);
          },
        ),
        _divider(),
        SsTextField(
          label: text(context, 'Kaufpreis (EUR)', 'Purchase price (EUR)'),
          controller: values.purchasePrice,
          kind: SsTextFieldKind.decimal,
          enabled: enabled,
          validator: (_) {
            return _validate('purchasePrice', epoch, values);
          },
          onChanged: (_) {
            _changed(epoch, values);
          },
        ),
        const SizedBox(height: 12),
        SsTextField(
          label: text(
            context,
            'Nutzungskosten pro Tag (EUR)',
            'Usage cost per day (EUR)',
          ),
          controller: values.usageCostPerDay,
          kind: SsTextFieldKind.decimal,
          enabled: enabled,
          helper: text(
            context,
            'Tagessatz für interne Kostenberechnungen und Berichte.',
            'Daily rate used for internal cost calculations and reports.',
          ),
          validator: (_) {
            return _validate('usageCostPerDay', epoch, values);
          },
          onChanged: (_) {
            _changed(epoch, values);
          },
        ),
      ],
    );
  }
}
