import 'dart:convert';

import '../../api/generated/models.g.dart' as models;
import '../../api/model.dart';

enum ToolDraftIssue {
  required,
  positiveInteger,
  nonnegativeNumber,
  tooLong,
  invalidText,
  invalidContext,
}

final class ToolDraft {
  const ToolDraft({
    this.toolId,
    this.customId = '',
    this.brand = '',
    this.category = '',
    this.label = '',
    this.purchasePrice = '',
    this.usageCostPerDay = '',
    this.status,
  });

  factory ToolDraft.fromTool(models.Tool tool) {
    return ToolDraft(
      toolId: tool.id,
      customId: _numberText(tool.customId),
      brand: tool.brand,
      category: tool.category,
      label: tool.label ?? '',
      purchasePrice: tool.purchasePrice == null
          ? ''
          : _numberText(tool.purchasePrice!),
      usageCostPerDay: tool.usageCostPerDay == null
          ? ''
          : _numberText(tool.usageCostPerDay!),
      status: tool.status,
    );
  }

  final String? toolId;
  final String customId;
  final String brand;
  final String category;
  final String label;
  final String purchasePrice;
  final String usageCostPerDay;
  final models.ToolStatus? status;

  bool get isEditing {
    return toolId != null;
  }

  Map<String, ToolDraftIssue> validate() {
    final issues = <String, ToolDraftIssue>{};

    if (isEditing) {
      if (toolId!.isEmpty) {
        issues['id'] = ToolDraftIssue.required;
      }
    } else {
      final value = _trimFormInput(customId);
      final number = int.tryParse(value);

      if (value.isEmpty) {
        issues['customId'] = ToolDraftIssue.required;
      } else if (!RegExp(r'^[0-9]+$').hasMatch(value) ||
          number == null ||
          number <= 0 ||
          number > 2147483647) {
        issues['customId'] = ToolDraftIssue.positiveInteger;
      }

      if (status != null) {
        issues['status'] = ToolDraftIssue.invalidContext;
      }
    }

    for (final (field, value, maximum, required) in [
      ('brand', brand, 127, true),
      ('category', category, 127, true),
      ('label', label, 255, false),
    ]) {
      final normalized = normalizeToolText(value);

      if (required && (_trimFormInput(value).isEmpty || normalized.isEmpty)) {
        issues[field] = ToolDraftIssue.required;
      } else if (!_isScalarString(normalized)) {
        issues[field] = ToolDraftIssue.invalidText;
      } else if (utf8.encode(normalized).length > maximum) {
        issues[field] = ToolDraftIssue.tooLong;
      }
    }

    for (final entry in {
      'purchasePrice': purchasePrice,
      'usageCostPerDay': usageCostPerDay,
    }.entries) {
      final value = _trimFormInput(entry.value);

      if (value.isNotEmpty && _cost(value) == null) {
        issues[entry.key] = ToolDraftIssue.nonnegativeNumber;
      }
    }

    return Map.unmodifiable(issues);
  }

  void _requireValid() {
    if (validate().isNotEmpty) {
      throw const FormatException('INVALID_TOOL_DRAFT');
    }
  }

  models.ToolsCreateInput createInput() {
    if (isEditing) {
      throw StateError('EDIT_TOOL_DRAFT_CANNOT_CREATE');
    }

    _requireValid();

    return models.ToolsCreateInput(
      customId: int.parse(_trimFormInput(customId)),
      brand: normalizeToolText(brand),
      category: normalizeToolText(category),
      label: RpcOptional.value(_nullable(label)),
      purchasePrice: RpcOptional.value(_cost(purchasePrice)),
      usageCostPerDay: RpcOptional.value(_cost(usageCostPerDay)),
    );
  }

  models.ToolsUpdateInput updateInput() {
    if (!isEditing) {
      throw StateError('CREATE_TOOL_DRAFT_CANNOT_UPDATE');
    }

    _requireValid();

    return models.ToolsUpdateInput(
      id: toolId!,
      data: models.ToolsUpdateRequestData(
        brand: RpcOptional.value(normalizeToolText(brand)),
        category: RpcOptional.value(normalizeToolText(category)),
        label: RpcOptional.value(_nullable(label)),
        purchasePrice: RpcOptional.value(_cost(purchasePrice)),
        usageCostPerDay: RpcOptional.value(_cost(usageCostPerDay)),
        status: RpcOptional.value(status),
      ),
    );
  }
}

String normalizeToolText(String value) {
  return _trim(value, _isRustWhitespace);
}

String _trimFormInput(String value) {
  return _trim(value, (codeUnit) {
    // ECMAScript trim includes BOM and excludes NEL; Rust does the reverse.
    return codeUnit == 0xfeff ||
        (codeUnit != 0x0085 && _isRustWhitespace(codeUnit));
  });
}

String _trim(String value, bool Function(int codeUnit) isWhitespace) {
  var start = 0;
  var end = value.length;

  while (start < end && isWhitespace(value.codeUnitAt(start))) {
    start++;
  }

  while (end > start && isWhitespace(value.codeUnitAt(end - 1))) {
    end--;
  }

  return value.substring(start, end);
}

bool _isRustWhitespace(int codeUnit) {
  return (codeUnit >= 0x0009 && codeUnit <= 0x000d) ||
      codeUnit == 0x0020 ||
      codeUnit == 0x0085 ||
      codeUnit == 0x00a0 ||
      codeUnit == 0x1680 ||
      (codeUnit >= 0x2000 && codeUnit <= 0x200a) ||
      codeUnit == 0x2028 ||
      codeUnit == 0x2029 ||
      codeUnit == 0x202f ||
      codeUnit == 0x205f ||
      codeUnit == 0x3000;
}

bool _isScalarString(String value) {
  for (var index = 0; index < value.length; index++) {
    final codeUnit = value.codeUnitAt(index);

    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 == value.length) {
        return false;
      }

      final next = value.codeUnitAt(index + 1);

      if (next < 0xdc00 || next > 0xdfff) {
        return false;
      }

      index++;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }

  return true;
}

String? _nullable(String value) {
  final normalized = normalizeToolText(value);

  return normalized.isEmpty ? null : normalized;
}

double? _cost(String value) {
  final text = _trimFormInput(value);

  if (!RegExp(r'^[0-9]+([,.][0-9]+)?$').hasMatch(text)) {
    return null;
  }

  final number = double.tryParse(text.replaceFirst(',', '.'));

  if (number == null || !number.isFinite || number < 0) {
    return null;
  }

  return number;
}

String _numberText(num value) {
  if (value == 0) {
    return '0';
  }

  final text = value.toString();
  final exponent = RegExp(r'[eE]').firstMatch(text);

  if (exponent == null) {
    return text.endsWith('.0') ? text.substring(0, text.length - 2) : text;
  }

  // Expand stored doubles for decimal-only form rules without rounding them.
  final negative = text.startsWith('-');
  final mantissa = text.substring(negative ? 1 : 0, exponent.start);
  final dot = mantissa.indexOf('.');
  final digits = mantissa.replaceFirst('.', '');
  final position =
      (dot < 0 ? mantissa.length : dot) +
      int.parse(text.substring(exponent.end));
  final String expanded;

  if (position <= 0) {
    expanded = '0.${''.padLeft(-position, '0')}$digits';
  } else if (position >= digits.length) {
    expanded = '$digits${''.padLeft(position - digits.length, '0')}';
  } else {
    expanded = '${digits.substring(0, position)}.${digits.substring(position)}';
  }

  return negative ? '-$expanded' : expanded;
}
