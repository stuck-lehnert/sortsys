import '../../api/generated/models.g.dart' as models;
import '../../domain/planning.dart';
import 'planning_state.dart';

final class PlanningData {
  PlanningData({
    required this.identity,
    this.projects = const [],
    this.users = const [],
    this.deployments = const [],
    this.absences = const [],
    this.blocks = const [],
  });

  final String identity;
  final List<models.Project> projects;
  final List<models.User> users;
  final List<models.Deployment> deployments;
  final List<models.UsersVacationsListResultItem> absences;
  final List<models.ProjectsUnavailabilityListResultItem> blocks;
}

final class PlanningRow {
  const PlanningRow({required this.id, required this.label});

  final String id;
  final String label;
}

final class PlannedDeployment {
  const PlannedDeployment({
    required this.record,
    required this.projectLabel,
    required this.userLabel,
  });

  final models.Deployment record;
  final String projectLabel;
  final String userLabel;

  DateTime get from {
    return record.from.toLocal();
  }

  DateTime get to {
    return record.to.toLocal();
  }
}

final class PlanningSegment {
  const PlanningSegment({
    required this.deployment,
    required this.from,
    required this.to,
    required this.absences,
    required this.blocks,
  });

  final PlannedDeployment deployment;
  final DateTime from;
  final DateTime to;
  final List<models.UsersVacationsListResultItem> absences;
  final List<models.ProjectsUnavailabilityListResultItem> blocks;

  bool get hasWarning {
    return absences.isNotEmpty || blocks.isNotEmpty;
  }
}

final class PlanningCell {
  const PlanningCell({
    this.deployments = const [],
    this.absences = const [],
    this.blocks = const [],
  });

  final List<PlanningSegment> deployments;
  final List<models.UsersVacationsListResultItem> absences;
  final List<models.ProjectsUnavailabilityListResultItem> blocks;

  bool get isEmpty {
    return deployments.isEmpty && absences.isEmpty && blocks.isEmpty;
  }
}

final class PlanningViewData {
  PlanningViewData({
    required this.data,
    required this.state,
    required this.rowMode,
    required this.currentUserId,
    required this.currentUserName,
    required this.canViewAll,
    required this.unknownProject,
    required this.unknownUser,
  });

  final PlanningData data;
  final PlanningState state;
  final PlanningRowMode rowMode;
  final String currentUserId;
  final String currentUserName;
  final bool canViewAll;
  final String unknownProject;
  final String unknownUser;

  late final Map<String, String> projectLabels = Map.unmodifiable({
    for (final project in data.projects) project.id: project.title,
  });

  late final Map<String, String> userLabels = Map.unmodifiable({
    currentUserId: currentUserName,
    for (final user in data.users) user.id: planningUserName(user),
  });

  late final List<PlannedDeployment> deployments = _planDeployments();
  late final List<PlanningRow> rows = _buildRows();
  late final List<PlanningRow> absenceRows = _buildAbsenceRows();

  List<PlannedDeployment> _planDeployments() {
    final range = state.range;
    final source = data.deployments.indexed.where((entry) {
      final record = entry.$2;
      final allowed = canViewAll || record.userId == currentUserId;
      final valid = record.from.isBefore(record.to);
      final visible = periodsOverlap(
        record.from,
        record.to,
        range.from,
        range.toExclusive,
      );

      return allowed && valid && visible;
    }).toList();

    source.sort((left, right) {
      final byTime = left.$2.from.compareTo(right.$2.from);

      if (byTime != 0) {
        return byTime;
      }

      return left.$1.compareTo(right.$1);
    });

    return List.unmodifiable([
      for (final entry in source)
        PlannedDeployment(
          record: entry.$2,
          projectLabel: projectLabels[entry.$2.projectId] ?? unknownProject,
          userLabel: userLabels[entry.$2.userId] ?? unknownUser,
        ),
    ]);
  }

  List<PlanningRow> _buildRows() {
    final candidates = <String, String>{};

    if (rowMode == PlanningRowMode.project) {
      candidates.addAll(projectLabels);

      for (final deployment in deployments) {
        candidates.putIfAbsent(deployment.record.projectId, () {
          return deployment.projectLabel;
        });
      }

      for (final period in data.blocks) {
        candidates.putIfAbsent(period.projectId, () {
          return projectLabels[period.projectId] ?? unknownProject;
        });
      }

    } else {
      if (canViewAll) {
        candidates.addAll(userLabels);
      } else {
        candidates[currentUserId] = currentUserName;
      }

      for (final deployment in deployments) {
        candidates.putIfAbsent(deployment.record.userId, () {
          return deployment.userLabel;
        });
      }

      for (final absence in data.absences) {
        candidates.putIfAbsent(absence.userId, () {
          return userLabels[absence.userId] ?? unknownUser;
        });
      }

    }

    final result = <PlanningRow>[];

    for (final entry in candidates.entries) {
      final row = PlanningRow(id: entry.key, label: entry.value);
      final content = cell(row.id, state.range.from, state.visibleEndExclusive);

      if (!state.showEmptyRows && content.isEmpty) {
        continue;
      }

      final query = state.normalizedSearch;
      final matchesLabel = row.label.toLowerCase().contains(query);
      final matchesAssignment = deployments.any((assignment) {
        final owner = rowMode == PlanningRowMode.project
            ? assignment.record.projectId
            : assignment.record.userId;

        if (owner != row.id) {
          return false;
        }

        final label = rowMode == PlanningRowMode.project
            ? assignment.userLabel
            : assignment.projectLabel;

        return label.toLowerCase().contains(query);
      });

      if (query.isNotEmpty && !matchesLabel && !matchesAssignment) {
        continue;
      }

      result.add(row);
    }

    return _orderedRows(result);
  }

