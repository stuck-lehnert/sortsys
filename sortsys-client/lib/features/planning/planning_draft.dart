import '../../api/generated/models.g.dart' as models;
import '../../api/model.dart';
import '../../domain/planning.dart';

final class DeploymentDraft {
  DeploymentDraft({
    required Iterable<String> userIds,
    required this.projectId,
    required this.from,
    required this.to,
    this.note = '',
  }) : userIds = List.unmodifiable(userIds);

  final List<String> userIds;
  final String projectId;
  final DateTime from;
  final DateTime to;
  final String note;

  void validate() {
    final missingUser =
        userIds.isEmpty ||
        userIds.any((id) {
          return id.trim().isEmpty;
        });

    if (missingUser || projectId.trim().isEmpty) {
      throw const FormatException('PLANNING_USER_AND_PROJECT_REQUIRED');
    }

    if (userIds.toSet().length != userIds.length) {
      throw const FormatException('DUPLICATE_PLANNING_USERS');
    }

    if (from.year < 100 || to.year < 100 || !from.isBefore(to)) {
      throw const FormatException('INVALID_DEPLOYMENT_PERIOD');
    }
  }

  List<models.ProjectsDeploymentsCreateInput> createInputs() {
    validate();

    final comment = _planningNote(note);
    final inputs = <models.ProjectsDeploymentsCreateInput>[];

    for (final userId in userIds) {
      inputs.add(
        models.ProjectsDeploymentsCreateInput(
          projectId: projectId,
          userId: userId,
          from: from,
          to: to,
          note: RpcOptional.value(comment),
        ),
      );
    }

    return List.unmodifiable(inputs);
  }

  models.ProjectsDeploymentsUpdateInput? updateInput(
    models.Deployment baseline,
  ) {
    validate();

    if (userIds.length != 1) {
      throw const FormatException('DEPLOYMENT_EDIT_REQUIRES_ONE_USER');
    }

    final userId = userIds.single;
    final comment = _planningNote(note);
    final projectChanged = projectId != baseline.projectId;
    final userChanged = userId != baseline.userId;
    final fromChanged = !from.isAtSameMomentAs(baseline.from);
    final toChanged = !to.isAtSameMomentAs(baseline.to);
    final noteChanged = comment != baseline.note;
    final unchanged =
        !projectChanged &&
        !userChanged &&
        !fromChanged &&
        !toChanged &&
        !noteChanged;

    if (unchanged) {
      return null;
    }

    final data = models.ProjectsDeploymentsUpdateRequestData(
      projectId: projectChanged
          ? RpcOptional.value(projectId)
          : const RpcOptional.absent(),
      userId: userChanged
          ? RpcOptional.value(userId)
          : const RpcOptional.absent(),
      from: fromChanged ? RpcOptional.value(from) : const RpcOptional.absent(),
      to: toChanged ? RpcOptional.value(to) : const RpcOptional.absent(),
      note: noteChanged
          ? RpcOptional.value(comment)
          : const RpcOptional.absent(),
    );

    return models.ProjectsDeploymentsUpdateInput(id: baseline.id, data: data);
  }
}

final class AbsenceDraft {
  const AbsenceDraft({
    required this.userId,
    required this.from,
    required this.to,
    required this.type,
    this.label = '',
    this.note = '',
  });

  final String userId;
  final DateTime from;
  final DateTime to;
  final models.UsersVacationsListResultItemType type;
  final String label;
  final String note;

  void validate() {
    _validateCivilPeriod(from, to);

    if (userId.trim().isEmpty) {
      throw const FormatException('ABSENCE_USER_REQUIRED');
    }

    final other = type == models.UsersVacationsListResultItemType.other;
    final name = label.trim();

    if (other && (name.isEmpty || name.length > 63)) {
      throw const FormatException('INVALID_ABSENCE_LABEL');
    }
  }

  models.UsersVacationsCreateInput createInput() {
    validate();

    final other = type == models.UsersVacationsListResultItemType.other;
    final name = other ? label.trim() : null;
    final comment = _planningNote(note);
    final first = startOfDay(from);
    final last = startOfDay(to);

    return models.UsersVacationsCreateInput(
      userId: RpcOptional.value(userId),
      from: first,
      to: last,
      type: RpcOptional.value(type),
      label: RpcOptional.value(name),
      note: RpcOptional.value(comment),
    );
  }
}

final class ProjectBlockDraft {
  const ProjectBlockDraft({
    required this.projectId,
    required this.from,
    required this.to,
    required this.reason,
    this.note = '',
  });

  final String projectId;
  final DateTime from;
  final DateTime to;
  final String reason;
  final String note;

  void validate() {
    _validateCivilPeriod(from, to);

    if (projectId.trim().isEmpty || reason.trim().isEmpty) {
      throw const FormatException('BLOCK_PROJECT_AND_REASON_REQUIRED');
    }
  }

  models.ProjectsUnavailabilityUpdateInput? updateInput(
    models.ProjectsUnavailabilityListResultItem baseline,
  ) {
    validate();

    final first = startOfDay(from);
    final last = startOfDay(to);
    final explanation = reason.trim();
    final comment = _planningNote(note);
    final projectChanged = projectId != baseline.projectId;
    final fromChanged = !_sameCivilDate(first, baseline.from);
    final toChanged = !_sameCivilDate(last, baseline.to);
    final reasonChanged = explanation != baseline.reason;
    final noteChanged = comment != baseline.note;
    final unchanged =
        !projectChanged &&
        !fromChanged &&
        !toChanged &&
        !reasonChanged &&
        !noteChanged;

    if (unchanged) {
      return null;
    }

    final data = models.ProjectsUnavailabilityUpdateRequestData(
      projectId: projectChanged
          ? RpcOptional.value(projectId)
          : const RpcOptional.absent(),
      from: fromChanged ? RpcOptional.value(first) : const RpcOptional.absent(),
      to: toChanged ? RpcOptional.value(last) : const RpcOptional.absent(),
      reason: reasonChanged
          ? RpcOptional.value(explanation)
          : const RpcOptional.absent(),
      note: noteChanged
          ? RpcOptional.value(comment)
          : const RpcOptional.absent(),
    );

    return models.ProjectsUnavailabilityUpdateInput(
      id: baseline.id,
      data: data,
    );
  }
}

String? _planningNote(String value) {
  final trimmed = value.trim();

  if (trimmed.isEmpty) {
    return null;
  }

  return trimmed;
}

void _validateCivilPeriod(DateTime from, DateTime to) {
  final first = startOfDay(from);
  final last = startOfDay(to);

  if (first.year < 100 || last.year < 100 || first.isAfter(last)) {
    throw const FormatException('INVALID_PLANNING_DATE_RANGE');
  }
}

bool _sameCivilDate(DateTime left, DateTime right) {
  return left.year == right.year &&
      left.month == right.month &&
      left.day == right.day;
}
