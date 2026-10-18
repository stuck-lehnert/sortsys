import 'dart:convert';

import '../../api/contract.dart' show jsonMap;
import '../../api/generated/models.g.dart' as models;
import '../../api/model.dart';
import '../../api/wire.dart';
import 'planning_draft.dart';
import 'project_block_write_input.dart';

const _maximumReceiptBytes = 131072;

enum ProjectBlockWriteKind { update, delete }

final class ProjectBlockReceipt {
  const ProjectBlockReceipt({
    required this.scope,
    required this.nonce,
    required this.createdAt,
    required this.kind,
    required this.baseline,
    this.input,
    this.dispatching = false,
    this.acknowledged = false,
  });

  final String scope;
  final String nonce;
  final DateTime createdAt;
  final ProjectBlockWriteKind kind;
  final models.ProjectsUnavailabilityListResultItem baseline;
  final models.ProjectsUnavailabilityUpdateInput? input;
  final bool dispatching;
  final bool acknowledged;

  models.ProjectsUnavailabilityUpdateInput get updateInput {
    final value = input;

    if (kind != ProjectBlockWriteKind.update || value == null) {
      throw StateError('INVALID_PROJECT_BLOCK_WRITE_KIND');
    }

    return value;
  }

  ProjectBlockReceipt started() {
    if (dispatching || acknowledged) {
      throw StateError('INVALID_PROJECT_BLOCK_WRITE_STAGE');
    }

    return _copy(dispatching: true, acknowledged: false);
  }

  ProjectBlockReceipt confirmed() {
    if (!dispatching || acknowledged) {
      throw StateError('INVALID_PROJECT_BLOCK_WRITE_STAGE');
    }

    return _copy(dispatching: false, acknowledged: true);
  }

  ProjectBlockReceipt _copy({
    required bool dispatching,
    required bool acknowledged,
  }) {
    return ProjectBlockReceipt(
      scope: scope,
      nonce: nonce,
      createdAt: createdAt,
      kind: kind,
      baseline: baseline,
      input: input,
      dispatching: dispatching,
      acknowledged: acknowledged,
    );
  }

  String encode() {
    _validate();

    final data = <String, Object?>{
      'version': 1,
      'scope': scope,
      'nonce': nonce,
      'createdAt': createdAt,
      'kind': kind.name,
      'baseline': encodeRpcValue(baseline),
      'input': input == null ? null : encodeRpcValue(input),
      'dispatching': dispatching,
      'acknowledged': acknowledged,
    };
    final encoded = jsonEncode(serializeWire(data));

    _checkSize(encoded);

    return encoded;
  }

  factory ProjectBlockReceipt.decode(String encoded) {
    _checkSize(encoded);

    final envelope = jsonMap(jsonDecode(encoded));
    final data = readRpcObject(deserializeWire(envelope), const {
      'version',
      'scope',
      'nonce',
      'createdAt',
      'kind',
      'baseline',
      'input',
      'dispatching',
      'acknowledged',
    });

    if (data.length != 9) {
      throw const FormatException('INVALID_PROJECT_BLOCK_RECEIPT');
    }

    readRpcLiteral(data['version'], 1);

    final kind = switch (readRpcString(data['kind'])) {
      'update' => ProjectBlockWriteKind.update,
      'delete' => ProjectBlockWriteKind.delete,
      _ => throw const FormatException('INVALID_PROJECT_BLOCK_WRITE_KIND'),
    };
    final receipt = ProjectBlockReceipt(
      scope: readRpcString(data['scope']),
      nonce: readRpcString(data['nonce']),
      createdAt: readRpcDate(data['createdAt']),
      kind: kind,
      baseline: models.ProjectsUnavailabilityListResultItem.fromWire(
        data['baseline'],
      ),
      input: data['input'] == null
          ? null
          : models.ProjectsUnavailabilityUpdateInput.fromWire(data['input']),
      dispatching: readRpcBoolean(data['dispatching']),
      acknowledged: readRpcBoolean(data['acknowledged']),
    );

    receipt._validate();

    return receipt;
  }

