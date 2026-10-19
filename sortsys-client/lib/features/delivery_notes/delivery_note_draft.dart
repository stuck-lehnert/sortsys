import 'dart:convert';

import '../../api/generated/models.g.dart' as models;
import '../../api/model.dart';

final class DeliveryProductSelection {
  DeliveryProductSelection(models.Product product)
    : id = product.id,
      baseUnit = product.baseUnit,
      otherUnits = Map.unmodifiable(product.otherUnits.values);

  final String id;
  final String baseUnit;
  final Map<String, num> otherUnits;
}

final class DeliveryProductLineDraft {
  const DeliveryProductLineDraft({
    required this.product,
    required this.amount,
    required this.unit,
    this.comment = '',
  });

  final DeliveryProductSelection? product;
  final String amount;
  final String unit;
  final String comment;
}

final class DeliverySpecialLineDraft {
  const DeliverySpecialLineDraft({
    required this.name,
    required this.amount,
    required this.unit,
    this.pricePerUnit = '',
    this.comment = '',
  });

  final String name;
  final String amount;
  final String unit;
  final String pricePerUnit;
  final String comment;
}

final class DeliveryNoteDraft {
  DeliveryNoteDraft({
    required this.projectId,
    required List<DeliveryProductLineDraft> records,
    required List<DeliverySpecialLineDraft> specialRecords,
    this.noteId,
    this.deliveryDate,
    this.comment = '',
  }) : records = List.unmodifiable(records),
       specialRecords = List.unmodifiable(specialRecords);

  final String? noteId;
  final String projectId;
  final DateTime? deliveryDate;
  final String comment;
  final List<DeliveryProductLineDraft> records;
  final List<DeliverySpecialLineDraft> specialRecords;

  bool get editing {
    return noteId != null;
  }

  Map<String, String> validate() {
    final issues = <String, String>{};

    if (projectId.isEmpty) {
      issues['project'] = 'required';
    }

    if (editing && noteId!.isEmpty) {
      issues['id'] = 'required';
    }

    if (!editing && deliveryDate == null) {
      issues['deliveryDate'] = 'required';
    }

    if (!_within(comment, 511)) {
      issues['comment'] = 'utf8';
    }

    if (records.isEmpty && specialRecords.isEmpty) {
      issues['records'] = 'required';
    }

    for (var index = 0; index < records.length; index++) {
      final line = records[index];
      final product = line.product;
      final amount = _number(line.amount);
      final prefix = 'record:$index';

      if (product == null || product.id.isEmpty) {
        issues['$prefix:product'] = 'required';
      }

      if (amount == null || amount == 0) {
        issues['$prefix:amount'] = 'nonzero-number';
      }

      final factor = _factor(line);

      if (factor == null || !factor.isFinite || !_within(line.unit, 32)) {
        issues['$prefix:unit'] = 'unit';
      } else if (amount != null && !(amount * factor).isFinite) {
        issues['$prefix:amount'] = 'finite-number';
      }

      if (!editing && !_within(line.comment, 255)) {
        issues['$prefix:comment'] = 'utf8';
      }
    }

    for (var index = 0; index < specialRecords.length; index++) {
      final line = specialRecords[index];
      final prefix = 'specialRecord:$index';
      final amount = _number(line.amount);

      if (line.name.trim().isEmpty || !_within(line.name, 255)) {
        issues['$prefix:name'] = 'name';
      }

      if (line.unit.trim().isEmpty || !_within(line.unit, 32)) {
        issues['$prefix:unit'] = 'unit';
      }

      if (amount == null || amount == 0) {
        issues['$prefix:amount'] = 'nonzero-number';
      }

      if (line.pricePerUnit.trim().isNotEmpty &&
          _number(line.pricePerUnit) == null) {
        issues['$prefix:pricePerUnit'] = 'number';
      }

      if (!editing && !_within(line.comment, 255)) {
        issues['$prefix:comment'] = 'utf8';
      }
    }

    return Map.unmodifiable(issues);
  }

  void _check() {
    if (validate().isNotEmpty) {
      throw StateError('INVALID_DELIVERY_NOTE_DRAFT');
    }
  }

  List<models.DeliveryNotesCreateRequestRecordsItem> _productInputs() {
    return List.unmodifiable([
      for (final line in records)
        models.DeliveryNotesCreateRequestRecordsItem(
          productId: line.product!.id,
          quantity: _number(line.amount)! * _factor(line)!,
          unit: RpcOptional.value(line.unit),
          comment: editing
              ? const RpcOptional.absent()
              : RpcOptional.value(_nullable(line.comment)),
        ),
    ]);
  }

  List<models.DeliveryNotesCreateRequestSpecialRecordsItem> _specialInputs() {
    return List.unmodifiable([
      for (final line in specialRecords)
        models.DeliveryNotesCreateRequestSpecialRecordsItem(
          name: line.name,
          unit: line.unit,
          amount: _number(line.amount)!,
          pricePerUnit: line.pricePerUnit.trim().isEmpty
              ? null
              : _number(line.pricePerUnit),
          comment: editing
              ? const RpcOptional.absent()
              : RpcOptional.value(_nullable(line.comment)),
        ),
    ]);
  }

  models.DeliveryNotesCreateInput createInput() {
    if (editing) {
      throw StateError('DELIVERY_NOTE_DRAFT_IS_EDITING');
    }

    _check();

    return models.DeliveryNotesCreateInput(
      projectId: projectId,
      effectiveTimestamp: RpcOptional.value(deliveryDate),
      comment: RpcOptional.value(_nullable(comment)),
      records: RpcOptional.value(_productInputs()),
      specialRecords: RpcOptional.value(_specialInputs()),
    );
  }

  models.DeliveryNotesUpdateInput updateInput() {
    if (!editing) {
      throw StateError('DELIVERY_NOTE_DRAFT_IS_CREATING');
    }

    _check();

    // The canonical edit form omits the date and per-line comments.
    return models.DeliveryNotesUpdateInput(
      id: noteId!,
      data: models.DeliveryNotesUpdateRequestData(
        projectId: RpcOptional.value(projectId),
        comment: RpcOptional.value(comment),
        records: RpcOptional.value(_productInputs()),
        specialRecords: RpcOptional.value(_specialInputs()),
      ),
    );
  }
}

num? _factor(DeliveryProductLineDraft line) {
  final product = line.product;

  if (product == null) {
    return null;
  }

  return line.unit == product.baseUnit ? 1 : product.otherUnits[line.unit];
}

num? _number(String source) {
  final value = source.trim();

  if (!RegExp(r'^-?[0-9]+([,.][0-9]+)?$').hasMatch(value)) {
    return null;
  }

  final parsed = double.tryParse(value.replaceFirst(',', '.'));

  return parsed != null && parsed.isFinite ? parsed : null;
}

String? _nullable(String source) {
  final value = source.trim();

  return value.isEmpty ? null : value;
}

bool _within(String source, int bytes) {
  return utf8.encode(source.trim()).length <= bytes;
}
