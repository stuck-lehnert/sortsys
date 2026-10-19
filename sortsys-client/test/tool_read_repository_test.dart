import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/api.g.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/api/model.dart';
import 'package:sortsys_client/api/procedure.dart';
import 'package:sortsys_client/features/tools/tool_read_repository.dart';

void main() {
  test('tool detail uses the exact generated identifier request', () async {
    final reads = _ToolReads()..response = _tool('tool-1');
    final result = await _repository(reads).get();

    expect(result, same(reads.response));
    expect(reads.requests.single.$1, ApiQueries.toolsGet.path);
    expect(reads.requests.single.$2, {'id': 'tool-1'});
  });

  test('invalid owner and stale or denied scope dispatch no request', () async {
    for (final (id, current, permissions, matcher) in [
      ('', true, {'view:tools'}, throwsFormatException),
      ('tool-1', false, {'view:tools'}, throwsStateError),
      ('tool-1', true, <String>{}, throwsStateError),
    ]) {
      final reads = _ToolReads();
      final repository = _repository(
        reads,
        toolId: id,
        permissions: permissions,
        isCurrent: () {
          return current;
        },
      );

      await expectLater(repository.get(), matcher);
      expect(reads.requests, isEmpty);
    }
  });

  test('wrong tool detail response is rejected', () async {
    final reads = _ToolReads()..response = _tool('other-tool');

    await expectLater(_repository(reads).get(), throwsFormatException);
  });

  test('changed session rejects an awaited detail response', () async {
    final pending = Completer<Object?>();
    final reads = _ToolReads()..response = pending.future;
    var current = true;
    final repository = _repository(
      reads,
      isCurrent: () {
        return current;
      },
    );
    final result = repository.get();
    current = false;
    pending.complete(_tool('tool-1'));

    await expectLater(result, throwsStateError);
  });

  test('revoked owner visibility rejects an awaited detail response', () async {
    final pending = Completer<Object?>();
    final reads = _ToolReads()..response = pending.future;
    final permissions = {'view:tools'};
    final repository = _repository(reads, permissions: permissions);
    final result = repository.get();
    permissions.clear();
    pending.complete(_tool('tool-1'));

    await expectLater(result, throwsStateError);
  });

  test('inventories use only the canonical tool filter', () async {
    final inventory = _inventory('tool-1');
    final reads = _ToolReads()..response = [inventory];
    final repository = _repository(
      reads,
      permissions: {'view:tools', 'view:toolInventories'},
    );
    final result = await repository.inventories();

    expect(result.single, same(inventory));
    expect(reads.requests.single.$1, ApiQueries.toolsInventoriesList.path);
    expect(reads.requests.single.$2, {'toolId': 'tool-1'});
  });

  test('inventory permission is required before and after the read', () async {
    final deniedReads = _ToolReads();
    await expectLater(
      _repository(deniedReads).inventories(),
      throwsStateError,
    );
    expect(deniedReads.requests, isEmpty);

    final pending = Completer<Object?>();
    final reads = _ToolReads()..response = pending.future;
    final permissions = {'view:tools', 'view:toolInventories'};
    final repository = _repository(reads, permissions: permissions);
    final result = repository.inventories();
    permissions.remove('view:toolInventories');
    pending.complete([_inventory('tool-1')]);

    await expectLater(result, throwsStateError);
  });

  test('inventories reject rows belonging to another tool', () async {
    final reads = _ToolReads()..response = [_inventory('other-tool')];
    final repository = _repository(
      reads,
      permissions: {'view:tools', 'view:toolInventories'},
    );

    await expectLater(repository.inventories(), throwsFormatException);
  });

  test('tracking reads preserve server-assigned visibility and full history', (
  ) async {
    final open = _tracking('tool-1');
    final finished = _tracking(
      'tool-1',
      endedAt: DateTime.utc(2026, 1, 2),
    );
    final reads = _ToolReads()..response = [open, finished];
    final result = await _repository(reads).trackings();

    expect(result, [open, finished]);
    expect(reads.requests.single.$1, ApiQueries.toolsTrackingsList.path);
    expect(reads.requests.single.$2, {'toolId': 'tool-1'});
  });

  test('changed global visibility rejects an awaited tracking snapshot', (
  ) async {
    for (final initiallyGlobal in [true, false]) {
      final pending = Completer<Object?>();
      final reads = _ToolReads()..response = pending.future;
      final permissions = {
        'view:tools',
        if (initiallyGlobal) 'view:toolTrackings',
      };
      final repository = _repository(reads, permissions: permissions);
      final result = repository.trackings();

      if (initiallyGlobal) {
        permissions.remove('view:toolTrackings');
      } else {
        permissions.add('view:toolTrackings');
      }

      pending.complete([_tracking('tool-1')]);
      await expectLater(result, throwsStateError);
    }
  });

  test('user references require explicit visibility before dispatch', () async {
    final denied = _ToolReads()..response = _user('user-1');
    await expectLater(
      _repository(denied).userReference('user-1'),
      throwsStateError,
    );
    expect(denied.requests, isEmpty);

    final reads = _ToolReads()..response = _user('user-1');
    final repository = _repository(
      reads,
      permissions: {'view:tools', 'view:users'},
    );
    final user = await repository.userReference('user-1');

    expect(user, same(reads.response));
    expect(reads.requests.single.$1, ApiQueries.usersGet.path);
    expect(reads.requests.single.$2, {'id': 'user-1'});
  });

  test('user references reject revoked owner or user visibility', () async {
    for (final revoked in ['view:tools', 'view:users']) {
      final pending = Completer<Object?>();
      final reads = _ToolReads()..response = pending.future;
      final permissions = {'view:tools', 'view:users'};
      final repository = _repository(reads, permissions: permissions);
      final result = repository.userReference('user-1');
      permissions.remove(revoked);
      pending.complete(_user('user-1'));

      await expectLater(result, throwsStateError);
    }
  });

  test('changed session rejects an awaited user reference', () async {
    final pending = Completer<Object?>();
    final reads = _ToolReads()..response = pending.future;
    var current = true;
    final repository = _repository(
      reads,
      permissions: {'view:tools', 'view:users'},
      isCurrent: () {
        return current;
      },
    );
    final result = repository.userReference('user-1');
    current = false;
    pending.complete(_user('user-1'));

    await expectLater(result, throwsStateError);
  });

  test('empty or mismatched user identifiers are rejected', () async {
    final reads = _ToolReads()..response = _user('other-user');
    final repository = _repository(
      reads,
      permissions: {'view:tools', 'view:users'},
    );

    await expectLater(repository.userReference(''), throwsFormatException);
    expect(reads.requests, isEmpty);
    await expectLater(
      repository.userReference('user-1'),
      throwsFormatException,
    );
    expect(reads.requests.single.$2, {'id': 'user-1'});
  });

  test('project references retain server-authorized assigned visibility', (
  ) async {
    final reads = _ToolReads()..response = _project('project-1');
    final project = await _repository(reads).projectReference('project-1');

    expect(project, same(reads.response));
    expect(reads.requests.single.$1, ApiQueries.projectsGet.path);
    expect(reads.requests.single.$2, {'id': 'project-1'});
  });

  test('project references reject empty or mismatched identifiers', () async {
    final reads = _ToolReads()..response = _project('other-project');
    final repository = _repository(reads);

    await expectLater(repository.projectReference(''), throwsFormatException);
    expect(reads.requests, isEmpty);
    await expectLater(
      repository.projectReference('project-1'),
      throwsFormatException,
    );
  });

  test('project references reject changed session, owner or broad visibility', (
  ) async {
    for (final change in ['session', 'owner', 'visibility']) {
      final pending = Completer<Object?>();
      final reads = _ToolReads()..response = pending.future;
      final permissions = {'view:tools', 'view:projects'};
      var current = true;
      final repository = _repository(
        reads,
        permissions: permissions,
        isCurrent: () {
          return current;
        },
      );
      final result = repository.projectReference('project-1');

      if (change == 'session') {
        current = false;
      } else if (change == 'owner') {
        permissions.remove('view:tools');
      } else {
        permissions.remove('view:projects');
      }

      pending.complete(_project('project-1'));
      await expectLater(result, throwsStateError);
    }
  });

  test('tracking reads reject another tool without filtering it silently', (
  ) async {
    final reads = _ToolReads()..response = [_tracking('other-tool')];

    await expectLater(_repository(reads).trackings(), throwsFormatException);
  });
}

