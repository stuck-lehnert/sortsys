import 'dart:math';

import '../../api/generated/models.g.dart' as models;
import '../../api/model.dart';
import '../projects/project_write_lock.dart';
import 'deployment_receipt.dart';
import 'planning_draft.dart';

abstract interface class DeploymentWriteAccess {
  String get scope;

  void checkCurrent();

  // A fresh bounded snapshot resolves the ID. Absence never proves deletion.
  Future<models.Deployment?> getDeployment(
    String id, {
    required DateTime from,
    required DateTime to,
  });

  Future<String> createDeployment(models.ProjectsDeploymentsCreateInput input);

  Future<void> updateDeployment(models.ProjectsDeploymentsUpdateInput input);
}

enum DeploymentWriteFailure { outstanding, conflict, uncertain }

final class DeploymentWriteException implements Exception {
  const DeploymentWriteException(this.failure, {this.cause});

  final DeploymentWriteFailure failure;
  final Object? cause;
}

final class DeploymentWriteResult {
  DeploymentWriteResult({
    required Iterable<String> ids,
    Iterable<models.ProjectsDeploymentsCreateInput> unsubmitted = const [],
  }) : ids = List.unmodifiable(ids),
       unsubmitted = List.unmodifiable(unsubmitted);

  final List<String> ids;
  final List<models.ProjectsDeploymentsCreateInput> unsubmitted;

  bool get complete => unsubmitted.isEmpty;
}

typedef DeploymentWriteLock =
    Future<DeploymentWriteResult> Function(
      String scope,
      Future<DeploymentWriteResult> Function() operation,
    );

final class DeploymentWriteCoordinator {
  DeploymentWriteCoordinator({
    required this.access,
    required this.receipts,
    DeploymentWriteLock? lock,
  }) : lock = lock ?? _withDeploymentLock;

  final DeploymentWriteAccess access;
  final DeploymentReceiptStore receipts;
  final DeploymentWriteLock lock;

  Future<DeploymentWriteReceipt?> outstanding() async {
    access.checkCurrent();

    final receipt = await receipts.read(access.scope);
    access.checkCurrent();

    if (receipt != null) {
      receipt.encode();

      if (receipt.scope != access.scope) {
        throw const FormatException('DEPLOYMENT_RECEIPT_SCOPE_MISMATCH');
      }
    }

    return receipt;
  }

  Future<DeploymentWriteResult> save(
    DeploymentDraft draft, {
    models.Deployment? baseline,
  }) async {
    draft.validate();
    access.checkCurrent();

    return lock(access.scope, () {
      return _saveLocked(draft, baseline);
    });
  }

  Future<DeploymentWriteResult> _saveLocked(
    DeploymentDraft draft,
    models.Deployment? baseline,
  ) async {
    final pending = await outstanding();

    if (pending != null) {
      throw const DeploymentWriteException(DeploymentWriteFailure.outstanding);
    }

    models.ProjectsDeploymentsUpdateInput? update;

    if (baseline != null) {
      update = await _freshUpdate(draft, baseline);

      if (update == null) {
        return DeploymentWriteResult(ids: [baseline.id]);
      }
    }

    final receipt = DeploymentWriteReceipt(
      scope: access.scope,
      nonce: _operationNonce(),
      createdAt: DateTime.now().toUtc(),
      targets: draft.createInputs(),
      updateInput: update,
      baseline: baseline,
    );

    await _persist(receipt);

    try {
      return await _dispatch(receipt);
    } catch (error) {
      throw DeploymentWriteException(
        DeploymentWriteFailure.uncertain,
        cause: error,
      );
    }
  }

  Future<models.ProjectsDeploymentsUpdateInput?> _freshUpdate(
    DeploymentDraft draft,
    models.Deployment baseline,
  ) async {
    if (baseline.id.isEmpty) {
      throw const FormatException('INVALID_DEPLOYMENT_BASELINE_ID');
    }

    access.checkCurrent();

    final fresh = await access.getDeployment(
      baseline.id,
      from: baseline.from,
      to: baseline.to,
    );
    access.checkCurrent();

    if (fresh == null ||
        fresh.id != baseline.id ||
        deploymentWriteKey(fresh) != deploymentWriteKey(baseline)) {
      throw const DeploymentWriteException(DeploymentWriteFailure.conflict);
    }

    return draft.updateInput(baseline);
  }

  Future<DeploymentWriteResult> _dispatch(
    DeploymentWriteReceipt receipt,
  ) async {
    var current = receipt;
    final update = receipt.updateInput;

    if (update != null) {
      current = current.started();
      await _persist(current);

      await access.updateDeployment(update);
      access.checkCurrent();

      current = current.confirmed(update.id);
      await _persist(current);
    } else {
      for (final target in receipt.targets) {
        current = current.started();
        await _persist(current);

        final id = await access.createDeployment(target);
        access.checkCurrent();

        if (id.isEmpty || current.confirmedIds.contains(id)) {
          throw const FormatException('INVALID_DEPLOYMENT_CREATE_RESULT');
        }

        current = current.confirmed(id);
        await _persist(current);
      }
    }

    return _verifyAndClear(current);
  }

  Future<void> _persist(DeploymentWriteReceipt receipt) async {
    access.checkCurrent();
    receipt.encode();

    await receipts.write(receipt);
    access.checkCurrent();
  }

  Future<DeploymentWriteResult> recover() async {
    access.checkCurrent();

    return lock(access.scope, () async {
      final receipt = await outstanding();

      if (receipt == null) {
        throw StateError('NO_DEPLOYMENT_WRITE_RECEIPT');
      }

      try {
        return await _verifyAndClear(receipt);
      } catch (error) {
        throw DeploymentWriteException(
          DeploymentWriteFailure.uncertain,
          cause: error,
        );
      }
    });
  }

  Future<DeploymentWriteResult> _verifyAndClear(
    DeploymentWriteReceipt receipt,
  ) async {
    final update = receipt.updateInput;

    // A matching record cannot identify an unacknowledged creation.
    if (update == null && receipt.dispatching) {
      throw StateError('UNCONFIRMED_DEPLOYMENT_CREATION');
    }

    final ids = List<String>.of(receipt.confirmedIds);

    if (update != null && receipt.dispatching) {
      ids.add(update.id);
    }

    for (var index = 0; index < ids.length; index++) {
      access.checkCurrent();

      final id = ids[index];
      final target = receipt.targets[index];
      final record = await access.getDeployment(
        id,
        from: readRpcDate(target.from),
        to: readRpcDate(target.to),
      );
      access.checkCurrent();

      if (record == null ||
          record.id != id ||
          !deploymentMatchesTarget(record, target)) {
        throw StateError('DEPLOYMENT_WRITE_NOT_CONFIRMED');
      }
    }

    final unsubmitted = receipt.targets
        .skip(ids.length)
        .toList(growable: false);

    await receipts.clear(access.scope);
    access.checkCurrent();

    return DeploymentWriteResult(ids: ids, unsubmitted: unsubmitted);
  }
}

Future<DeploymentWriteResult> _withDeploymentLock(
  String scope,
  Future<DeploymentWriteResult> Function() operation,
) {
  return withProjectWriteLock('deployments:$scope', operation);
}

String _operationNonce() {
  final random = Random.secure();
  final bytes = List<int>.generate(16, (_) {
    return random.nextInt(256);
  });
  final encoded = bytes.map((value) {
    return value.toRadixString(16).padLeft(2, '0');
  }).join();

  return encoded;
}
