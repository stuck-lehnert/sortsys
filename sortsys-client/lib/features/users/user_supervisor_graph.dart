import '../../api/generated/models.g.dart' as models;
import 'user_list_state.dart';

final class UserSupervisorGraph {
  UserSupervisorGraph._({
    required this.users,
    required this.roots,
    required this.cycleRoots,
    required this.children,
    required this.expandableIds,
  });

  factory UserSupervisorGraph(
    List<models.User> users, {
    required Comparator<String> compareNames,
  }) {
    final indexed = users.indexed.toList();

    indexed.sort((left, right) {
      final comparison = compareNames(
        userListName(left.$2),
        userListName(right.$2),
      );

      if (comparison != 0) {
        return comparison;
      }

      return left.$1.compareTo(right.$1);
    });

    final sorted = [for (final entry in indexed) entry.$2];
    final byId = <String, models.User>{};

    for (final user in sorted) {
      if (user.id.isEmpty || byId.containsKey(user.id)) {
        throw const FormatException('INVALID_SUPERVISOR_USER_IDENTITIES');
      }

      byId[user.id] = user;
    }

    final children = <String, List<models.User>>{};
    final roots = <models.User>[];

    for (final user in sorted) {
      final supervisorId = user.supervisorUserId;

      if (supervisorId == null ||
          supervisorId.isEmpty ||
          !byId.containsKey(supervisorId)) {
        roots.add(user);
        continue;
      }

      children
          .putIfAbsent(supervisorId, () {
            return <models.User>[];
          })
          .add(user);
    }

    final reachable = <String>{};
    final pending = List<models.User>.of(roots);

    while (pending.isNotEmpty) {
      final user = pending.removeLast();

      if (!reachable.add(user.id)) {
        continue;
      }

      pending.addAll(children[user.id] ?? const []);
    }

    return UserSupervisorGraph._(
      users: List.unmodifiable(sorted),
      roots: List.unmodifiable(roots),
      cycleRoots: List.unmodifiable([
        for (final user in sorted)
          if (!reachable.contains(user.id)) user,
      ]),
      children: Map.unmodifiable({
        for (final entry in children.entries)
          entry.key: List<models.User>.unmodifiable(entry.value),
      }),
      expandableIds: Set.unmodifiable(children.keys),
    );
  }

  final List<models.User> users;
  final List<models.User> roots;
  final List<models.User> cycleRoots;
  final Map<String, List<models.User>> children;
  final Set<String> expandableIds;

  models.User? defaultSupervisor(String? id) {
    for (final user in users) {
      if (user.id == id) {
        return user;
      }
    }

    return null;
  }

  bool allExpanded(Set<String> expandedIds) {
    return expandableIds.isNotEmpty &&
        expandableIds.every(expandedIds.contains);
  }

  Set<String> toggleAll(Set<String> expandedIds) {
    if (allExpanded(expandedIds)) {
      return <String>{};
    }

    return Set.of(expandableIds);
  }

  List<UserSupervisorRow> visibleRows(
    models.User root,
    Set<String> expandedIds,
  ) {
    final rows = <UserSupervisorRow>[];
    final pending = <_PendingNode>[_PendingNode(root, const {})];

    while (pending.isNotEmpty) {
      final next = pending.removeLast();
      final user = next.user;
      final cycle = next.path.contains(user.id);
      final directReports = children[user.id] ?? const <models.User>[];

      rows.add(
        UserSupervisorRow(
          user: user,
          depth: next.path.length,
          cycle: cycle,
          directReportCount: directReports.length,
        ),
      );

      if (cycle || !expandedIds.contains(user.id)) {
        continue;
      }

      final path = Set<String>.unmodifiable({...next.path, user.id});

      // Reverse the stack, not the sorted sibling order shown to the user.
      for (final child in directReports.reversed) {
        pending.add(_PendingNode(child, path));
      }
    }

    return List.unmodifiable(rows);
  }
}

final class UserSupervisorRow {
  const UserSupervisorRow({
    required this.user,
    required this.depth,
    required this.cycle,
    required this.directReportCount,
  });

  final models.User user;
  final int depth;
  final bool cycle;
  final int directReportCount;
}

final class _PendingNode {
  const _PendingNode(this.user, this.path);

  final models.User user;
  final Set<String> path;
}
