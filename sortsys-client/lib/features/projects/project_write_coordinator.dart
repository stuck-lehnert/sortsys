import 'dart:math';

import '../../api/generated/models.g.dart' as api_models;
import 'project_draft.dart';
import 'project_receipt.dart';
import 'project_write_lock.dart';

abstract interface class ProjectWriteAccess {
  String get scope;

  void checkCurrent();

  Future<api_models.Project> getProject(String id);

  Future<String> createProject(api_models.ProjectsCreateInput input);

  Future<void> updateProject(api_models.ProjectsUpdateInput input);
}

enum ProjectWriteFailure { outstanding, conflict, uncertain }

final class ProjectWriteException implements Exception {
  const ProjectWriteException(this.failure, {this.cause});

  final ProjectWriteFailure failure;
  final Object? cause;
}

typedef ProjectWriteLock =
    Future<String> Function(String scope, Future<String> Function() operation);

final class ProjectWriteCoordinator {
  ProjectWriteCoordinator({
    required this.access,
    required this.receipts,
    ProjectWriteLock? lock,
  }) : lock = lock ?? withProjectWriteLock<String>;

  final ProjectWriteAccess access;
  final ProjectReceiptStore receipts;
  final ProjectWriteLock lock;

  Future<ProjectWriteReceipt?> outstanding() async {
    access.checkCurrent();

    final receipt = await receipts.read(access.scope);
    access.checkCurrent();

    return receipt;
  }

  Future<String> save(
    ProjectDraft draft, {
    api_models.Project? baseline,
  }) async {
    draft.validate();
    access.checkCurrent();

    return lock(access.scope, () async {
      access.checkCurrent();

      final pending = await receipts.read(access.scope);
      access.checkCurrent();

      if (pending != null) {
        throw const ProjectWriteException(ProjectWriteFailure.outstanding);
      }

      api_models.ProjectsUpdateInput? update;

      if (baseline != null) {
        final fresh = await access.getProject(baseline.id);
        access.checkCurrent();

        if (fresh.id != baseline.id ||
            projectValueKey(fresh) != projectValueKey(baseline)) {
          throw const ProjectWriteException(ProjectWriteFailure.conflict);
        }

        update = draft.updateInput(baseline);

        if (update.data.toWire().isEmpty) {
          return baseline.id;
        }

      }

      final receipt = ProjectWriteReceipt(
        scope: access.scope,
        nonce: _operationNonce(),
        createdAt: DateTime.now().toUtc(),
        createInput: baseline == null ? draft.createInput() : null,
        updateInput: update,
      );

      // A failed durable write prevents dispatch. There is no mutation retry.
      await receipts.write(receipt);

      try {
        access.checkCurrent();
        final String projectId;

        if (receipt.createInput != null) {
          projectId = await access.createProject(receipt.createInput!);
        } else {
          await access.updateProject(receipt.updateInput!);
          projectId = receipt.updateInput!.id;
        }

        access.checkCurrent();

        if (projectId.isEmpty) {
          throw const FormatException('INVALID_PROJECT_WRITE_RESULT');
        }

        final confirmed = receipt.confirmed(projectId);
        await receipts.write(confirmed);
        access.checkCurrent();

        return await _verifyAndClear(confirmed, projectId);
      } catch (error) {
        throw ProjectWriteException(
          ProjectWriteFailure.uncertain,
          cause: error,
        );
      }

    });

  }

  Future<String> recover() async {
    access.checkCurrent();

    return lock(access.scope, () async {
      access.checkCurrent();

      final receipt = await receipts.read(access.scope);
      access.checkCurrent();

      if (receipt == null || receipt.scope != access.scope) {
        throw StateError('NO_PROJECT_WRITE_RECEIPT');
      }

      // Equal fields do not prove ownership of an unacknowledged creation.
      final projectId = receipt.confirmedProjectId ?? receipt.updateInput?.id;

      if (projectId == null) {
        throw const ProjectWriteException(ProjectWriteFailure.uncertain);
      }

      try {
        return await _verifyAndClear(receipt, projectId);
      } catch (error) {
        throw ProjectWriteException(
          ProjectWriteFailure.uncertain,
          cause: error,
        );
      }

    });

  }

  Future<String> _verifyAndClear(
    ProjectWriteReceipt receipt,
    String projectId,
  ) async {
    access.checkCurrent();

    final project = await access.getProject(projectId);
    access.checkCurrent();

    final requested = receipt.createInput ?? receipt.updateInput!.data;

    if (project.id != projectId || !projectMatchesInput(project, requested)) {
      throw StateError('PROJECT_WRITE_NOT_CONFIRMED');
    }

    await receipts.clear(access.scope);
    access.checkCurrent();

    return project.id;
  }

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
