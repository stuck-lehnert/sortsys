import 'package:flutter/widgets.dart';

import '../../api/generated/models.g.dart' as models;
import 'delivery_note_draft.dart';
import 'delivery_note_quantities.dart';

final class DeliveryProductLineValues {
  DeliveryProductLineValues({
    models.Product? product,
    String amount = '',
    this.unit,
    String comment = '',
  }) : amount = TextEditingController(text: amount),
       comment = TextEditingController(text: comment) {
    selectProduct(product);
  }

  models.Product? product;
  String? unit;
  final TextEditingController amount;
  final TextEditingController comment;
  final FocusNode productFocus = FocusNode();

  List<String> get units {
    final selected = product;

    if (selected == null) {
      return const [];
    }

    return [selected.baseUnit, ...selected.otherUnits.values.keys];
  }

  void selectProduct(models.Product? selected) {
    product = selected;
    final options = units;

    // The Webapp keeps valid units and otherwise selects the first option.
    if (unit == null || !options.contains(unit)) {
      unit = options.isEmpty ? null : options.first;
    }
  }

  DeliveryProductLineDraft draft() {
    final selected = product;

    return DeliveryProductLineDraft(
      product: selected == null ? null : DeliveryProductSelection(selected),
      amount: amount.text,
      unit: unit ?? '',
      comment: comment.text,
    );
  }

  void dispose() {
    amount.dispose();
    comment.dispose();
    productFocus.dispose();
  }
}

final class DeliverySpecialLineValues {
  DeliverySpecialLineValues({
    String name = '',
    String amount = '',
    String unit = '',
    String pricePerUnit = '',
    String comment = '',
  }) : name = TextEditingController(text: name),
       amount = TextEditingController(text: amount),
       unit = TextEditingController(text: unit),
       pricePerUnit = TextEditingController(text: pricePerUnit),
       comment = TextEditingController(text: comment);

  final TextEditingController name;
  final TextEditingController amount;
  final TextEditingController unit;
  final TextEditingController pricePerUnit;
  final TextEditingController comment;
  final FocusNode nameFocus = FocusNode();

  DeliverySpecialLineDraft draft() {
    return DeliverySpecialLineDraft(
      name: name.text,
      amount: amount.text,
      unit: unit.text,
      pricePerUnit: pricePerUnit.text,
      comment: comment.text,
    );
  }

  void dispose() {
    name.dispose();
    amount.dispose();
    unit.dispose();
    pricePerUnit.dispose();
    comment.dispose();
    nameFocus.dispose();
  }
}

final class DeliveryNoteFormValues {
  DeliveryNoteFormValues.create({models.Project? project, DateTime? date})
    : this._(
        project: project,
        date: date ?? DateTime.now(),
        records: [DeliveryProductLineValues()],
        specialRecords: [],
      );

  DeliveryNoteFormValues._({
    this.noteId,
    this.project,
    this.date,
    String comment = '',
    required this.records,
    required this.specialRecords,
  }) : comment = TextEditingController(text: comment);

  factory DeliveryNoteFormValues.edit(
    models.DeliveryNote note, {
    models.Project? project,
    Map<String, models.Product> products = const {},
  }) {
    if (note.id.isEmpty ||
        note.records.any((record) {
          return record.noteId != note.id;
        }) ||
        note.specialRecords.any((record) {
          return record.noteId != note.id;
        })) {
      throw const FormatException('DELIVERY_NOTE_FORM_OWNER_MISMATCH');
    }

    final rows = <DeliveryProductLineValues>[];

    for (final record in note.records) {
      final candidate = products[record.productId];
      final product = candidate?.id == record.productId ? candidate : null;
      final quantity = product == null
          ? (amount: record.quantity, unit: '')
          : deliveryQuantityInUnit(product, record.quantity, record.unit);
      rows.add(
        DeliveryProductLineValues(
          product: product,
          amount: '${quantity.amount}',
          unit: product == null ? null : quantity.unit,
        ),
      );
    }

    return DeliveryNoteFormValues._(
      noteId: note.id,
      project: project?.id == note.projectId ? project : null,
      comment: note.comment ?? '',
      records: rows,
      specialRecords: [
        for (final record in note.specialRecords)
          DeliverySpecialLineValues(
            name: record.name,
            amount: '${record.amount}',
            unit: record.unit,
            pricePerUnit: record.pricePerUnit == null
                ? ''
                : '${record.pricePerUnit}',
          ),
      ],
    );
  }

  final String? noteId;
  models.Project? project;
  DateTime? date;
  final TextEditingController comment;
  final List<DeliveryProductLineValues> records;
  final List<DeliverySpecialLineValues> specialRecords;
  final List<DeliveryProductLineValues> _removedProducts = [];
  final List<DeliverySpecialLineValues> _removedSpecials = [];

  DeliveryNoteDraft draft() {
    return DeliveryNoteDraft(
      noteId: noteId,
      projectId: project?.id ?? '',
      deliveryDate: date,
      comment: comment.text,
      records: [for (final record in records) record.draft()],
      specialRecords: [for (final record in specialRecords) record.draft()],
    );
  }

  void removeProduct(DeliveryProductLineValues record) {
    if (!records.remove(record)) {
      return;
    }

    // Retire attached controllers until the enclosing form has unmounted.
    _removedProducts.add(record);
  }

  void removeSpecial(DeliverySpecialLineValues record) {
    if (!specialRecords.remove(record)) {
      return;
    }

    _removedSpecials.add(record);
  }

  void dispose() {
    comment.dispose();

    for (final record in [...records, ..._removedProducts]) {
      record.dispose();
    }

    for (final record in [...specialRecords, ..._removedSpecials]) {
      record.dispose();
    }
  }
}
