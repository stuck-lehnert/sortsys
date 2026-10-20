import 'dart:convert';

import '../../api/contract.dart' show jsonMap;
import '../../api/generated/models.g.dart' as models;
import '../../api/model.dart';
import '../../api/wire.dart';
import 'tool_draft.dart' show isToolScalarText;
import 'tool_write_inputs.dart';

final class ToolWriteReceipt {
  ToolWriteReceipt({
    required this.scope,
    required this.nonce,
    required this.createdAt,
    models.ToolsCreateInput? createInput,
    models.ToolsUpdateInput? updateInput,
    models.Tool? baseline,
    this.dispatching = false,
    this.creation,
    this.updateAcknowledgement,
  }) : createInput = createInput == null
           ? null
           : copyToolCreateInput(createInput),
       updateInput = updateInput == null
           ? null
           : copyToolUpdateInput(updateInput),
       baseline = baseline == null ? null : freezeToolWriteBaseline(baseline) {
    _validate();
  }

  final String scope;
  final String nonce;
  final DateTime createdAt;
  final models.ToolsCreateInput? createInput;
  final models.ToolsUpdateInput? updateInput;
  final models.Tool? baseline;
  final bool dispatching;
  final models.ToolsCreateOutput? creation;
  final models.ToolsUpdateOutput? updateAcknowledgement;

  bool get acknowledged {
    return creation != null || updateAcknowledgement != null;
  }

  ToolWriteReceipt started() {
    if (dispatching || acknowledged) {
      throw StateError('INVALID_TOOL_RECEIPT_STAGE');
    }

    return _copy(dispatching: true);
  }

  ToolWriteReceipt confirmedCreate(models.ToolsCreateOutput result) {
    if (createInput == null || !dispatching || acknowledged) {
      throw StateError('INVALID_TOOL_RECEIPT_STAGE');
    }

    if (result.id.isEmpty || !isToolScalarText(result.id)) {
      throw const FormatException('INVALID_TOOL_CREATE_ACK');
    }

    return _copy(dispatching: false, creation: result);
  }

  ToolWriteReceipt confirmedUpdate(models.ToolsUpdateOutput result) {
    if (updateInput == null || !dispatching || acknowledged) {
      throw StateError('INVALID_TOOL_RECEIPT_STAGE');
    }

    if (!result.success) {
      throw const FormatException('INVALID_TOOL_UPDATE_ACK');
    }

    return _copy(dispatching: false, updateAcknowledgement: result);
  }

  ToolWriteReceipt _copy({
    required bool dispatching,
    models.ToolsCreateOutput? creation,
    models.ToolsUpdateOutput? updateAcknowledgement,
  }) {
    return ToolWriteReceipt(
      scope: scope,
      nonce: nonce,
      createdAt: createdAt,
      createInput: createInput,
      updateInput: updateInput,
      baseline: baseline,
      dispatching: dispatching,
      creation: creation,
      updateAcknowledgement: updateAcknowledgement,
    );
  }

  String encode() {
    _validate();

    final encoded = jsonEncode(
      serializeWire({
        'version': 1,
        'scope': scope,
        'nonce': nonce,
        'createdAt': createdAt,
        'createInput': encodeRpcValue(createInput),
        'updateInput': encodeRpcValue(updateInput),
        'baseline': encodeRpcValue(baseline),
        'dispatching': dispatching,
        'creation': encodeRpcValue(creation),
        'updateAcknowledgement': encodeRpcValue(updateAcknowledgement),
      }),
    );
    _checkSize(encoded);

    return encoded;
  }

  factory ToolWriteReceipt.decode(String encoded) {
    _checkSize(encoded);

    final envelope = jsonMap(jsonDecode(encoded));
    _checkDateEnvelope(envelope);

    final data = readRpcObject(deserializeWire(envelope), _receiptFields);

    if (!_exactKeys(data, _receiptFields)) {
      throw const FormatException('INVALID_TOOL_RECEIPT');
    }

    readRpcLiteral(data['version'], 1);

    return ToolWriteReceipt(
      scope: readRpcString(data['scope']),
      nonce: readRpcString(data['nonce']),
      createdAt: readRpcDate(data['createdAt']),
      createInput: readRpcNullable(
        data['createInput'],
        models.ToolsCreateInput.fromWire,
      ),
      updateInput: readRpcNullable(
        data['updateInput'],
        models.ToolsUpdateInput.fromWire,
      ),
      baseline: readRpcNullable(data['baseline'], models.Tool.fromWire),
      dispatching: readRpcBoolean(data['dispatching']),
      creation: readRpcNullable(
        data['creation'],
        models.ToolsCreateOutput.fromWire,
      ),
      updateAcknowledgement: readRpcNullable(
        data['updateAcknowledgement'],
        models.ToolsUpdateOutput.fromWire,
      ),
    );
  }

  void _validate() {
    if (scope.isEmpty ||
        !isToolScalarText(scope) ||
        !RegExp(r'^[0-9a-f]{32}$').hasMatch(nonce) ||
        createdAt.toUtc().year < 100 ||
        (createInput == null) == (updateInput == null)) {
      throw const FormatException('INVALID_TOOL_RECEIPT');
    }

    if ((dispatching && acknowledged) ||
        (creation != null && updateAcknowledgement != null) ||
        creation?.id.isEmpty == true ||
        (creation != null && !isToolScalarText(creation!.id)) ||
        updateAcknowledgement?.success == false) {
      throw const FormatException('INVALID_TOOL_RECEIPT_STAGE');
    }

    final create = createInput;
    final update = updateInput;
    final original = baseline;

    if (create != null) {
      if (original != null || updateAcknowledgement != null) {
        throw const FormatException('INVALID_TOOL_CREATE_RECEIPT');
      }

      checkToolCreateInput(create);
    } else if (update != null) {
      if (original == null || original.id != update.id || creation != null) {
        throw const FormatException('INVALID_TOOL_UPDATE_RECEIPT');
      }

      checkToolUpdateInput(update);
    }
  }

