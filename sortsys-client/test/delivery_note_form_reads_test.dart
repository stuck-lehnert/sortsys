import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/api.g.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/api/model.dart';
import 'package:sortsys_client/api/procedure.dart';
import 'package:sortsys_client/features/delivery_notes/delivery_note_form_reads.dart';

void main() {
  test(
    'delivery form searches preserve input order and assigned projects',
    () async {
      final reads = _Reads();
      final permissions = {'manage:deliveryNotes', 'view:products'};
      final repository = _repository(reads, permissions);
      final projects = [_project('second'), _project('first')];
      reads.response = projects;
      final result = await repository.projects(' A&/B ');

      expect(result, orderedEquals(projects));
      expect(() => result.clear(), throwsUnsupportedError);
      expect(reads.requests.single.$1, ApiQueries.projectsList.path);
      expect(reads.requests.single.$2, {'search': ' A&/B '});
      final products = [_product('second'), _product('first')];
      reads.response = products;
      final productResult = await repository.products('');

      expect(productResult, orderedEquals(products));
      expect(() => productResult.clear(), throwsUnsupportedError);
      expect(reads.requests.last.$1, ApiQueries.productsList.path);
      expect(reads.requests.last.$2, {'search': ''});
      projects.clear();
      products.clear();

      expect(result, hasLength(2));
      expect(productResult, hasLength(2));
    },
  );

  test(
    'delivery form lookups reject stale or denied scope before dispatch',
    () async {
      for (final kind in ['projects', 'products']) {
        for (final current in [false, true]) {
          final reads = _Reads();
          final repository = _repository(
            reads,
            current ? <String>{} : {'manage:deliveryNotes', 'view:products'},
            isCurrent: () {
              return current;
            },
          );

          await expectLater(_invoke(repository, kind), throwsStateError);
          expect(reads.requests, isEmpty);
        }
      }

      final reads = _Reads();
      final repository = _repository(reads, {'manage:deliveryNotes'});

      await expectLater(repository.products(''), throwsStateError);
      expect(reads.requests, isEmpty);
    },
  );

  test(
    'delivery form awaited searches reject changed scope and roles',
    () async {
      for (final kind in ['projects', 'products']) {
        for (final change in ['session', 'manage', 'product']) {
          final pending = Completer<Object?>();
          final reads = _Reads()..response = pending.future;
          final permissions = {'manage:deliveryNotes', 'view:products'};
          var current = true;
          final repository = _repository(
            reads,
            permissions,
            isCurrent: () {
              return current;
            },
          );
          final result = _invoke(repository, kind);

          if (change == 'session') {
            current = false;
          } else if (change == 'manage' || kind == 'projects') {
            permissions.remove('manage:deliveryNotes');
          } else {
            permissions.remove('view:products');
          }

          pending.complete(
            kind == 'projects' ? [_project('p')] : [_product('p')],
          );
          await expectLater(result, throwsStateError);
        }
      }
    },
  );

  test(
    'delivery form project search rejects changed global visibility',
    () async {
      for (final global in [false, true]) {
        final pending = Completer<Object?>();
        final reads = _Reads()..response = pending.future;
        final permissions = {
          'manage:deliveryNotes',
          if (global) 'view:projects',
        };
        final repository = _repository(reads, permissions);
        final result = repository.projects('');

        if (global) {
          permissions.remove('view:projects');
        } else {
          permissions.add('view:projects');
        }

        pending.complete([_project('p')]);
        await expectLater(result, throwsStateError);
      }
    },
  );
}

DeliveryNoteFormReads _repository(
  _Reads reads,
  Set<String> permissions, {
  bool Function()? isCurrent,
}) {
  bool current() {
    return true;
  }

  return DeliveryNoteFormReads(
    read: reads.read,
    isCurrent: isCurrent ?? current,
    can: permissions.contains,
  );
}

Future<Object> _invoke(DeliveryNoteFormReads repository, String kind) {
  if (kind == 'projects') {
    return repository.projects('query');
  }

  return repository.products('query');
}

models.Project _project(String id) {
  return models.Project(
    id: id,
    title: id,
    createdAt: DateTime.utc(2025),
    modifiedAt: DateTime.utc(2025),
  );
}

models.Product _product(String id) {
  return models.Product(
    id: id,
    customId: 0,
    name: id,
    baseUnit: 'kg',
    otherUnits: models.ApplyPriceImportRowOtherUnits(const {}),
    categories: const [],
  );
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
