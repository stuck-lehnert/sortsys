import 'package:flutter/widgets.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

import '../../api/generated/models.g.dart' as models;
import '../../ui/text.dart';
import 'product_price_draft.dart';

final class ProductPriceFormValues {
  ProductPriceFormValues(models.Product product, {DateTime? date})
    : _product = models.Product(
        id: product.id,
        customId: product.customId,
        name: product.name,
        baseUnit: product.baseUnit,
        otherUnits: models.ApplyPriceImportRowOtherUnits(
          Map.unmodifiable(product.otherUnits.values),
        ),
        categories: List.unmodifiable(product.categories),
      ),
      unit = product.baseUnit,
      date = _startOfDay(date ?? DateTime.now());

  final models.Product _product;

  final price = TextEditingController();
  final amount = TextEditingController();
  final comment = TextEditingController();

  String unit;
  DateTime? date;
  bool isRealPurchase = false;
  models.ProductVendor? vendor;

  List<String> get units {
    return List.unmodifiable([
      _product.baseUnit,
      ..._product.otherUnits.values.keys,
    ]);
  }

  ProductPriceDraft draft() {
    return ProductPriceDraft(
      product: _product,
      totalPrice: price.text,
      amount: amount.text,
      unit: unit,
      date: date,
      comment: comment.text,
      isRealPurchase: isRealPurchase,
    );
  }

  void dispose() {
    price.dispose();
    amount.dispose();
    comment.dispose();
  }
}

DateTime _startOfDay(DateTime date) {
  final local = date.toLocal();

  return DateTime(local.year, local.month, local.day);
}

class ProductPriceFormFields extends StatefulWidget {
  const ProductPriceFormFields({
    super.key,
    required this.values,
    required this.queryIdentity,
    required this.loadVendors,
    this.enabled = true,
  });

  final ProductPriceFormValues values;
  final Object queryIdentity;
  final Future<List<models.ProductVendor>> Function(String query) loadVendors;
  final bool enabled;

  @override
  State<ProductPriceFormFields> createState() {
    return _ProductPriceFormFieldsState();
  }
}

class _ProductPriceFormFieldsState extends State<ProductPriceFormFields> {
  ProductPriceFormValues get values {
    return widget.values;
  }

  String? _error(String field) {
    final issue = values.draft().validate()[field];

    return switch (issue) {
      null => null,
      ProductPriceDraftIssue.required || ProductPriceDraftIssue.unit => text(
        context,
        'Pflichtfeld',
        'Required field',
      ),
      ProductPriceDraftIssue.number || ProductPriceDraftIssue.finitePrice =>
        text(context, 'Eingabe muss eine Zahl sein', 'Enter a number'),
      ProductPriceDraftIssue.nonnegativeNumber => text(
        context,
        'Eingabe muss eine Zahl >= 0 sein',
        'Enter a number greater than or equal to 0',
      ),
      ProductPriceDraftIssue.tooLong => text(
        context,
        'Höchstens 255 UTF-8-Bytes.',
        'Maximum 255 UTF-8 bytes.',
      ),
    };
  }

  Widget _input(
    String field,
    String german,
    String english,
    TextEditingController controller, {
    bool numeric = false,
  }) {
    return SsTextField(
      key: ObjectKey(controller),
      label: text(context, german, english),
      controller: controller,
      kind: numeric ? SsTextFieldKind.decimal : SsTextFieldKind.text,
      enabled: widget.enabled,
      validator: (value) {
        return _error(field);
      },
    );
  }

  Widget _unit() {
    return FormField<String>(
      key: ValueKey((values, 'unit')),
      initialValue: values.unit,
      enabled: widget.enabled,
      validator: (unit) {
        return _error('unit');
      },
      builder: (field) {
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            SsSelectField<String>(
              key: ValueKey((values, values.unit)),
              label: text(context, 'Einheit', 'Unit'),
              value: values.unit,
              options: [
                for (final unit in values.units)
                  SsOption(value: unit, label: unit),
              ],
              onChanged: !widget.enabled
                  ? null
                  : (unit) {
                      field.didChange(unit);
                      setState(() {
                        values.unit = unit;
                      });
                    },
            ),
            if (field.errorText != null)
              Text(
                field.errorText!,
                style: SsTheme.of(context).label
                    .copyWith(color: SsTheme.of(context).danger),
              ),
          ],
        );
      },
    );
  }

  Widget _quantity() {
    return LayoutBuilder(
      builder: (context, constraints) {
        final amount = _input(
          'amount',
          'Menge',
          'Quantity',
          values.amount,
          numeric: true,
        );
        final unit = _unit();
        final scale = MediaQuery.textScalerOf(context).scale(14) / 14;

        if (constraints.maxWidth < 400 || scale > 1.4) {
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [amount, const SizedBox(height: 8), unit],
          );
        }

        return Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(child: amount),
            const SizedBox(width: 8),
            Expanded(child: unit),
          ],
        );
      },
    );
  }

  Widget _vendor() {
    final vendor = values.vendor;

    if (vendor != null) {
      return SsFieldLabel(
        label: text(context, 'Händler', 'Vendors'),
        child: SsSurface(
          child: Row(
            children: [
              Expanded(child: Text(vendor.name)),
              SsButton(
                key: const ValueKey('product-price-vendor-clear'),
                kind: SsButtonKind.ghost,
                onPressed: !widget.enabled
                    ? null
                    : () {
                        setState(() {
                          values.vendor = null;
                        });
                      },
                child: Text(text(context, 'Entfernen', 'Remove')),
              ),
            ],
          ),
        ),
      );
    }

    return SsAutocompleteField<models.ProductVendor>(
      label: text(context, 'Händler', 'Vendors'),
      queryIdentity: (widget.queryIdentity, values),
      enabled: widget.enabled,
      clearOnSelect: true,
      loadOptions: (query) {
        return widget.loadVendors(query.trim().toLowerCase());
      },
      displayString: (vendor) {
        return vendor.name;
      },
      onChanged: (vendor) {
        if (vendor == null) {
          return;
        }

        setState(() {
          values.vendor = vendor;
        });
      },
      loadingText: text(context, 'Wird geladen …', 'Loading …'),
      emptyText: text(
        context,
        'Keine Einträge vorhanden.',
        'No entries available.',
      ),
      failureText: text(
        context,
        'Einträge konnten nicht geladen werden.',
        'Entries could not be loaded.',
      ),
      selectionRequiredText: text(context, 'Pflichtfeld', 'Required field'),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _input(
          'price',
          'Gesamtpreis (EUR)',
          'Total price (EUR)',
          values.price,
          numeric: true,
        ),
        const SizedBox(height: 12),
        _quantity(),
        const SizedBox(height: 12),
        _vendor(),
        const SizedBox(height: 12),
        _input('comment', 'Kommentar', 'Comment', values.comment),
        const SizedBox(height: 12),
        SsDateField(
          key: ObjectKey(values),
          label: text(context, 'Datum', 'Date'),
          clearLabel: text(context, 'Leeren', 'Clear'),
          initialValue: values.date,
          enabled: widget.enabled,
          onChanged: (date) {
            values.date = date;
          },
          validator: (date) {
            return _error('date');
          },
        ),
        const SizedBox(height: 12),
        SsCheckbox(
          label: text(context, 'Echter Einkauf?', 'Actual purchase?'),
          value: values.isRealPurchase,
          onChanged: !widget.enabled
              ? null
              : (value) {
                  setState(() {
                    values.isRealPurchase = value;
                  });
                },
        ),
      ],
    );
  }
}
