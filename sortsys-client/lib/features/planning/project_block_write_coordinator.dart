import 'dart:math';

import '../../api/generated/models.g.dart' as models;
import '../projects/project_write_lock.dart';
import 'planning_draft.dart';
import 'project_block_receipt.dart';
import 'project_block_write_input.dart';

abstract interface class ProjectBlockWriteAccess {
  String get scope;

  void checkCurrent();

  void checkUpdate();

  void checkDelete();

  // Resolve this known ID through the genuine inclusive-window list API.
  Future<models.ProjectsUnavailabilityListResultItem?> getBlock({
    required String id,
    required DateTime from,
    required DateTime to,
  });

  Future<void> updateBlock(models.ProjectsUnavailabilityUpdateInput input);

  // Return only after the genuine API acknowledges success:true.
  Future<void> deleteBlock(String id);
}

enum ProjectBlockWriteFailure { outstanding, conflict, uncertain }

enum ProjectBlockWriteOutcome { unchanged, verified, deleted, discarded }

final class ProjectBlockWriteException implements Exception {
  const ProjectBlockWriteException(this.failure, {this.cause});

  final ProjectBlockWriteFailure failure;
  final Object? cause;
}

final class ProjectBlockWriteResult {
  const ProjectBlockWriteResult({
    required this.id,
    required this.outcome,
    this.record,
  });

  final String id;
  final ProjectBlockWriteOutcome outcome;
  final models.ProjectsUnavailabilityListResultItem? record;
}

final class ProjectBlockWriteCoordinator {
  const ProjectBlockWriteCoordinator({
    required this.access,
    required this.receipts,
  });

  final ProjectBlockWriteAccess access;
  final ProjectBlockReceiptStore receipts;

  Future<ProjectBlockReceipt?> outstanding() async {
    access.checkCurrent();

    final receipt = await receipts.read(access.scope);

    access.checkCurrent();

    if (receipt != null) {
      receipt.encode();

      if (receipt.scope != access.scope) {
        throw const FormatException('PROJECT_BLOCK_RECEIPT_SCOPE_MISMATCH');
      }
    }

    return receipt;
  }

  Future<ProjectBlockWriteResult> save(
    ProjectBlockDraft draft,
    models.ProjectsUnavailabilityListResultItem baseline,
  ) async {
    access.checkUpdate();
    validateProjectBlockWriteDraft(draft);

    return withProjectWriteLock('projectBlocks:${access.scope}', () async {
      await _requireEmpty();

      access.checkUpdate();

      final fresh = await _fresh(baseline, access.checkUpdate);
      final input = projectBlockWriteInput(draft, fresh);

      if (input == null) {
        return ProjectBlockWriteResult(
          id: fresh.id,
          outcome: ProjectBlockWriteOutcome.unchanged,
          record: fresh,
        );
      }

      final receipt = _receipt(
        ProjectBlockWriteKind.update,
        fresh,
        input: input,
      );

      await _persist(receipt);

      return _update(receipt);
    });
  }

  Future<ProjectBlockWriteResult> remove(
    models.ProjectsUnavailabilityListResultItem baseline,
  ) async {
    access.checkDelete();

    return withProjectWriteLock('projectBlocks:${access.scope}', () async {
      await _requireEmpty();

      access.checkDelete();

      final fresh = await _fresh(baseline, access.checkDelete);
      final receipt = _receipt(ProjectBlockWriteKind.delete, fresh);

      await _persist(receipt);

      return _delete(receipt);
    });
  }

  Future<void> _requireEmpty() async {
    final pending = await outstanding();

    if (pending != null) {
      throw const ProjectBlockWriteException(
        ProjectBlockWriteFailure.outstanding,
      );
    }
  }

  Future<models.ProjectsUnavailabilityListResultItem> _fresh(
    models.ProjectsUnavailabilityListResultItem baseline,
    void Function() checkAllowed,
  ) async {
    final key = projectBlockBaselineKey(baseline);
    final fresh = await access.getBlock(
      id: baseline.id,
      from: baseline.from,
      to: baseline.to,
    );

    checkAllowed();

    if (fresh == null || projectBlockBaselineKey(fresh) != key) {
      throw const ProjectBlockWriteException(ProjectBlockWriteFailure.conflict);
    }

    return fresh;
  }

