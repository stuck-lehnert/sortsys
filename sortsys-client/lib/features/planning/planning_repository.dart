import '../../api/generated/api.g.dart';
import '../../api/generated/models.g.dart' as models;
import '../../api/model.dart';
import '../../api/procedure.dart';
import '../../domain/planning.dart';
import 'planning_data.dart';
import 'planning_view.dart';

typedef PlanningRead = Future<O> Function<I, O>(RpcQuery<I, O> query, I input);

enum PlanningSource { projects, users, deployments, absences, blocks }

final class PlanningLoad {
  const PlanningLoad({required this.data, required this.failures});

  final PlanningData data;
  final Map<PlanningSource, Object> failures;
}

final class PlanningRepository {
  const PlanningRepository({
    required this.identity,
    required this.currentUserId,
    required this.canViewAll,
    required this.canViewUsers,
    required this.read,
    required this.isCurrent,
  });

  final String identity;
  final String currentUserId;
  final bool canViewAll;
  final bool canViewUsers;
  final PlanningRead read;
  final bool Function() isCurrent;

  Future<PlanningLoad> load(
    PlanningRange range, {
    PlanningData? previous,
  }) async {
    _checkScope();

    final fallback = previous?.identity == identity
        ? previous!
        : PlanningData(identity: identity);
    var projects = fallback.projects;
    var users = fallback.users;
    var deployments = fallback.deployments;
    var absences = fallback.absences;
    var blocks = fallback.blocks;
    final failures = <PlanningSource, Object>{};

    const projectInput = models.ProjectsListInput();
    final userInput = models.UsersListInput(
      includeArchived: RpcOptional.value(canViewUsers),
      deactivated: canViewUsers
          ? const RpcOptional.absent()
          : const RpcOptional.value(false),
    );
    final deploymentInput = planningListInput(
      range,
      userId: currentUserId,
      canViewAll: canViewAll,
    );
    final inclusiveEnd = shiftDay(range.toExclusive, -1);
    final absenceInput = models.UsersVacationsListInput(
      from: RpcOptional.value(range.from),
      to: RpcOptional.value(inclusiveEnd),
      includeDenied: const RpcOptional.value(false),
    );
    final blockInput = models.ProjectsUnavailabilityListInput(
      from: RpcOptional.value(range.from),
      to: RpcOptional.value(inclusiveEnd),
    );

    // Full snapshots remove assignments deleted or moved by another user.
    // Changed-only responses without tombstones cannot prove either removal.
    // The API authorizes every source against the authenticated tenant/user.
    await Future.wait([
      _loadSource(PlanningSource.projects, failures, () async {
        projects = await read(ApiQueries.projectsList, projectInput);
      }),

      _loadSource(PlanningSource.users, failures, () async {
        // Without view:users, only active, nonarchived colleagues are requested.
        // The API additionally removes hourly costs from those authorized rows.
        users = await read(ApiQueries.usersList, userInput);
      }),

      _loadSource(PlanningSource.deployments, failures, () async {
        deployments = await read(
          ApiQueries.projectsDeploymentsList,
          deploymentInput,
        );
      }),

      _loadSource(PlanningSource.absences, failures, () async {
        // The API scopes role-free reads to the actor and supervised users.
        // Forcing actor-only here would hide legitimate supervised absences.
        absences = await read(ApiQueries.usersVacationsList, absenceInput);
      }),

      _loadSource(PlanningSource.blocks, failures, () async {
        blocks = await read(ApiQueries.projectsUnavailabilityList, blockInput);
      }),
    ]);

    _checkScope();

    final allowedDeployments = deployments.where((record) {
      return canViewAll || record.userId == currentUserId;
    });

    final data = PlanningData(
      identity: identity,
      projects: List.unmodifiable(projects),
      users: List.unmodifiable(users),
      deployments: List.unmodifiable(allowedDeployments),
      absences: List.unmodifiable(absences),
      blocks: List.unmodifiable(blocks),
    );

    return PlanningLoad(data: data, failures: Map.unmodifiable(failures));
  }

  Future<void> _loadSource(
    PlanningSource source,
    Map<PlanningSource, Object> failures,
    Future<void> Function() load,
  ) async {
    try {
      _checkScope();

      await load();

      _checkScope();
    } catch (error) {
      _checkScope();
      failures[source] = error;
    }

  }

  void _checkScope() {
    if (!isCurrent()) {
      throw StateError('STALE_PLANNING_SCOPE');
    }

  }
}
