import '../../api/generated/api.g.dart';
import '../../api/generated/models.g.dart' as models;
import '../../api/model.dart';
import 'user_read_repository.dart';

final class UserToolBookingsReads {
  UserToolBookingsReads({
    required this.userId,
    required this.read,
    required this.isCurrent,
    required this.canViewUsers,
    required this.currentActorId,
    required this.canViewTrackings,
  });

  final String userId;
  final UserRead read;
  final bool Function() isCurrent;
  final bool Function() canViewUsers;
  final String Function() currentActorId;
  final bool Function() canViewTrackings;

  void _checkScope() {
    if (userId.isEmpty ||
        !isCurrent() ||
        !canViewUsers() ||
        currentActorId().isEmpty) {
      throw StateError('USER_BOOKINGS_SCOPE_CHANGED');
    }
  }

  Future<List<models.ToolsTrackingsListResultItem>> list() async {
    _checkScope();

    final actorId = currentActorId();
    final globalVisibility = canViewTrackings();
    final rows = await read(
      ApiQueries.toolsTrackingsList,
      models.ToolsTrackingsListInput(
        responsibleUserId: RpcOptional.value(userId),
        finished: const RpcOptional.value(false),
      ),
    );

    _checkScope();

    if (currentActorId() != actorId ||
        canViewTrackings() != globalVisibility) {
      throw StateError('USER_BOOKINGS_VISIBILITY_CHANGED');
    }

    if (rows.any((row) {
      return row.responsibleUserId != userId ||
          row.endedAt != null ||
          (!globalVisibility && row.responsibleUserId != actorId);
    })) {
      throw const FormatException('USER_BOOKINGS_RESPONSE_MISMATCH');
    }

    // A colleague's query may legitimately return no rows without global access.
    return List.unmodifiable(rows);
  }
}
