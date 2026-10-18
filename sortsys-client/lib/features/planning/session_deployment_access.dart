import 'dart:convert';

import '../../api/generated/api.g.dart';
import '../../api/generated/models.g.dart' as models;
import '../../state/session_controller.dart';
import 'deployment_write_coordinator.dart';
import 'planning_view.dart';

final class SessionDeploymentAccess implements DeploymentWriteAccess {
  SessionDeploymentAccess(
    SessionController session, {
    bool Function()? isActive,
  }) : this._(session, isActive);

  SessionDeploymentAccess._(this.session, this._isActive)
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
    final info = session.info;
    final canManage = info?.can('manage:projectDeployments') == true;
    final canReadAll = info?.can('view:projectDeployments') == true;
    final active = _isActive?.call() ?? true;

    if (!active ||
        !session.authenticated ||
        session.binding != _binding ||
        session.instance == null ||
        !canManage ||
        !canReadAll) {
      throw StateError('DEPLOYMENT_WRITE_SCOPE_CHANGED');
    }
  }

  @override
  Future<models.Deployment?> getDeployment(
    String id, {
    required DateTime from,
    required DateTime to,
  }) async {
    checkCurrent();

    if (id.isEmpty || !from.isBefore(to)) {
      throw const FormatException('INVALID_DEPLOYMENT_READ_WINDOW');
    }

    final input = planningListInput(
      (from: from, toExclusive: to),
      userId: session.info!.userId,
      canViewAll: true,
    );

    // No user/since filter: moved owners and unchanged rows remain observable.
    final records = await session.read(
      ApiQueries.projectsDeploymentsList,
      input,
    );
    checkCurrent();

    models.Deployment? match;

    for (final record in records) {
      if (record.id != id) {
        continue;
      }

      if (match != null) {
        throw const FormatException('DUPLICATE_DEPLOYMENT_RESPONSE_ID');
      }

      match = record;
    }

    return match;
  }

  Future<models.User?> initialUser(String? id) async {
    checkCurrent();

    if (id == null) {
      return null;
    }

    final user = await session.read(
      ApiQueries.usersGet,
      models.UsersGetInput(id: id),
    );
    checkCurrent();

    if (user.id != id) {
      throw const FormatException('USER_RESPONSE_ID_MISMATCH');
    }

    return user;
  }

  Future<models.Project?> initialProject(String? id) async {
    checkCurrent();

    if (id == null) {
      return null;
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
  Future<String> createDeployment(
    models.ProjectsDeploymentsCreateInput input,
  ) async {
    checkCurrent();

    final result = await session.write(
      ApiMutations.projectsDeploymentsCreate,
      input,
    );
    checkCurrent();

    if (result.id.isEmpty) {
      throw const FormatException('INVALID_DEPLOYMENT_CREATE_RESULT');
    }

    return result.id;
  }

  @override
  Future<void> updateDeployment(
    models.ProjectsDeploymentsUpdateInput input,
  ) async {
    checkCurrent();

    final result = await session.write(
      ApiMutations.projectsDeploymentsUpdate,
      input,
    );
    checkCurrent();

    if (!result.success) {
      throw const FormatException('INVALID_DEPLOYMENT_UPDATE_RESULT');
    }
  }
}
