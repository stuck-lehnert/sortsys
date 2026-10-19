import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/api.g.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/api/model.dart';
import 'package:sortsys_client/api/procedure.dart';
import 'package:sortsys_client/features/delivery_notes/delivery_note_reference_reads.dart';

void main() {
  test(
    'delivery references use exact typed requests and assigned projects',
    () async {
      final reads = _Reads();
      final repository = _repository(reads);
      final paths = [
        ApiQueries.productsGet.path,
        ApiQueries.usersGet.path,
        ApiQueries.projectsGet.path,
      ];

      for (final kind in ['product', 'author', 'project']) {
        reads.response = _response(kind, 'ref');
        final result = await _invoke(repository, kind, 'ref');

        expect(result, same(reads.response));
      }

      expect(reads.requests.map((request) => request.$1), paths);
      expect(reads.requests.map((request) => request.$2), [
        {'id': 'ref'},
        {'id': 'ref'},
        {'id': 'ref'},
      ]);
    },
  );

  test('delivery reference permissions are checked before dispatch', () async {
    for (final (kind, permissions) in [
      ('product', {'view:deliveryNotes'}),
      ('author', {'view:deliveryNotes'}),
      ('project', <String>{}),
      ('product', {'view:products'}),
      ('author', {'view:users'}),
    ]) {
      final reads = _Reads();
      final repository = _repository(reads, permissions: permissions);

      await expectLater(_invoke(repository, kind, 'ref'), throwsStateError);
      expect(reads.requests, isEmpty);
    }
  });

  test(
    'delivery references reject empty owners identifiers and wrong responses',
    () async {
      for (final kind in ['product', 'author', 'project']) {
        final reads = _Reads()..response = _response(kind, 'wrong');
        final emptyOwner = _repository(reads, noteId: '');

        await expectLater(_invoke(emptyOwner, kind, 'ref'), throwsStateError);
        expect(reads.requests, isEmpty);

        final repository = _repository(reads);

        await expectLater(_invoke(repository, kind, ''), throwsFormatException);
        expect(reads.requests, isEmpty);
        await expectLater(
          _invoke(repository, kind, 'ref'),
          throwsFormatException,
        );
        expect(reads.requests.single.$2, {'id': 'ref'});
      }
    },
  );

  test(
    'awaited delivery references reject stale scope and revoked permissions',
    () async {
      for (final kind in ['product', 'author', 'project']) {
        for (final change in ['session', 'owner', 'reference']) {
          final pending = Completer<Object?>();
          final reads = _Reads()..response = pending.future;
          final permissions = {
            'view:deliveryNotes',
            'view:products',
            'view:users',
          };
          var current = true;
          final repository = _repository(
            reads,
            permissions: permissions,
            isCurrent: () {
              return current;
            },
          );
          final result = _invoke(repository, kind, 'ref');

          if (change == 'session') {
            current = false;
          } else if (change == 'owner' || kind == 'project') {
            permissions.remove('view:deliveryNotes');
          } else {
            permissions.remove(
              kind == 'product' ? 'view:products' : 'view:users',
            );
          }

          pending.complete(_response(kind, 'ref'));
          await expectLater(result, throwsStateError);
        }
      }
    },
  );

  test(
    'delivery project references reject either global visibility change',
    () async {
      for (final global in [false, true]) {
        final pending = Completer<Object?>();
        final reads = _Reads()..response = pending.future;
        final permissions = {'view:deliveryNotes', if (global) 'view:projects'};
        final repository = _repository(reads, permissions: permissions);
        final result = repository.project('ref');

        if (global) {
          permissions.remove('view:projects');
        } else {
          permissions.add('view:projects');
        }

        pending.complete(_response('project', 'ref'));
        await expectLater(result, throwsStateError);
      }
    },
  );
}

DeliveryNoteReferenceReads _repository(
  _Reads reads, {
  String noteId = 'note',
  Set<String> permissions = const {
    'view:deliveryNotes',
    'view:products',
    'view:users',
  },
  bool Function()? isCurrent,
}) {
  return DeliveryNoteReferenceReads(
    noteId: noteId,
    read: reads.read,
    isCurrent: isCurrent ?? () => true,
    can: permissions.contains,
  );
}

Future<Object> _invoke(
  DeliveryNoteReferenceReads repository,
  String kind,
  String id,
) {
  return switch (kind) {
    'product' => repository.product(id),
    'author' => repository.author(id),
    _ => repository.project(id),
  };
}

Object _response(String kind, String id) {
  final timestamp = DateTime.utc(2024);

  return switch (kind) {
    'product' => models.Product(
      id: id,
      customId: 0,
      name: 'Product',
      baseUnit: 'kg',
      otherUnits: models.ApplyPriceImportRowOtherUnits(const {}),
      categories: const [],
    ),
    'author' => models.User(
      id: id,
      firstName: 'Ada',
      lastName: 'Harbor',
      username: 'ada',
      contractType: models.UserContractType.fromWire('internal'),
      createdAt: timestamp,
      modifiedAt: timestamp,
    ),
    _ => models.Project(
      id: id,
      title: 'Project',
      createdAt: timestamp,
      modifiedAt: timestamp,
    ),
  };
}

final class _Reads {
  Object? response;
  final requests = <(String, Object?)>[];

  Future<O> read<I, O>(RpcQuery<I, O> query, I input) async {
    requests.add((query.path, (input as RpcValue).toWire()));
    final result = await Future<Object?>.value(response);

    return result as O;
  }
}
