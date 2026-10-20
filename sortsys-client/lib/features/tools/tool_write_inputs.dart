import 'dart:convert';

import '../../api/generated/models.g.dart' as models;
import '../../api/model.dart';
import 'tool_draft.dart' show normalizeToolText;

void checkToolCreateInput(models.ToolsCreateInput input) {
  if (input.customId is! int ||
      input.customId <= 0 ||
      input.customId > 2147483647 ||
      !input.status.isAbsent) {
    throw const FormatException('INVALID_TOOL_CREATE_CONTEXT');
  }

  _checkFields(
    brand: input.brand,
    category: input.category,
    label: input.label,
    purchasePrice: input.purchasePrice,
    usageCostPerDay: input.usageCostPerDay,
  );
}

void checkToolUpdateInput(models.ToolsUpdateInput input) {
  final data = input.data;

  if (input.id.isEmpty ||
      !data.brand.hasValue ||
      !data.category.hasValue ||
      !data.status.hasValue) {
    throw const FormatException('INVALID_TOOL_UPDATE_CONTEXT');
  }

  _checkFields(
    brand: data.brand.value,
    category: data.category.value,
    label: data.label,
    purchasePrice: data.purchasePrice,
    usageCostPerDay: data.usageCostPerDay,
  );
}

models.ToolsCreateInput copyToolCreateInput(models.ToolsCreateInput input) {
  checkToolCreateInput(input);

  return models.ToolsCreateInput(
    customId: input.customId,
    brand: input.brand,
    category: input.category,
    label: RpcOptional.value(input.label.value),
    purchasePrice: RpcOptional.value(input.purchasePrice.value),
    usageCostPerDay: RpcOptional.value(input.usageCostPerDay.value),
  );
}

models.ToolsUpdateInput copyToolUpdateInput(models.ToolsUpdateInput input) {
  checkToolUpdateInput(input);

  final data = input.data;

  return models.ToolsUpdateInput(
    id: input.id,
    data: models.ToolsUpdateRequestData(
      brand: RpcOptional.value(data.brand.value),
      category: RpcOptional.value(data.category.value),
      label: RpcOptional.value(data.label.value),
      purchasePrice: RpcOptional.value(data.purchasePrice.value),
      usageCostPerDay: RpcOptional.value(data.usageCostPerDay.value),
      status: RpcOptional.value(data.status.value),
    ),
  );
}

void _checkFields({
  required String brand,
  required String category,
  required RpcOptional<String?> label,
  required RpcOptional<num?> purchasePrice,
  required RpcOptional<num?> usageCostPerDay,
}) {
  if (!label.hasValue || !purchasePrice.hasValue || !usageCostPerDay.hasValue) {
    throw const FormatException('INVALID_TOOL_WRITE_OPTIONAL');
  }

  _checkText(brand, 127);
  _checkText(category, 127);

  final model = label.value;

  if (model != null) {
    _checkText(model, 255);
  }

  _checkCost(purchasePrice.value);
  _checkCost(usageCostPerDay.value);
}

void _checkText(String value, int maximum) {
  final bytes = utf8.encode(value);

  // Rust-normalized payloads retain BOM even if the raw form also had NEL.
  if (value.isEmpty ||
      value != normalizeToolText(value) ||
      bytes.length > maximum ||
      utf8.decode(bytes) != value) {
    throw const FormatException('INVALID_TOOL_WRITE_TEXT');
  }
}

void _checkCost(num? value) {
  if (value == null) {
    return;
  }

  if (!value.isFinite || value < 0) {
    throw const FormatException('INVALID_TOOL_WRITE_COST');
  }

  // Mixed int/double equality can hide loss; compare exact integer values.
  if (value is int && BigInt.from(value.toDouble()) != BigInt.from(value)) {
    throw const FormatException('INVALID_TOOL_WRITE_COST');
  }
}
