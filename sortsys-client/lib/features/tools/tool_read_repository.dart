import '../../api/generated/api.g.dart';
import '../../api/generated/models.g.dart' as models;
import '../../api/model.dart';
import '../../api/procedure.dart';

typedef ToolRead = Future<O> Function<I, O>(RpcQuery<I, O> query, I input);

final class ToolReadRepository {
  ToolReadRepository({
    required this.toolId,
    required this.read,
    required this.isCurrent,
    required this.can,
  });

  final String toolId;
  final ToolRead read;
  final bool Function() isCurrent;
  final bool Function(String permission) can;

  void _check(String permission) {
    if (toolId.isEmpty) {
      throw const FormatException('INVALID_TOOL_ID');
    }

    if (!isCurrent() || !can('view:tools') || !can(permission)) {
      throw StateError('TOOL_READ_SCOPE_CHANGED');
    }
  }

  Future<models.Tool> get() async {
    _check('view:tools');

    final tool = await read(
      ApiQueries.toolsGet,
      models.ToolsGetInput(id: toolId),
    );
    _check('view:tools');

    if (tool.id != toolId) {
      throw const FormatException('TOOL_RESPONSE_ID_MISMATCH');
    }

    return tool;
  }

  Future<List<models.ToolsInventoriesListResultItem>> inventories() async {
    _check('view:toolInventories');

    final rows = await read(
      ApiQueries.toolsInventoriesList,
      models.ToolsInventoriesListInput(toolId: RpcOptional.value(toolId)),
    );
    _check('view:toolInventories');

    for (final row in rows) {
      if (row.toolId != toolId) {
        throw const FormatException('TOOL_INVENTORY_RESPONSE_ID_MISMATCH');
      }
    }

    return rows;
  }

  Future<models.User> userReference(String userId) async {
    _check('view:users');

    if (userId.isEmpty) {
      throw const FormatException('INVALID_BOOKING_USER_ID');
    }

    final user = await read(
      ApiQueries.usersGet,
      models.UsersGetInput(id: userId),
    );
    _check('view:users');

    if (user.id != userId) {
      throw const FormatException('BOOKING_USER_RESPONSE_MISMATCH');
    }

    return user;
  }

  Future<models.Project> projectReference(String projectId) async {
    _check('view:tools');

    if (projectId.isEmpty) {
      throw const FormatException('INVALID_BOOKING_PROJECT_ID');
    }

    final canViewAll = can('view:projects');
    final project = await read(
      ApiQueries.projectsGet,
      models.ProjectsGetInput(id: projectId),
    );
    _check('view:tools');

    if (can('view:projects') != canViewAll) {
      throw StateError('BOOKING_PROJECT_VISIBILITY_CHANGED');
    }

    if (project.id != projectId) {
      throw const FormatException('BOOKING_PROJECT_RESPONSE_MISMATCH');
    }

    return project;
  }

  Future<List<models.ToolsTrackingsListResultItem>> trackings() async {
    _check('view:tools');

    final canViewAll = can('view:toolTrackings');
    final rows = await read(
      ApiQueries.toolsTrackingsList,
      models.ToolsTrackingsListInput(toolId: RpcOptional.value(toolId)),
    );
    _check('view:tools');

    // Responsible users retain the server's restricted tracking visibility.
    if (can('view:toolTrackings') != canViewAll) {
      throw StateError('TOOL_TRACKING_VISIBILITY_CHANGED');
    }

    for (final row in rows) {
      if (row.toolId != toolId) {
        throw const FormatException('TOOL_TRACKING_RESPONSE_ID_MISMATCH');
      }
    }

    return rows;
  }
}