  List<PlanningRow> _buildAbsenceRows() {
    if (rowMode != PlanningRowMode.project) {
      return const [];
    }

    final ids = <String>{};
    final result = <PlanningRow>[];
    final query = state.normalizedSearch;

    for (final absence in data.absences) {
      final visible = planningPeriodOverlaps(
        absence.from,
        absence.to,
        state.range.from,
        state.visibleEndExclusive,
      );
      final label = userLabels[absence.userId] ?? unknownUser;

      if (!visible || !label.toLowerCase().contains(query)) {
        continue;
      }

      if (ids.add(absence.userId)) {
        result.add(PlanningRow(id: absence.userId, label: label));
      }

    }

    return _orderedRows(result);
  }

  PlanningCell cell(
    String rowId,
    DateTime from,
    DateTime to, {
    bool absenceOnly = false,
  }) {
    final userRow = rowMode == PlanningRowMode.user || absenceOnly;
    final absences = <models.UsersVacationsListResultItem>[];
    final blocks = <models.ProjectsUnavailabilityListResultItem>[];
    final segments = <PlanningSegment>[];

    if (userRow) {
      for (final absence in data.absences) {
        final visible =
            absence.userId == rowId &&
            planningPeriodOverlaps(absence.from, absence.to, from, to);

        if (visible) {
          absences.add(absence);
        }

      }

    } else {
      for (final period in data.blocks) {
        final visible =
            period.projectId == rowId &&
            planningPeriodOverlaps(period.from, period.to, from, to);

        if (visible) {
          blocks.add(period);
        }

      }

    }

    if (!absenceOnly) {
      for (final item in deployments) {
        final owner = userRow ? item.record.userId : item.record.projectId;

        if (owner != rowId || !periodsOverlap(item.from, item.to, from, to)) {
          continue;
        }

        final start = item.from.isBefore(from) ? from : item.from;
        final end = item.to.isAfter(to) ? to : item.to;
        final warnings = _warnings(item, start, end);

        segments.add(
          PlanningSegment(
            deployment: item,
            from: start,
            to: end,
            absences: warnings.$1,
            blocks: warnings.$2,
          ),
        );
      }

    }

    return PlanningCell(
      deployments: List.unmodifiable(segments),
      absences: List.unmodifiable(absences),
      blocks: List.unmodifiable(blocks),
    );
  }

  (
    List<models.UsersVacationsListResultItem>,
    List<models.ProjectsUnavailabilityListResultItem>,
  )
  _warnings(PlannedDeployment deployment, DateTime from, DateTime to) {
    final absences = data.absences.where((absence) {
      return absence.userId == deployment.record.userId &&
          planningPeriodOverlaps(absence.from, absence.to, from, to);
    });

    final blocks = data.blocks.where((period) {
      return period.projectId == deployment.record.projectId &&
          planningPeriodOverlaps(period.from, period.to, from, to);
    });

    return (List.unmodifiable(absences), List.unmodifiable(blocks));
  }
}

List<PlanningRow> _orderedRows(List<PlanningRow> source) {
  source.sort((left, right) {
    final byLabel = left.label.toLowerCase().compareTo(
      right.label.toLowerCase(),
    );

    if (byLabel != 0) {
      return byLabel;
    }

    return left.id.compareTo(right.id);
  });

  return List.unmodifiable(source);
}

String planningUserName(models.User user) {
  final names = [user.firstName, user.lastName].whereType<String>();
  final present = names.where((name) {
    return name.isNotEmpty;
  });

  return present.join(' ');
}

bool planningPeriodOverlaps(
  DateTime from,
  DateTime to,
  DateTime windowFrom,
  DateTime windowTo,
) {
  final start = startOfDay(from.toLocal());
  final end = shiftDay(startOfDay(to.toLocal()), 1);

  if (!start.isBefore(end)) {
    return false;
  }

  return start.isBefore(windowTo) && end.isAfter(windowFrom);
}

String planningSegmentTime(
  PlanningSegment segment,
  DateTime windowFrom,
  DateTime windowTo,
) {
  final fullDay =
      segment.from.isAtSameMomentAs(windowFrom) &&
      segment.to.isAtSameMomentAs(windowTo);
  final start = planningTimeText(segment.from);
  final end = fullDay ? '23:59' : planningTimeText(segment.to);

  return '$start-$end';
}

int planningColorHue(String id) {
  final normalized = id.trim().toLowerCase();

  if (RegExp(r'^[0-9a-v]+$').hasMatch(normalized)) {
    final value = BigInt.parse(normalized, radix: 32);

    return (value % BigInt.from(360)).toInt();
  }

  var hash = 0;

  for (final unit in id.codeUnits) {
    hash = (hash * 31 + unit).toSigned(32);
  }

  return hash.abs() % 360;
}
