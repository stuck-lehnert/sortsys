import '../../api/generated/api.g.dart';
import '../../api/generated/models.g.dart' as models;
import 'user_read_repository.dart';

final class UserDetailReads {
  UserDetailReads({
    required this.userId,
    required this.read,
    required this.isCurrent,
    required this.canView,
  });

  final String userId;
  final UserRead read;
  final bool Function() isCurrent;
  final bool Function() canView;

  void _checkScope() {
    if (userId.isEmpty || !isCurrent() || !canView()) {
      throw StateError('USER_DETAIL_SCOPE_CHANGED');
    }
  }

  Future<models.User> _get(String id) async {
    _checkScope();

    if (id.isEmpty) {
      throw StateError('EMPTY_USER_REFERENCE');
    }

    final user = await read(ApiQueries.usersGet, models.UsersGetInput(id: id));

    _checkScope();

    if (user.id != id) {
      throw StateError('USER_REFERENCE_MISMATCH');
    }

    return user;
  }

  Future<models.User> get() {
    return _get(userId);
  }

  Future<models.User> supervisor(String supervisorId) {
    return _get(supervisorId);
  }
}
