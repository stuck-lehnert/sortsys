import 'dart:convert';

import '../../api/generated/models.g.dart' as models;
import '../../api/model.dart';

void checkProductMasterCreateInput(models.ProductsCreateInput input) {
  if (!input.customId.isFinite ||
      input.customId < 0 ||
      input.customId > 2147483647 ||
      input.customId != input.customId.truncateToDouble()) {
    throw const FormatException('INVALID_PRODUCT_MASTER_CREATE_CONTEXT');
  }

  _checkFields(
    name: input.name,
    baseUnit: input.baseUnit,
    baseLimit: 8,
    brand: input.brand,
    description: input.description,
    regieReportName: input.regieReportName,
    units: input.otherUnits,
  );
}

void checkProductMasterUpdateInput(models.ProductsUpdateInput input) {
  final data = input.data;

  if (input.id.isEmpty ||
      !data.customId.isAbsent ||
      !data.name.hasValue ||
      !data.baseUnit.hasValue) {
    throw const FormatException('INVALID_PRODUCT_MASTER_UPDATE_CONTEXT');
  }

  _checkFields(
    name: data.name.value,
    baseUnit: data.baseUnit.value,
    baseLimit: 10,
    brand: data.brand,
    description: data.description,
    regieReportName: data.regieReportName,
    units: data.otherUnits,
  );
}

void _checkFields({
  required String name,
  required String baseUnit,
  required int baseLimit,
  required RpcOptional<String?> brand,
  required RpcOptional<String?> description,
  required RpcOptional<String?> regieReportName,
  required RpcOptional<models.ApplyPriceImportRowOtherUnits> units,
}) {
  _checkText(name, 255);
  _checkText(baseUnit, baseLimit);
  _checkNullable(brand, 127);
  _checkNullable(description, 511);
  _checkNullable(regieReportName, 255);

  if (!units.hasValue) {
    throw const FormatException('INVALID_PRODUCT_MASTER_UNITS');
  }

  for (final entry in units.value.values.entries) {
    if (entry.key.isEmpty ||
        entry.key != entry.key.trim() ||
        !entry.value.isFinite ||
        entry.value < 0) {
      throw const FormatException('INVALID_PRODUCT_MASTER_UNITS');
    }
  }
}

void _checkText(String value, int maxBytes) {
  if (value.isEmpty ||
      value != value.trim() ||
      utf8.encode(value).length > maxBytes) {
    throw const FormatException('INVALID_PRODUCT_MASTER_TEXT');
  }
}

void _checkNullable(RpcOptional<String?> field, int maxBytes) {
  if (!field.hasValue) {
    throw const FormatException('INVALID_PRODUCT_MASTER_OPTIONAL');
  }

  final value = field.valueOrNull;

  if (value != null) {
    _checkText(value, maxBytes);
  }
}
