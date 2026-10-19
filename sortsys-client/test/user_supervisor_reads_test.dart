import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/contract.dart' show rpcUndefined;
import 'package:sortsys_client/api/generated/api.g.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/api/procedure.dart';
import 'package:sortsys_client/features/users/user_supervisor_reads.dart';

void main() {
  test('supervisor reads use exact empty and undefined inputs', () async {
    final fixture = _Fixture();

    final users = await fixture.repository.users();
    final defaultId = await fixture.repository.defaultSupervisorId();

    expect(fixture.calls, ['users.list', 'users.supervisors.getDefault']);
    expect(fixture.listInput?.toWire(), isEmpty);
    expect(fixture.defaultInput, same(rpcUndefined));
    expect(defaultId, 'supervisor');
    expect(users.single.id, 'supervisor');

    fixture.users.clear();

    expect(users.single.id, 'supervisor');
    expect(users.clear, throwsUnsupportedError);

    fixture.defaultId = null;

    expect(await fixture.repository.defaultSupervisorId(), isNull);
  });

  test(
    'supervisor reads enforce scope and visibility before and after I/O',
    () async {
      for (final revokeVisibility in [false, true]) {
        for (final defaultQuery in [false, true]) {
          final before = _Fixture();

          if (revokeVisibility) {
            before.visible = false;
          } else {
            before.current = false;
          }

          await expectLater(before.run(defaultQuery), throwsStateError);

          expect(before.calls, isEmpty);

          final after = _Fixture();
          after.afterRead = () {
            if (revokeVisibility) {
              after.visible = false;
            } else {
              after.current = false;
            }
          };

          await expectLater(after.run(defaultQuery), throwsStateError);

          expect(after.calls, hasLength(1));
        }
      }
    },
  );

  test(
    'supervisor reads reject ambiguous identities without inventing default',
    () async {
      for (final invalid in [
        [_user('')],
        [_user('same'), _user('same')],
      ]) {
        final fixture = _Fixture();
        fixture.users = invalid;

        await expectLater(fixture.repository.users(), throwsFormatException);
      }

      final fixture = _Fixture();
      fixture.defaultId = 'not-in-user-list';

      expect(
        await fixture.repository.defaultSupervisorId(),
        'not-in-user-list',
      );
      expect((await fixture.repository.users()).single.id, 'supervisor');
    },
  );

  test(
    'supervisor default and user-list failures remain independent',
    () async {
      final fixture = _Fixture();
      fixture.failDefault = true;

      await expectLater(
        fixture.repository.defaultSupervisorId(),
        throwsStateError,
      );

      expect((await fixture.repository.users()).single.id, 'supervisor');

      fixture.failDefault = false;
      fixture.failUsers = true;

      await expectLater(fixture.repository.users(), throwsStateError);

      expect(await fixture.repository.defaultSupervisorId(), 'supervisor');
    },
  );
}

final class _Fixture {
  final calls = <String>[];
  List<models.User> users = [_user('supervisor')];
  String? defaultId = 'supervisor';
  models.UsersListInput? listInput;
  Object? defaultInput;
  bool current = true;
  bool visible = true;
  bool failDefault = false;
  bool failUsers = false;
  void Function()? afterRead;

  late final repository = UserSupervisorReads(
    read: read,
    isCurrent: () {
      return current;
    },
    canView: () {
      return visible;
    },
  );

  Future<Object?> run(bool defaultQuery) async {
    if (defaultQuery) {
      return repository.defaultSupervisorId();
    }

    return repository.users();
  }

  Future<O> read<I, O>(RpcQuery<I, O> query, I input) async {
    calls.add(query.path);

    final Object output;

    if (query == ApiQueries.usersList) {
      listInput = input as models.UsersListInput;

      if (failUsers) {
        throw StateError('USER_LIST_FAILED');
      }

      output = users;
    } else {
      expect(query, same(ApiQueries.usersSupervisorsGetDefault));

      defaultInput = input;

      if (failDefault) {
        throw StateError('DEFAULT_SUPERVISOR_FAILED');
      }

      output = models.UsersSupervisorsGetDefaultOutput(userId: defaultId);
    }

    afterRead?.call();

    return output as O;
  }
}

models.User _user(String id) {
  return models.User(
    id: id,
    firstName: 'User',
    username: id,
    contractType: models.UserContractType.internal,
    createdAt: DateTime.utc(2024),
    modifiedAt: DateTime.utc(2024),
  );
}
