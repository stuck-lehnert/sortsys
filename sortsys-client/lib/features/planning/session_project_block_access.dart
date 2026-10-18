import 'dart:convert';

import '../../api/generated/api.g.dart';
import '../../api/generated/models.g.dart' as models;
import '../../api/model.dart';
import '../../state/session_controller.dart';
import 'project_block_write_coordinator.dart';

final class SessionProjectBlockAccess implements ProjectBlockWriteAccess {
  SessionProjectBlockAccess(
    SessionController session, {
    bool Function()? isActive,
  }) : this._(session, isActive);

  SessionProjectBlockAccess._(this.session, this._isActive)
    : _binding = session.binding,
      scope = jsonEncode([
        session.instance?.origin.toString(),
        session.tenant,
        session.info?.userId,
      ]);

  final SessionController session;
  final bool Function()? _isActive;
  final String _binding;

  @override
  final String scope;

  @override
  void checkCurrent() {
    final active = _isActive?.call() ?? true;

    if (!active ||
        !session.authenticated ||
        session.binding != _binding ||
        session.instance == null) {
      throw StateError('PROJECT_BLOCK_SCOPE_CHANGED');
    }

  }

  @override
  void checkUpdate() {
    checkCurrent();

    if (session.info?.can('manage:projectDeployments') != true) {
      throw StateError('PROJECT_BLOCK_UPDATE_NOT_ALLOWED');
    }

  }

  @override
  void checkDelete() {
    checkCurrent();

    if (session.info?.can('delete:projectDeployments') != true) {
      throw StateError('PROJECT_BLOCK_DELETE_NOT_ALLOWED');
    }

  }

  @override
  Future<models.ProjectsUnavailabilityListResultItem?> getBlock({
    required String id,
    required DateTime from,
    required DateTime to,
  }) async {
    checkCurrent();

    final first = _civilDay(from);
    final last = _civilDay(to);

    if (id.isEmpty ||
        first.year < 100 ||
        last.year < 100 ||
        last.isBefore(first)) {
      throw const FormatException('INVALID_PROJECT_BLOCK_READ_WINDOW');
    }

    final input = models.ProjectsUnavailabilityListInput(
      from: RpcOptional.value(first),
      to: RpcOptional.value(last),
    );

    final records = await session.read(
      ApiQueries.projectsUnavailabilityList,
      input,
    );

    checkCurrent();

    models.ProjectsUnavailabilityListResultItem? match;

    for (final record in records) {
      if (record.id != id) {
        continue;
      }

      if (match != null) {
        throw const FormatException('DUPLICATE_PROJECT_BLOCK_RESPONSE_ID');
      }

      final begins = _civilDay(record.from);
      final ends = _civilDay(record.to);

      if (begins.year < 100 ||
          ends.year < 100 ||
          ends.isBefore(begins) ||
          ends.isBefore(first) ||
          begins.isAfter(last)) {
        throw const FormatException('INVALID_PROJECT_BLOCK_READ_RESULT');
      }

      match = record;
    }

    return match;
  }

  Future<models.Project> initialProject(String id) async {
    checkCurrent();

    if (id.isEmpty) {
      throw const FormatException('PROJECT_ID_REQUIRED');
    }

    final project = await session.read(
      ApiQueries.projectsGet,
      models.ProjectsGetInput(id: id),
    );

    checkCurrent();

    if (project.id != id) {
      throw const FormatException('PROJECT_RESPONSE_ID_MISMATCH');
    }

    return project;
  }

  @override
  Future<void> updateBlock(
    models.ProjectsUnavailabilityUpdateInput input,
  ) async {
    checkUpdate();

    if (input.id.isEmpty) {
      throw const FormatException('PROJECT_BLOCK_ID_REQUIRED');
    }

    final result = await session.write(
      ApiMutations.projectsUnavailabilityUpdate,
      input,
    );

    checkCurrent();

    if (!result.success) {
      throw const FormatException('INVALID_PROJECT_BLOCK_UPDATE_RESULT');
    }

  }

  @override
  Future<void> deleteBlock(String id) async {
    checkDelete();

    if (id.isEmpty) {
      throw const FormatException('PROJECT_BLOCK_ID_REQUIRED');
    }

    final input = models.ProjectsUnavailabilityDeleteInput(id: id);

    final result = await session.write(
      ApiMutations.projectsUnavailabilityDelete,
      input,
    );

    checkCurrent();

    if (!result.success) {
      throw const FormatException('INVALID_PROJECT_BLOCK_DELETE_RESULT');
    }

  }
}

DateTime _civilDay(DateTime value) {
  return DateTime.utc(value.year, value.month, value.day);
}
