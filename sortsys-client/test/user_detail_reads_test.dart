import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/api/procedure.dart';
import 'package:sortsys_client/features/users/user_detail_reads.dart';

void main() {
  test('user detail and supervisor use actual exact-ID user reads', () async {
    final reads = _Reads()..response = _user('owner');
    final repository = _repository(reads);

    final owner = await repository.get();
    reads.response = _user('supervisor');

    final supervisor = await repository.supervisor('supervisor');

    expect(owner.id, 'owner');
    expect(supervisor.id, 'supervisor');
    expect(reads.requests.map((request) {
      return request.$1;
    }), ['users.get', 'users.get']);
    expect(reads.requests.map((request) {
      return (request.$2 as models.UsersGetInput).toWire();
    }), [{'id': 'owner'}, {'id': 'supervisor'}]);
  });

  test('user detail reads reject changed owner scope or visibility before and after await', () async {
    for (final reference in [false, true]) {
      for (final change in ['scope', 'permission']) {
        final reads = _Reads();
        final repository = _repository(reads);

        if (change == 'scope') {
          reads.current = false;
        } else {
          reads.allowed = false;
        }

        final blocked = reference
            ? repository.supervisor('supervisor')
            : repository.get();

        await expectLater(blocked, throwsStateError);
        expect(reads.requests, isEmpty);

        reads.current = true;
        reads.allowed = true;
        final pending = Completer<Object?>();
        reads.response = pending.future;

        final result = reference
            ? repository.supervisor('supervisor')
            : repository.get();

        if (change == 'scope') {
          reads.current = false;
        } else {
          reads.allowed = false;
        }

        pending.complete(_user(reference ? 'supervisor' : 'owner'));
        await expectLater(result, throwsStateError);
      }
    }
  });

  test('user detail reads reject empty selections and mismatched response IDs', () async {
    final reads = _Reads()..response = _user('wrong');
    final repository = _repository(reads);

    await expectLater(_repository(reads, owner: '').get(), throwsStateError);
    await expectLater(repository.supervisor(''), throwsStateError);
    expect(reads.requests, isEmpty);

    await expectLater(repository.get(), throwsStateError);
    await expectLater(repository.supervisor('supervisor'), throwsStateError);
    expect(reads.requests, hasLength(2));
  });
}

UserDetailReads _repository(_Reads reads, {String owner = 'owner'}) {
  return UserDetailReads(
    userId: owner,
    read: reads.read,
    isCurrent: () {
      return reads.current;
    },
    canView: () {
      return reads.allowed;
    },
  );
}

models.User _user(String id) {
  return models.User(
    id: id,
    firstName: 'Ada',
    username: id,
    contractType: models.UserContractType.internal,
    createdAt: DateTime.utc(2024),
    modifiedAt: DateTime.utc(2024),
  );
}

class _Reads {
  Object? response;
  bool current = true;
  bool allowed = true;
  final requests = <(String, Object?)>[];

  Future<O> read<I, O>(RpcQuery<I, O> query, I input) async {
    requests.add((query.path, input));

    final value = response;

    if (value is Future<Object?>) {
      return await value as O;
    }

    return value as O;
  }
}
