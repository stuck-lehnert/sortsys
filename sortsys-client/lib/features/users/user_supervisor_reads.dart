import '../../api/contract.dart' show rpcUndefined;
import '../../api/generated/api.g.dart';
import '../../api/generated/models.g.dart' as models;
import 'user_read_repository.dart' show UserRead;

final class UserSupervisorReads {
  const UserSupervisorReads({
    required this.read,
    required this.isCurrent,
    required this.canView,
  });

  final UserRead read;
  final bool Function() isCurrent;
  final bool Function() canView;

  void _checkScope() {
    if (!isCurrent() || !canView()) {
      throw StateError('USER_SUPERVISOR_SCOPE_CHANGED');
    }
  }

  Future<List<models.User>> users() async {
    _checkScope();

    final result = await read(
      ApiQueries.usersList,
      const models.UsersListInput(),
    );

    _checkScope();

    final identities = <String>{};

    for (final user in result) {
      if (user.id.isEmpty || !identities.add(user.id)) {
        throw const FormatException('INVALID_SUPERVISOR_USER_IDENTITIES');
      }
    }

    return List.unmodifiable(result);
  }

  Future<String?> defaultSupervisorId() async {
    _checkScope();

    final result = await read(
      ApiQueries.usersSupervisorsGetDefault,
      rpcUndefined,
    );

    _checkScope();

    return result.userId;
  }
}