  ProjectBlockReceipt _receipt(
    ProjectBlockWriteKind kind,
    models.ProjectsUnavailabilityListResultItem baseline, {
    models.ProjectsUnavailabilityUpdateInput? input,
  }) {
    return ProjectBlockReceipt(
      scope: access.scope,
      nonce: _operationNonce(),
      createdAt: DateTime.now().toUtc(),
      kind: kind,
      baseline: baseline,
      input: input,
    );
  }

  Future<void> _persist(ProjectBlockReceipt receipt) async {
    access.checkCurrent();
    receipt.encode();

    await receipts.write(receipt);

    access.checkCurrent();
  }

  Future<ProjectBlockWriteResult> _update(ProjectBlockReceipt receipt) async {
    try {
      access.checkUpdate();

      final started = receipt.started();

      await _persist(started);

      access.checkUpdate();

      await access.updateBlock(started.updateInput);

      access.checkCurrent();

      final confirmed = started.confirmed();

      await _persist(confirmed);

      return await _verifyUpdate(confirmed);
    } catch (error) {
      throw ProjectBlockWriteException(
        ProjectBlockWriteFailure.uncertain,
        cause: error,
      );
    }
  }

  Future<ProjectBlockWriteResult> _delete(ProjectBlockReceipt receipt) async {
    try {
      access.checkDelete();

      final started = receipt.started();

      await _persist(started);

      access.checkDelete();

      await access.deleteBlock(started.baseline.id);

      access.checkCurrent();

      final confirmed = started.confirmed();

      await _persist(confirmed);
      await _clear(confirmed);

      return ProjectBlockWriteResult(
        id: confirmed.baseline.id,
        outcome: ProjectBlockWriteOutcome.deleted,
      );
    } catch (error) {
      throw ProjectBlockWriteException(
        ProjectBlockWriteFailure.uncertain,
        cause: error,
      );
    }
  }

  Future<ProjectBlockWriteResult> recover({
    required String expectedNonce,
  }) async {
    access.checkCurrent();

    return withProjectWriteLock('projectBlocks:${access.scope}', () async {
      final receipt = await outstanding();

      if (receipt == null) {
        throw StateError('NO_PROJECT_BLOCK_RECEIPT');
      }

      if (receipt.nonce != expectedNonce) {
        throw const ProjectBlockWriteException(
          ProjectBlockWriteFailure.outstanding,
        );
      }

      if (!receipt.dispatching && !receipt.acknowledged) {
        await _clear(receipt);

        return ProjectBlockWriteResult(
          id: receipt.baseline.id,
          outcome: ProjectBlockWriteOutcome.discarded,
        );
      }

      if (receipt.kind == ProjectBlockWriteKind.delete) {
        if (!receipt.acknowledged) {
          throw const ProjectBlockWriteException(
            ProjectBlockWriteFailure.uncertain,
          );
        }

        await _clear(receipt);

        return ProjectBlockWriteResult(
          id: receipt.baseline.id,
          outcome: ProjectBlockWriteOutcome.deleted,
        );
      }

      try {
        return await _verifyUpdate(receipt);
      } catch (error) {
        throw ProjectBlockWriteException(
          ProjectBlockWriteFailure.uncertain,
          cause: error,
        );
      }
    });
  }

  Future<ProjectBlockWriteResult> _verifyUpdate(
    ProjectBlockReceipt receipt,
  ) async {
    final target = projectBlockTargetDraft(
      receipt.baseline,
      receipt.updateInput,
    );
    final record = await access.getBlock(
      id: receipt.baseline.id,
      from: target.from,
      to: target.to,
    );

    access.checkCurrent();

    if (record == null ||
        !projectBlockMatchesTarget(
          record,
          id: receipt.baseline.id,
          target: target,
        )) {
      throw StateError('PROJECT_BLOCK_UPDATE_NOT_CONFIRMED');
    }

    await _clear(receipt);

    return ProjectBlockWriteResult(
      id: record.id,
      outcome: ProjectBlockWriteOutcome.verified,
      record: record,
    );
  }

  Future<void> _clear(ProjectBlockReceipt receipt) async {
    access.checkCurrent();

    await receipts.clear(receipt.scope);

    access.checkCurrent();
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
