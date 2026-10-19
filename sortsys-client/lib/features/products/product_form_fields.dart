import 'package:flutter/widgets.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

import '../../ui/text.dart';
import 'product_draft.dart';

final class ProductUnitValues {
  ProductUnitValues(ProductUnitDraft unit)
    : name = TextEditingController(text: unit.name),
      amount = TextEditingController(text: unit.amount);

  final TextEditingController name;
  final TextEditingController amount;
  final FocusNode nameFocus = FocusNode();

  void dispose() {
    name.dispose();
    amount.dispose();
    nameFocus.dispose();
  }
}

final class ProductFormValues {
  ProductFormValues(ProductDraft seed)
    : productId = seed.productId,
      customId = TextEditingController(text: seed.customId),
      name = TextEditingController(text: seed.name),
      brand = TextEditingController(text: seed.brand),
      description = TextEditingController(text: seed.description),
      regieReportName = TextEditingController(text: seed.regieReportName),
      baseUnit = TextEditingController(text: seed.baseUnit),
      units = [for (final unit in seed.units) ProductUnitValues(unit)];

  final String? productId;
  final TextEditingController customId;
  final TextEditingController name;
  final TextEditingController brand;
  final TextEditingController description;
  final TextEditingController regieReportName;
  final TextEditingController baseUnit;
  final List<ProductUnitValues> units;
  final List<ProductUnitValues> _removed = [];

  ProductDraft draft() {
    return ProductDraft(
      productId: productId,
      customId: customId.text,
      name: name.text,
      brand: brand.text,
      description: description.text,
      regieReportName: regieReportName.text,
      baseUnit: baseUnit.text,
      units: [
        for (final unit in units)
          ProductUnitDraft(name: unit.name.text, amount: unit.amount.text),
      ],
    );
  }

  void removeUnit(ProductUnitValues unit) {
    if (!units.remove(unit)) {
      return;
    }

    // Removed fields retain their controllers until they have unmounted.
    _removed.add(unit);
  }

  void dispose() {
    customId.dispose();
    name.dispose();
    brand.dispose();
    description.dispose();
    regieReportName.dispose();
    baseUnit.dispose();

    for (final unit in [...units, ..._removed]) {
      unit.dispose();
    }
  }
}

class ProductFormFields extends StatefulWidget {
  const ProductFormFields({
    super.key,
    required this.values,
    this.enabled = true,
    this.queryIdentity,
    this.loadUnits,
  });

  final ProductFormValues values;
  final bool enabled;
  final Object? queryIdentity;
  final Future<List<String>> Function()? loadUnits;

  @override
  State<ProductFormFields> createState() {
    return _ProductFormFieldsState();
  }
}

class _ProductFormFieldsState extends State<ProductFormFields> {
  String? _validate(String field) {
    final values = widget.values;
    final issue = values.draft().validate()[field];

    if (issue == null) {
      return null;
    }

    if (issue == ProductDraftIssue.tooLong) {
      if (field == 'baseUnit' && values.baseUnit.text.length > 15) {
        return text(context, 'Maximal 15 Zeichen', 'Maximum 15 characters');
      }

      if (field == 'regieReportName' &&
          values.regieReportName.text.length > 255) {
        return text(context, 'Maximal 255 Zeichen', 'Maximum 255 characters');
      }

      final limit = switch (field) {
        'name' || 'regieReportName' => 255,
        'brand' => 127,
        'description' => 511,
        'baseUnit' => values.productId == null ? 8 : 10,
        _ => 0,
      };

      return text(
        context,
        'Höchstens $limit UTF-8-Bytes.',
        'Maximum $limit UTF-8 bytes.',
      );
    }

    return switch (issue) {
      ProductDraftIssue.required => text(
        context,
        'Pflichtfeld',
        'Required field',
      ),
      ProductDraftIssue.nonnegativeInteger => text(
        context,
        'Eingabe muss eine Ganzzahl >= 0 sein',
        'Enter an integer greater than or equal to 0',
      ),
      ProductDraftIssue.nonnegativeNumber => text(
        context,
        'Eingabe muss eine Zahl >= 0 sein',
        'Enter a number greater than or equal to 0',
      ),
      ProductDraftIssue.tooLong => null,
    };
  }

  Widget _input(
    String field,
    String de,
    String en,
    TextEditingController controller, {
    FocusNode? focusNode,
    SsTextFieldKind kind = SsTextFieldKind.text,
  }) {
    return SsTextField(
      label: text(context, de, en),
      controller: controller,
      focusNode: focusNode,
      kind: kind,
      enabled: widget.enabled,
      validator: (value) {
        return _validate(field);
      },
    );
  }

