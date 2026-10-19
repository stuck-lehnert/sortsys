import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/api/procedure.dart';
import 'package:sortsys_client/features/users/user_tool_bookings_reads.dart';

void main() {
  test('user bookings send exact active owner filter and retain self access', () async {
    final reads = _Reads()..response = [_row()];
    final repository = _repository(reads);

    final rows = await repository.list();

    expect(reads.requests.single.$1, 'tools.trackings.list');
    expect((reads.requests.single.$2 as models.ToolsTrackingsListInput).toWire(), {
      'responsibleUserId': 'owner',
      'finished': false,
    });
    expect(rows.single.id, 'booking');
    expect(reads.global, isFalse);
    expect(() => rows.add(_row()), throwsUnsupportedError);
  });

  test('colleague booking reads preserve backend empty or global visibility', () async {
    final reads = _Reads()..actorId = 'actor';
    final repository = _repository(reads, owner: 'colleague');

    expect(await repository.list(), isEmpty);
    expect(reads.requests, hasLength(1));

    reads.response = [_row(responsible: 'colleague')];

    await expectLater(repository.list(), throwsFormatException);

    reads.global = true;

    expect((await repository.list()).single.responsibleUserId, 'colleague');
  });

  test('user bookings reject wrong owner, missing responsible and finished rows', () async {
    final reads = _Reads()..global = true;
    final repository = _repository(reads);

    for (final row in [
      _row(responsible: 'wrong'),
      _row(responsible: null),
      _row(ended: true),
    ]) {
      reads.response = [row];

      await expectLater(repository.list(), throwsFormatException);
    }
  });

  test('user bookings reject changed scope roles actor and visibility snapshots', () async {
    for (final change in ['scope', 'users', 'actor', 'global']) {
      final reads = _Reads();
      final repository = _repository(reads);

      if (change == 'scope') {
        reads.current = false;
      } else if (change == 'users') {
        reads.usersVisible = false;
      } else if (change == 'actor') {
        reads.actorId = '';
      }

      if (change != 'global') {
        await expectLater(repository.list(), throwsStateError);
        expect(reads.requests, isEmpty);
      }

      reads.current = true;
      reads.usersVisible = true;
      reads.actorId = 'owner';
      final pending = Completer<Object?>();
      reads.response = pending.future;

      final result = repository.list();

      if (change == 'scope') {
        reads.current = false;
      } else if (change == 'users') {
        reads.usersVisible = false;
      } else if (change == 'actor') {
        reads.actorId = 'next-actor';
      } else {
        reads.global = true;
      }

      pending.complete([_row()]);
      await expectLater(result, throwsStateError);
    }

    final empty = _Reads();

    await expectLater(_repository(empty, owner: '').list(), throwsStateError);
    expect(empty.requests, isEmpty);
  });
}

UserToolBookingsReads _repository(_Reads reads, {String owner = 'owner'}) {
  return UserToolBookingsReads(
    userId: owner,
    read: reads.read,
    isCurrent: () {
      return reads.current;
    },
    canViewUsers: () {
      return reads.usersVisible;
    },
    currentActorId: () {
      return reads.actorId;
    },
    canViewTrackings: () {
      return reads.global;
    },
  );
}

models.ToolsTrackingsListResultItem _row({
  String? responsible = 'owner',
  bool ended = false,
}) {
  return models.ToolsTrackingsListResultItem(
    id: 'booking',
    toolId: 'tool',
    responsibleUserId: responsible,
    startedAt: DateTime.utc(2024),
    endedAt: ended ? DateTime.utc(2025) : null,
  );
}

class _Reads {
  Object? response = <models.ToolsTrackingsListResultItem>[];
  bool current = true;
  bool usersVisible = true;
  String actorId = 'owner';
  bool global = false;
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