  bool confirms(models.Tool tool) {
    _validate();

    // The Tool row may match even if the subsequent tracking-cost write failed.
    if (!acknowledged) {
      return false;
    }

    final create = createInput;
    final update = updateInput;

    if (create != null) {
      return creation?.id == tool.id &&
          create.customId == tool.customId &&
          _matchesFields(
            tool,
            brand: create.brand,
            category: create.category,
            label: create.label.value,
            purchasePrice: create.purchasePrice.value,
            usageCostPerDay: create.usageCostPerDay.value,
            status: null,
          );
    }

    return update != null && toolUpdateMatches(update, tool);
  }
}

const _receiptFields = {
  'version',
  'scope',
  'nonce',
  'createdAt',
  'createInput',
  'updateInput',
  'baseline',
  'dispatching',
  'creation',
  'updateAcknowledgement',
};

abstract interface class ToolReceiptStore {
  Future<ToolWriteReceipt?> read(String scope);

  Future<void> write(ToolWriteReceipt receipt);

  Future<void> clear(String scope);
}

models.Tool freezeToolWriteBaseline(models.Tool tool) {
  final data = tool.toWire();

  if (tool.id.isEmpty ||
      tool.createdAt.toUtc().year < 100 ||
      tool.modifiedAt.toUtc().year < 100 ||
      (tool.archivedSince != null && tool.archivedSince!.toUtc().year < 100) ||
      data.values.whereType<String>().any((value) {
        return !isToolScalarText(value);
      })) {
    throw const FormatException('INVALID_TOOL_WRITE_BASELINE');
  }

  return models.Tool.fromWire(data);
}

bool sameToolSnapshot(models.Tool left, models.Tool right) {
  return jsonEncode(serializeWire(left.toWire())) ==
      jsonEncode(serializeWire(right.toWire()));
}

bool toolUpdateMatches(models.ToolsUpdateInput input, models.Tool tool) {
  checkToolUpdateInput(input);

  final data = input.data;

  // Equality alone is neither an ACK nor a no-op: default-cost backfill remains.
  return input.id == tool.id &&
      _matchesFields(
        tool,
        brand: data.brand.value,
        category: data.category.value,
        label: data.label.value,
        purchasePrice: data.purchasePrice.value,
        usageCostPerDay: data.usageCostPerDay.value,
        status: data.status.value,
      );
}

bool _matchesFields(
  models.Tool tool, {
  required String brand,
  required String category,
  required String? label,
  required num? purchasePrice,
  required num? usageCostPerDay,
  required models.ToolStatus? status,
}) {
  return tool.brand == brand &&
      tool.category == category &&
      tool.label == label &&
      tool.purchasePrice == purchasePrice &&
      tool.usageCostPerDay == usageCostPerDay &&
      tool.status == status;
}

bool _exactKeys(Map<String, Object?> value, Set<String> fields) {
  return value.length == fields.length && fields.every(value.containsKey);
}

void _checkDateEnvelope(Map<String, Object?> envelope) {
  if (!_exactKeys(envelope, {'json', 'meta'})) {
    throw const FormatException('INVALID_TOOL_RECEIPT_ENVELOPE');
  }

  final data = jsonMap(envelope['json']);
  final dates = <String>{'createdAt'};
  final baseline = data['baseline'];

  _checkCanonicalDate(data['createdAt']);

  if (baseline != null) {
    final original = jsonMap(baseline);
    dates.addAll({'baseline.createdAt', 'baseline.modifiedAt'});
    _checkCanonicalDate(original['createdAt']);
    _checkCanonicalDate(original['modifiedAt']);

    if (original['archivedSince'] != null) {
      dates.add('baseline.archivedSince');
      _checkCanonicalDate(original['archivedSince']);
    }
  }

  final meta = jsonMap(envelope['meta']);

  if (!_exactKeys(meta, {'values'})) {
    throw const FormatException('INVALID_TOOL_RECEIPT_DATES');
  }

  final annotations = jsonMap(meta['values']);

  if (!_exactKeys(annotations, dates)) {
    throw const FormatException('INVALID_TOOL_RECEIPT_DATES');
  }

  for (final annotation in annotations.values) {
    if (annotation is! List<Object?> ||
        annotation.length != 1 ||
        annotation.single != 'Date') {
      throw const FormatException('INVALID_TOOL_RECEIPT_DATES');
    }
  }
}

void _checkCanonicalDate(Object? value) {
  if (value is! String) {
    throw const FormatException('INVALID_TOOL_RECEIPT_DATE');
  }

  final parsed = DateTime.tryParse(value);

  if (parsed == null || parsed.toUtc().toIso8601String() != value) {
    throw const FormatException('INVALID_TOOL_RECEIPT_DATE');
  }
}

void _checkSize(String encoded) {
  if (utf8.encode(encoded).length > 131072) {
    throw const FormatException('TOOL_RECEIPT_TOO_LARGE');
  }
}