ToolReadRepository _repository(
  _ToolReads reads, {
  String toolId = 'tool-1',
  Set<String>? permissions,
  bool Function()? isCurrent,
}) {
  final allowed = permissions ?? {'view:tools'};

  return ToolReadRepository(
    toolId: toolId,
    read: reads.read,
    isCurrent: isCurrent ?? () {
      return true;
    },
    can: (permission) {
      return allowed.contains(permission);
    },
  );
}

final class _ToolReads {
  Object? response;
  final requests = <(String, Object?)>[];

  Future<O> read<I, O>(RpcQuery<I, O> query, I input) async {
    requests.add((query.path, (input as RpcValue).toWire()));
    final result = await Future<Object?>.value(response);

    return result as O;
  }
}

models.Tool _tool(String id) {
  return models.Tool(
    id: id,
    customId: 1,
    brand: 'Makita',
    category: 'Bohrer',
    available: true,
    createdAt: DateTime.utc(2026, 1, 1),
    modifiedAt: DateTime.utc(2026, 1, 1),
  );
}

models.Project _project(String id) {
  return models.Project(
    id: id,
    title: 'Harbor extension',
    createdAt: DateTime.utc(2026, 1, 1),
    modifiedAt: DateTime.utc(2026, 1, 1),
  );
}

models.User _user(String id) {
  return models.User(
    id: id,
    firstName: 'Ada',
    lastName: 'Harbor',
    username: 'employee',
    contractType: models.UserContractType.fromWire('internal'),
    createdAt: DateTime.utc(2026, 1, 1),
    modifiedAt: DateTime.utc(2026, 1, 1),
  );
}

models.ToolsInventoriesListResultItem _inventory(String toolId) {
  return models.ToolsInventoriesListResultItem(
    id: 'inventory-1',
    toolId: toolId,
    createdAt: DateTime.utc(2026, 1, 1),
  );
}

models.ToolsTrackingsListResultItem _tracking(
  String toolId, {
  DateTime? endedAt,
}) {
  return models.ToolsTrackingsListResultItem(
    id: endedAt == null ? 'open' : 'finished',
    toolId: toolId,
    startedAt: DateTime.utc(2026, 1, 1),
    endedAt: endedAt,
  );
}
