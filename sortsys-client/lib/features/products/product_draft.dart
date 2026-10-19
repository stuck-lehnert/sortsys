import 'dart:convert';

import '../../api/generated/models.g.dart' as models;
import '../../api/model.dart';

enum ProductDraftIssue {
  required,
  nonnegativeInteger,
  nonnegativeNumber,
  tooLong,
}

final class ProductUnitDraft {
  const ProductUnitDraft({required this.name, required this.amount});

  final String name;
  final String amount;
}

final class ProductDraft {
  ProductDraft({
    this.productId,
    this.customId = '',
    this.name = '',
    this.brand = '',
    this.description = '',
    this.regieReportName = '',
    this.baseUnit = '',
    List<ProductUnitDraft> units = const [],
  }) : units = List.unmodifiable(units);

  factory ProductDraft.fromProduct(models.Product product) {
    return ProductDraft(
      productId: product.id,
      customId: _numberText(product.customId),
      name: product.name,
      brand: product.brand ?? '',
      description: product.description ?? '',
      regieReportName: product.regieReportName ?? '',
      baseUnit: product.baseUnit,
      units: [
        for (final entry in product.otherUnits.values.entries)
          ProductUnitDraft(name: entry.key, amount: _numberText(entry.value)),
      ],
    );
  }

  final String? productId;
  final String customId;
  final String name;
  final String brand;
  final String description;
  final String regieReportName;
  final String baseUnit;
  final List<ProductUnitDraft> units;

  bool get isEditing {
    return productId != null;
  }

  Map<String, ProductDraftIssue> validate() {
    final issues = <String, ProductDraftIssue>{};

    void text(
      String field,
      String value,
      int maxBytes, {
      bool required = false,
    }) {
      final normalized = value.trim();

      if (required && normalized.isEmpty) {
        issues[field] = ProductDraftIssue.required;
      } else if (utf8.encode(normalized).length > maxBytes) {
        issues[field] = ProductDraftIssue.tooLong;
      }
    }

    if (isEditing) {
      if (productId!.isEmpty) {
        issues['id'] = ProductDraftIssue.required;
      }
    } else {
      final value = customId.trim();
      final number = int.tryParse(value);

      if (value.isEmpty) {
        issues['customId'] = ProductDraftIssue.required;
      } else if (!RegExp(r'^[0-9]+$').hasMatch(value) ||
          number == null ||
          number > 2147483647) {
        issues['customId'] = ProductDraftIssue.nonnegativeInteger;
      }
    }

    text('name', name, 255, required: true);
    text('brand', brand, 127);
    text('description', description, 511);
    text('regieReportName', regieReportName, 255);
    text('baseUnit', baseUnit, isEditing ? 10 : 8, required: true);

    if (regieReportName.length > 255) {
      issues['regieReportName'] = ProductDraftIssue.tooLong;
    }

    if (baseUnit.length > 15) {
      issues['baseUnit'] = ProductDraftIssue.tooLong;
    }

    for (final (index, unit) in units.indexed) {
      if (unit.name.trim().isEmpty) {
        issues['unit:$index:name'] = ProductDraftIssue.required;
      }

      final value = unit.amount.trim();
      final amount = double.tryParse(value.replaceFirst(',', '.'));

      if (value.isEmpty) {
        issues['unit:$index:value'] = ProductDraftIssue.required;
      } else if (!RegExp(r'^[0-9]+([,.][0-9]+)?$').hasMatch(value) ||
          amount == null ||
          !amount.isFinite) {
        issues['unit:$index:value'] = ProductDraftIssue.nonnegativeNumber;
      }
    }

    return Map.unmodifiable(issues);
  }

  models.ApplyPriceImportRowOtherUnits _otherUnits() {
    final values = <String, num>{};

    for (final unit in units) {
      values[unit.name.trim()] = double.parse(
        unit.amount.trim().replaceFirst(',', '.'),
      );
    }

    return models.ApplyPriceImportRowOtherUnits(Map.unmodifiable(values));
  }

  void _requireValid() {
    if (validate().isNotEmpty) {
      throw const FormatException('INVALID_PRODUCT_DRAFT');
    }
  }

  models.ProductsCreateInput createInput() {
    if (isEditing) {
      throw StateError('EDIT_PRODUCT_DRAFT_CANNOT_CREATE');
    }

    _requireValid();

    return models.ProductsCreateInput(
      customId: int.parse(customId.trim()),
      name: name.trim(),
      baseUnit: baseUnit.trim(),
      brand: RpcOptional.value(_nullable(brand)),
      description: RpcOptional.value(_nullable(description)),
      regieReportName: RpcOptional.value(_nullable(regieReportName)),
      otherUnits: RpcOptional.value(_otherUnits()),
    );
  }

  models.ProductsUpdateInput updateInput() {
    if (!isEditing) {
      throw StateError('CREATE_PRODUCT_DRAFT_CANNOT_UPDATE');
    }

    _requireValid();

    return models.ProductsUpdateInput(
      id: productId!,
      data: models.ProductsUpdateRequestData(
        name: RpcOptional.value(name.trim()),
        brand: RpcOptional.value(_nullable(brand)),
        description: RpcOptional.value(_nullable(description)),
        regieReportName: RpcOptional.value(_nullable(regieReportName)),
        baseUnit: RpcOptional.value(baseUnit.trim()),
        otherUnits: RpcOptional.value(_otherUnits()),
      ),
    );
  }
}

String? _nullable(String value) {
  final normalized = value.trim();

  return normalized.isEmpty ? null : normalized;
}

String _numberText(num value) {
  if (value.isFinite && value == value.truncateToDouble()) {
    return value.toStringAsFixed(0);
  }

  return value.toString();
}
