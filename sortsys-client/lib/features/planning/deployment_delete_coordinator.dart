import 'dart:math';

import '../../api/generated/models.g.dart' as models;
import '../projects/project_write_lock.dart';
import 'deployment_delete_receipt.dart';
import 'deployment_receipt.dart';
import 'deployment_write_coordinator.dart';

abstract interface class DeploymentDeleteAccess {
  String get scope;

  void checkCurrent();

  void checkDelete();

  Future<models.Deployment?> getDeployment(models.Deployment baseline);

  // Return only after the genuine delete API acknowledges success:true.
  Future<void> deleteDeployment(String id);
}

enum DeploymentDeleteFailure { outstanding, conflict, uncertain }

final class DeploymentDeleteException implements Exception {
  const DeploymentDeleteException(this.failure, {this.cause});

  final DeploymentDeleteFailure failure;
  final Object? cause;
}

final class DeploymentDeleteResult {
  const DeploymentDeleteResult({required this.id, required this.deleted});

  final String id;
  final bool deleted;
}

final class DeploymentDeleteCoordinator {
  const DeploymentDeleteCoordinator({
    required this.access,
    required this.receipts,
    required this.pendingWrites,
  });

  final DeploymentDeleteAccess access;
  final DeploymentDeleteStore receipts;
  final DeploymentReceiptStore pendingWrites;

  Future<DeploymentDeleteReceipt?> outstanding() async {
    access.checkCurrent();

    final receipt = await receipts.read(access.scope);

    access.checkCurrent();

    if (receipt != null) {
      receipt.encode();

      if (receipt.scope != access.scope) {
        throw const FormatException('DEPLOYMENT_DELETE_SCOPE_MISMATCH');
      }
    }

    return receipt;
  }

  Future<DeploymentDeleteResult> remove(models.Deployment baseline) async {
    access.checkDelete();

    return withProjectWriteLock('deployments:${access.scope}', () async {
      final pending = await outstanding();
      final other = await pendingWrites.read(access.scope);

      access.checkDelete();

      if (pending != null || other != null) {
        throw const DeploymentDeleteException(
          DeploymentDeleteFailure.outstanding,
        );
      }

      final fresh = await access.getDeployment(baseline);

      access.checkDelete();

      if (fresh == null ||
          deploymentDeleteKey(fresh) != deploymentDeleteKey(baseline)) {
        throw const DeploymentDeleteException(DeploymentDeleteFailure.conflict);
      }

      final receipt = DeploymentDeleteReceipt(
        scope: access.scope,
        nonce: _operationNonce(),
        createdAt: DateTime.now().toUtc(),
        baseline: fresh,
      );

      await _persist(receipt);

      try {
        access.checkDelete();

        final started = receipt.started();

        await _persist(started);

        access.checkDelete();

        await access.deleteDeployment(fresh.id);

        access.checkCurrent();

        final confirmed = started.confirmed();

        await _persist(confirmed);

        return await _clear(confirmed);
      } catch (error) {
        throw DeploymentDeleteException(
          DeploymentDeleteFailure.uncertain,
          cause: error,
        );
      }
    });
  }

  Future<void> _persist(DeploymentDeleteReceipt receipt) async {
    access.checkCurrent();
    receipt.encode();

    await receipts.write(receipt);

    access.checkCurrent();
  }

  Future<DeploymentDeleteResult> recover({
    required String expectedNonce,
  }) async {
    access.checkCurrent();

    return withProjectWriteLock('deployments:${access.scope}', () async {
      final receipt = await outstanding();

      if (receipt == null) {
        throw StateError('NO_DEPLOYMENT_DELETE_RECEIPT');
      }

      if (receipt.nonce != expectedNonce) {
        throw const DeploymentDeleteException(
          DeploymentDeleteFailure.outstanding,
        );
      }

      if (receipt.dispatching) {
        throw const DeploymentDeleteException(
          DeploymentDeleteFailure.uncertain,
        );
      }

      // A stored acknowledgement proves deletion; a prepared stage proves no dispatch.
      return _clear(receipt);
    });
  }

  Future<DeploymentDeleteResult> _clear(DeploymentDeleteReceipt receipt) async {
    access.checkCurrent();

    await receipts.clear(access.scope);

    access.checkCurrent();

    return DeploymentDeleteResult(
      id: receipt.baseline.id,
      deleted: receipt.acknowledged,
    );
  }
}

final class DeletionGuardedDeploymentReceipts
    implements DeploymentReceiptStore {
  const DeletionGuardedDeploymentReceipts({
    required this.writes,
    required this.deletions,
  });

  final DeploymentReceiptStore writes;
  final DeploymentDeleteStore deletions;

  @override
  Future<DeploymentWriteReceipt?> read(String scope) async {
    final deletion = await deletions.read(scope);

    if (deletion != null) {
      deletion.encode();

      if (deletion.scope != scope) {
        throw const FormatException('DEPLOYMENT_DELETE_SCOPE_MISMATCH');
      }

      throw const DeploymentWriteException(DeploymentWriteFailure.outstanding);
    }

    return writes.read(scope);
  }

  @override
  Future<void> write(DeploymentWriteReceipt receipt) async {
    await writes.write(receipt);
  }

  @override
  Future<void> clear(String scope) async {
    await writes.clear(scope);
  }
}

String _operationNonce() {
  final random = Random.secure();

  final bytes = List<int>.generate(16, (_) {
    return random.nextInt(256);
  });

  final nonce = bytes.map((value) {
    return value.toRadixString(16).padLeft(2, '0');
  }).join();

  return nonce;
}
