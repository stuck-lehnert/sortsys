import '../../api/generated/api.g.dart';
import '../../api/generated/models.g.dart' as models;
import '../../api/procedure.dart';
import 'user_list_state.dart';

typedef UserRead = Future<O> Function<I, O>(RpcQuery<I, O> query, I input);

final class UserReadRepository {
  UserReadRepository({
    required this.read,
    required this.isCurrent,
    required this.canView,
  });

  final UserRead read;
  final bool Function() isCurrent;
  final bool Function() canView;

  void _checkScope() {
    if (!isCurrent() || !canView()) {
      throw StateError('USER_LIST_SCOPE_CHANGED');
    }
  }

  Future<List<models.User>> list(UserListState state) async {
    _checkScope();

    final users = await read(ApiQueries.usersList, state.input());

    _checkScope();

    return List.unmodifiable(users);
  }
}