  void _validate() {
    if (scope.isEmpty ||
        !RegExp(r'^[0-9a-f]{32}$').hasMatch(nonce) ||
        createdAt.year < 100 ||
        (dispatching && acknowledged)) {
      throw const FormatException('INVALID_PROJECT_BLOCK_RECEIPT');
    }

    _validateBaseline(baseline);

    if (kind == ProjectBlockWriteKind.delete) {
      if (input != null) {
        throw const FormatException('INVALID_PROJECT_BLOCK_DELETE_INPUT');
      }

      return;
    }

    final update = input;

    if (update == null) {
      throw const FormatException('INVALID_PROJECT_BLOCK_UPDATE_INPUT');
    }

    final target = projectBlockTargetDraft(baseline, update);
    final canonical = projectBlockWriteInput(target, baseline);

    if (canonical == null || _inputKey(canonical) != _inputKey(update)) {
      throw const FormatException('INVALID_PROJECT_BLOCK_UPDATE_INPUT');
    }
  }
}

abstract interface class ProjectBlockReceiptStore {
  Future<ProjectBlockReceipt?> read(String scope);

  Future<void> write(ProjectBlockReceipt receipt);

  Future<void> clear(String scope);
}

ProjectBlockDraft projectBlockTargetDraft(
  models.ProjectsUnavailabilityListResultItem baseline,
  models.ProjectsUnavailabilityUpdateInput input,
) {
  if (input.id != baseline.id) {
    throw const FormatException('PROJECT_BLOCK_UPDATE_ID_MISMATCH');
  }

  final data = input.data;
  final projectId = readRpcString(
    _patchValue(data.projectId, baseline.projectId),
  );
  final from = readRpcDate(_patchValue(data.from, baseline.from));
  final to = readRpcDate(_patchValue(data.to, baseline.to));
  final reason = readRpcString(_patchValue(data.reason, baseline.reason));
  final rawNote = _patchValue(data.note, baseline.note);
  final note = rawNote == null ? '' : readRpcString(rawNote);
  final target = ProjectBlockDraft(
    projectId: projectId,
    from: from,
    to: to,
    reason: reason,
    note: note,
  );

  validateProjectBlockWriteDraft(target);

  return target;
}

bool projectBlockMatchesTarget(
  models.ProjectsUnavailabilityListResultItem record, {
  required String id,
  required ProjectBlockDraft target,
}) {
  final note = target.note.trim();

  return record.id == id &&
      record.projectId == target.projectId &&
      _civilDay(record.from) == _civilDay(target.from) &&
      _civilDay(record.to) == _civilDay(target.to) &&
      record.reason == target.reason.trim() &&
      record.note == (note.isEmpty ? null : note);
}

String projectBlockBaselineKey(
  models.ProjectsUnavailabilityListResultItem row,
) {
  _validateBaseline(row);

  return jsonEncode(serializeWire(encodeRpcValue(row)));
}

Object? _patchValue(RpcOptional<Object?> field, Object? fallback) {
  if (field.isAbsent) {
    return fallback;
  }

  if (!field.hasValue) {
    throw const FormatException('UNDEFINED_PROJECT_BLOCK_UPDATE_FIELD');
  }

  return field.value;
}

String _inputKey(models.ProjectsUnavailabilityUpdateInput input) {
  return jsonEncode(serializeWire(encodeRpcValue(input)));
}

DateTime _civilDay(DateTime value) {
  return DateTime.utc(value.year, value.month, value.day);
}

void _validateBaseline(models.ProjectsUnavailabilityListResultItem row) {
  if (row.id.isEmpty ||
      row.projectId.isEmpty ||
      row.reason.trim().isEmpty ||
      row.from.year < 100 ||
      row.to.year < 100 ||
      _civilDay(row.to).isBefore(_civilDay(row.from))) {
    throw const FormatException('INVALID_PROJECT_BLOCK_BASELINE');
  }
}

void _checkSize(String encoded) {
  if (utf8.encode(encoded).length > _maximumReceiptBytes) {
    throw const FormatException('PROJECT_BLOCK_RECEIPT_TOO_LARGE');
  }
}
