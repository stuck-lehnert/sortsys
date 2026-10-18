import 'dart:convert';

import '../../api/contract.dart' show jsonMap;
import '../../api/generated/models.g.dart' as models;
import '../../api/model.dart';
import '../../api/wire.dart';
import 'planning_draft.dart';

const _maximumReceiptBytes = 131072;

models.UsersVacationsCreateInput absenceWriteInput(AbsenceDraft draft) {
  final normalized = draft.createInput();

  // UTC midnight preserves the selected civil day in the API's date decoder.
  final from = DateTime.utc(draft.from.year, draft.from.month, draft.from.day);
  final to = DateTime.utc(draft.to.year, draft.to.month, draft.to.day);

  return models.UsersVacationsCreateInput(
    from: from,
    to: to,
    userId: normalized.userId,
    type: normalized.type,
    label: normalized.label,
    note: normalized.note,
  );
}

final class AbsenceWriteReceipt {
  const AbsenceWriteReceipt({
    required this.scope,
    required this.nonce,
    required this.createdAt,
    required this.input,
    this.dispatching = false,
    this.acknowledgement,
  });

  final String scope;
  final String nonce;
  final DateTime createdAt;
  final models.UsersVacationsCreateInput input;
  final bool dispatching;
  final models.UsersVacationsCreateResult? acknowledgement;

  AbsenceWriteReceipt started() {
    if (dispatching || acknowledgement != null) {
      throw StateError('INVALID_ABSENCE_RECEIPT_STAGE');
    }

    return _copy(dispatching: true);
  }

  AbsenceWriteReceipt confirmed(models.UsersVacationsCreateResult result) {
    if (!dispatching || acknowledgement != null) {
      throw StateError('INVALID_ABSENCE_RECEIPT_STAGE');
    }

    if (result.id.isEmpty) {
      throw const FormatException('INVALID_ABSENCE_CREATE_RESULT');
    }

    return _copy(dispatching: false, acknowledgement: result);
  }

  AbsenceWriteReceipt _copy({
    required bool dispatching,
    models.UsersVacationsCreateResult? acknowledgement,
  }) {
    return AbsenceWriteReceipt(
      scope: scope,
      nonce: nonce,
      createdAt: createdAt,
      input: input,
      dispatching: dispatching,
      acknowledgement: acknowledgement,
    );
  }

  String encode() {
    _validate();

    final data = <String, Object?>{
      'version': 1,
      'scope': scope,
      'nonce': nonce,
      'createdAt': createdAt,
      'input': encodeRpcValue(input),
      'dispatching': dispatching,
      'acknowledgement': encodeRpcValue(acknowledgement),
    };
    final encoded = jsonEncode(serializeWire(data));

    _checkSize(encoded);

    return encoded;
  }

  factory AbsenceWriteReceipt.decode(String encoded) {
    _checkSize(encoded);

    final envelope = jsonMap(jsonDecode(encoded));
    final data = readRpcObject(deserializeWire(envelope), const {
      'version',
      'scope',
      'nonce',
      'createdAt',
      'input',
      'dispatching',
      'acknowledgement',
    });

    if (data.length != 7) {
      throw const FormatException('INVALID_ABSENCE_RECEIPT');
    }

    readRpcLiteral(data['version'], 1);

    final receipt = AbsenceWriteReceipt(
      scope: readRpcString(data['scope']),
      nonce: readRpcString(data['nonce']),
      createdAt: readRpcDate(data['createdAt']),
      input: models.UsersVacationsCreateInput.fromWire(data['input']),
      dispatching: readRpcBoolean(data['dispatching']),
      acknowledgement: readRpcNullable(
        data['acknowledgement'],
        models.UsersVacationsCreateResult.fromWire,
      ),
    );

    receipt._validate();

    return receipt;
  }

  void _validate() {
    if (scope.isEmpty ||
        !RegExp(r'^[0-9a-f]{32}$').hasMatch(nonce) ||
        createdAt.year < 100) {
      throw const FormatException('INVALID_ABSENCE_RECEIPT');
    }

    final acknowledgement = this.acknowledgement;

    if (acknowledgement != null &&
        (acknowledgement.id.isEmpty || dispatching)) {
      throw const FormatException('INVALID_ABSENCE_RECEIPT_STAGE');
    }

    final draft = AbsenceDraft(
      userId: input.userId.valueOrNull ?? '',
      from: readRpcDate(input.from),
      to: readRpcDate(input.to),
      type:
          input.type.valueOrNull ??
          models.UsersVacationsListResultItemType.vacation,
      label: input.label.valueOrNull ?? '',
      note: input.note.valueOrNull ?? '',
    );
    final canonical = absenceWriteInput(draft);

    if (absenceInputKey(canonical) != absenceInputKey(input)) {
      throw const FormatException('INVALID_ABSENCE_RECEIPT_INPUT');
    }
  }
}

abstract interface class AbsenceReceiptStore {
  Future<AbsenceWriteReceipt?> read(String scope);

  Future<void> write(AbsenceWriteReceipt receipt);

  Future<void> clear(String scope);
}

String absenceInputKey(models.UsersVacationsCreateInput input) {
  final encoded = serializeWire(encodeRpcValue(input));

  return jsonEncode(encoded);
}

bool absenceMatchesInput(
  models.UsersVacationsListResultItem record,
  models.UsersVacationsCreateInput input,
) {
  final samePeriod =
      _sameDay(record.from, input.from) && _sameDay(record.to, input.to);

  return record.userId == input.userId.valueOrNull &&
      samePeriod &&
      record.type == input.type.valueOrNull &&
      record.label == input.label.valueOrNull &&
      record.note == input.note.valueOrNull;
}

bool _sameDay(Object? left, Object? right) {
  final first = readRpcDate(left);
  final last = readRpcDate(right);

  return first.year == last.year &&
      first.month == last.month &&
      first.day == last.day;
}

void _checkSize(String encoded) {
  if (utf8.encode(encoded).length > _maximumReceiptBytes) {
    throw const FormatException('ABSENCE_RECEIPT_TOO_LARGE');
  }
}
