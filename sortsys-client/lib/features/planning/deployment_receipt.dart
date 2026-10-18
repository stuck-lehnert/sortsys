import 'dart:convert';

import '../../api/contract.dart';
import '../../api/generated/models.g.dart' as models;
import '../../api/model.dart';
import '../../api/wire.dart';
import 'planning_draft.dart';

const _maximumReceiptBytes = 131072;

final class DeploymentWriteReceipt {
  DeploymentWriteReceipt({
    required this.scope,
    required this.nonce,
    required this.createdAt,
    required Iterable<models.ProjectsDeploymentsCreateInput> targets,
    this.updateInput,
    this.baseline,
    Iterable<String> confirmedIds = const [],
    this.dispatching = false,
  }) : targets = List.unmodifiable(targets),
       confirmedIds = List.unmodifiable(confirmedIds);

  final String scope;
  final String nonce;
  final DateTime createdAt;
  final List<models.ProjectsDeploymentsCreateInput> targets;
  final models.ProjectsDeploymentsUpdateInput? updateInput;
  final models.Deployment? baseline;
  final List<String> confirmedIds;
  final bool dispatching;

  DeploymentWriteReceipt started() {
    return _copy(dispatching: true);
  }

  DeploymentWriteReceipt confirmed(String id) {
    return _copy(dispatching: false, confirmedIds: [...confirmedIds, id]);
  }

  DeploymentWriteReceipt _copy({
    required bool dispatching,
    List<String>? confirmedIds,
  }) {
    return DeploymentWriteReceipt(
      scope: scope,
      nonce: nonce,
      createdAt: createdAt,
      targets: targets,
      updateInput: updateInput,
      baseline: baseline,
      confirmedIds: confirmedIds ?? this.confirmedIds,
      dispatching: dispatching,
    );
  }

  String encode() {
    _validate();

    final data = <String, Object?>{
      'version': 1,
      'scope': scope,
      'nonce': nonce,
      'createdAt': createdAt,
      'targets': encodeRpcValue(targets),
      'updateInput': encodeRpcValue(updateInput),
      'baseline': encodeRpcValue(baseline),
      'confirmedIds': confirmedIds,
      'dispatching': dispatching,
    };
    final encoded = jsonEncode(serializeWire(data));

    _checkSize(encoded);

    return encoded;
  }

  factory DeploymentWriteReceipt.decode(String encoded) {
    _checkSize(encoded);

    final envelope = jsonMap(jsonDecode(encoded));
    final data = readRpcObject(deserializeWire(envelope), const {
      'version',
      'scope',
      'nonce',
      'createdAt',
      'targets',
      'updateInput',
      'baseline',
      'confirmedIds',
      'dispatching',
    });

    if (data.length != 9) {
      throw const FormatException('INVALID_DEPLOYMENT_RECEIPT');
    }

    readRpcLiteral(data['version'], 1);
    final targets = readRpcList(
      data['targets'],
      models.ProjectsDeploymentsCreateInput.fromWire,
    );
    final update = readRpcNullable(
      data['updateInput'],
      models.ProjectsDeploymentsUpdateInput.fromWire,
    );
    final baseline = readRpcNullable(
      data['baseline'],
      models.Deployment.fromWire,
    );
    final confirmedIds = readRpcList(data['confirmedIds'], readRpcString);
    final receipt = DeploymentWriteReceipt(
      scope: readRpcString(data['scope']),
      nonce: readRpcString(data['nonce']),
      createdAt: readRpcDate(data['createdAt']),
      targets: targets,
      updateInput: update,
      baseline: baseline,
      confirmedIds: confirmedIds,
      dispatching: readRpcBoolean(data['dispatching']),
    );

    receipt._validate();

    return receipt;
  }

  void _validate() {
    if (scope.isEmpty ||
        !RegExp(r'^[0-9a-f]{32}$').hasMatch(nonce) ||
        createdAt.year < 100 ||
        targets.isEmpty) {
      throw const FormatException('INVALID_DEPLOYMENT_RECEIPT');
    }

    final users = <String>{};

    for (final target in targets) {
      _targetDraft(target).validate();

      if (!users.add(target.userId)) {
        throw const FormatException('DUPLICATE_DEPLOYMENT_RECEIPT_USER');
      }
    }

    _validateConfirmation();
    _validateUpdate();
  }

  void _validateConfirmation() {
    final invalidIds = confirmedIds.any((id) {
      return id.isEmpty;
    });
    final complete = confirmedIds.length == targets.length;

    if (invalidIds ||
        confirmedIds.toSet().length != confirmedIds.length ||
        confirmedIds.length > targets.length ||
        (dispatching && complete)) {
      throw const FormatException('INVALID_DEPLOYMENT_RECEIPT_CONFIRMATION');
    }
  }

  void _validateUpdate() {
    final update = updateInput;
    final original = baseline;

    if (update == null) {
      if (original != null) {
        throw const FormatException('INVALID_DEPLOYMENT_RECEIPT_UPDATE');
      }

      return;
    }

    if (original == null || targets.length != 1 || update.id != original.id) {
      throw const FormatException('INVALID_DEPLOYMENT_RECEIPT_UPDATE');
    }

    final expected = _targetDraft(targets.single).updateInput(original);

    if (expected == null ||
        deploymentWriteKey(expected) != deploymentWriteKey(update)) {
      throw const FormatException('INVALID_DEPLOYMENT_RECEIPT_UPDATE');
    }

    if (confirmedIds.isNotEmpty && confirmedIds.single != update.id) {
      throw const FormatException('INVALID_DEPLOYMENT_RECEIPT_CONFIRMATION');
    }
  }
}

abstract interface class DeploymentReceiptStore {
  Future<DeploymentWriteReceipt?> read(String scope);

  Future<void> write(DeploymentWriteReceipt receipt);

  Future<void> clear(String scope);
}

String deploymentWriteKey(RpcValue value) {
  final encoded = serializeWire(encodeRpcValue(value));

  return jsonEncode(encoded);
}

bool deploymentMatchesTarget(
  models.Deployment record,
  models.ProjectsDeploymentsCreateInput target,
) {
  final samePeriod =
      readRpcDate(record.from).isAtSameMomentAs(readRpcDate(target.from)) &&
      readRpcDate(record.to).isAtSameMomentAs(readRpcDate(target.to));

  return record.userId == target.userId &&
      record.projectId == target.projectId &&
      samePeriod &&
      record.note == target.note.valueOrNull;
}

DeploymentDraft _targetDraft(models.ProjectsDeploymentsCreateInput target) {
  return DeploymentDraft(
    userIds: [target.userId],
    projectId: target.projectId,
    from: readRpcDate(target.from),
    to: readRpcDate(target.to),
    note: target.note.valueOrNull ?? '',
  );
}

void _checkSize(String encoded) {
  if (utf8.encode(encoded).length > _maximumReceiptBytes) {
    throw const FormatException('DEPLOYMENT_RECEIPT_TOO_LARGE');
  }
}