  Widget _unitName(int index, ProductUnitValues unit) {
    final loadUnits = widget.loadUnits;

    if (loadUnits == null) {
      return _input(
        'unit:$index:name',
        'Einheit',
        'Unit',
        unit.name,
        focusNode: unit.nameFocus,
      );
    }

    return SsSuggestionField(
      label: text(context, 'Einheit', 'Unit'),
      controller: unit.name,
      focusNode: unit.nameFocus,
      queryIdentity: (widget.queryIdentity, widget.values),
      loadSuggestions: loadUnits,
      enabled: widget.enabled,
      validator: (value) {
        return _validate('unit:$index:name');
      },
    );
  }

  Widget _divider() {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 20),
      child: Container(height: 1, color: SsTheme.of(context).border),
    );
  }

  Widget _pair(Widget first, Widget second) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final scale = MediaQuery.textScalerOf(context).scale(14) / 14;

        if (constraints.maxWidth < 400 || scale > 1.4) {
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [first, const SizedBox(height: 12), second],
          );
        }

        return Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(child: first),
            const SizedBox(width: 8),
            Expanded(child: second),
          ],
        );
      },
    );
  }

  void _addUnit() {
    final unit = ProductUnitValues(
      const ProductUnitDraft(name: '', amount: ''),
    );

    setState(() {
      widget.values.units.add(unit);
    });

    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && widget.values.units.contains(unit)) {
        unit.nameFocus.requestFocus();
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final values = widget.values;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          values.productId == null
              ? text(
                  context,
                  'Nummer, Bezeichnung und Basiseinheit definieren den Produktstamm für Auswertungen und Lieferscheine.',
                  'Number, name, and base unit define the product record used in reports and delivery notes.',
                )
              : text(
                  context,
                  'Pflege hier Stammdaten und Einheiten für korrekte Mengen- und Kostenberechnungen.',
                  'Maintain master data and units here so quantities and costs are calculated correctly.',
                ),
          style: SsTheme.of(context).body
              .copyWith(color: SsTheme.of(context).secondaryText),
        ),
        if (values.productId == null) ...[
          const SizedBox(height: 12),
          _input(
            'customId',
            'Nummer',
            'Number',
            values.customId,
            kind: SsTextFieldKind.integer,
          ),
          _divider(),
        ],
        _input('name', 'Bezeichung', 'Name', values.name),
        const SizedBox(height: 12),
        _input('brand', 'Hersteller', 'Manufacturer', values.brand),
        const SizedBox(height: 12),
        _input(
          'description',
          'Beschreibung',
          'Description',
          values.description,
        ),
        const SizedBox(height: 12),
        _input(
          'regieReportName',
          'Bezeichnung für Regieberichte',
          'Designation for time-and-material reports',
          values.regieReportName,
        ),
        Text(
          text(
            context,
            'Optional. Ohne Angabe wird im Regiebericht die bisherige Bezeichnung verwendet.',
            'Optional. If empty, time-and-material reports use the existing designation.',
          ),
        ),
        _divider(),
        _input(
          'baseUnit',
          'Basiseinheit (kleinste)',
          'Base unit (smallest)',
          values.baseUnit,
        ),
        Text(
          text(
            context,
            'Beispiel: m, kg oder Stk. Alle weiteren Einheiten werden darauf umgerechnet.',
            'Example: m, kg, or pcs. All other units are converted to this unit.',
          ),
        ),
        _divider(),
        for (final (index, unit) in values.units.indexed)
          Padding(
            key: ObjectKey(unit),
            padding: const EdgeInsets.only(bottom: 12),
            child: _pair(
              _unitName(index, unit),
              Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  _input(
                    'unit:$index:value',
                    'Basismenge',
                    'Base quantity',
                    unit.amount,
                    kind: SsTextFieldKind.decimal,
                  ),
                  SsButton(
                    kind: SsButtonKind.secondary,
                    onPressed: widget.enabled
                        ? () {
                            setState(() {
                              values.removeUnit(unit);
                            });
                          }
                        : null,
                    child: Text(
                      text(context, 'Einheit entfernen', 'Remove unit'),
                    ),
                  ),
                ],
              ),
            ),
          ),
        Align(
          alignment: AlignmentDirectional.centerStart,
          child: SsButton(
            kind: SsButtonKind.secondary,
            onPressed: widget.enabled ? _addUnit : null,
            child: Text(text(context, 'Weitere Einheit', 'Add unit')),
          ),
        ),
      ],
    );
  }
}
