import 'dart:convert';

import '../../api/generated/api.g.dart';
import '../../api/generated/models.g.dart' as models;
import '../../state/session_controller.dart';
import 'deployment_delete_coordinator.dart';
import 'planning_view.dart';

final class SessionDeploymentDeleteAccess implements DeploymentDeleteAccess {
  SessionDeploymentDeleteAccess(
    SessionController session, {
    bool Function()? isActive,
  }) : this._(session, isActive);

  SessionDeploymentDeleteAccess._(this.session, this._isActive)
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
      throw StateError('DEPLOYMENT_DELETE_SCOPE_CHANGED');
    }
  }

  @override
  void checkDelete() {
    checkCurrent();

    if (session.info?.can('delete:projectDeployments') != true) {
      throw StateError('DEPLOYMENT_DELETE_NOT_ALLOWED');
    }
  }

  @override
  Future<models.Deployment?> getDeployment(models.Deployment baseline) async {
    checkDelete();

    if (baseline.id.isEmpty || !baseline.from.isBefore(baseline.to)) {
      throw const FormatException('INVALID_DEPLOYMENT_READ_WINDOW');
    }

    final info = session.info!;
    final input = planningListInput(
      (from: baseline.from, toExclusive: baseline.to),
      userId: info.userId,
      canViewAll: info.can('view:projectDeployments'),
    );

    final records = await session.read(
      ApiQueries.projectsDeploymentsList,
      input,
    );

    checkDelete();

    models.Deployment? match;

    for (final record in records) {
      if (record.id != baseline.id) {
        continue;
      }

      if (match != null) {
        throw const FormatException('DUPLICATE_DEPLOYMENT_RESPONSE_ID');
      }

      match = record;
    }

    // A missing bounded row remains a conflict, never deletion evidence.
    return match;
  }

  @override
  Future<void> deleteDeployment(String id) async {
    checkDelete();

    if (id.isEmpty) {
      throw const FormatException('DEPLOYMENT_ID_REQUIRED');
    }

    final input = models.ProjectsDeploymentsDeleteInput(id: id);

    final result = await session.write(
      ApiMutations.projectsDeploymentsDelete,
      input,
    );

    checkCurrent();

    if (!result.success) {
      throw const FormatException('INVALID_DEPLOYMENT_DELETE_RESULT');
    }
  }
}
