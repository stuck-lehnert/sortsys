import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/contract.dart';
import 'package:sortsys_client/api/procedure.dart';
import 'package:sortsys_client/features/products/product_form_reads.dart';

void main() {
  test(
    'product form lookups use actual undefined queries and immutable units',
    () async {
      final reads = _Reads()..response = 42;
      final repository = _repository(reads);

      expect(await repository.suggestNumber(), 42);
      reads.response = <String>['kg', ' bag '];

      final units = await repository.units();

      expect(units, ['kg', ' bag ']);
      expect(() => units.add('other'), throwsUnsupportedError);
      expect(reads.requests.map((request) => request.$1), [
        'products.suggestNextCustomId',
        'products.units.list',
      ]);
      expect(
        reads.requests.every((request) => identical(request.$2, rpcUndefined)),
        isTrue,
      );
    },
  );

  test(
    'product form lookups enforce scope and both roles before and after reads',
    () async {
      for (final change in ['view:products', 'manage:products', 'scope']) {
        final reads = _Reads();
        final permissions = {'view:products', 'manage:products'};
        var current = true;
        final repository = ProductFormReads(
          read: reads.read,
          isCurrent: () {
            return current;
          },
          can: permissions.contains,
        );

        if (change == 'scope') {
          current = false;
        } else {
          permissions.remove(change);
        }

        await expectLater(repository.suggestNumber(), throwsStateError);
        await expectLater(repository.units(), throwsStateError);
        expect(reads.requests, isEmpty);
      }

      for (final suggestion in [true, false]) {
        for (final change in ['view:products', 'manage:products', 'scope']) {
          final pending = Completer<Object?>();
          final reads = _Reads()..response = pending.future;
          final permissions = {'view:products', 'manage:products'};
          var current = true;
          final repository = ProductFormReads(
            read: reads.read,
            isCurrent: () {
              return current;
            },
            can: permissions.contains,
          );

          final result = suggestion
              ? repository.suggestNumber()
              : repository.units();

          if (change == 'scope') {
            current = false;
          } else {
            permissions.remove(change);
          }

          pending.complete(suggestion ? 42 : <String>['kg']);
          await expectLater(result, throwsStateError);
        }
      }
    },
  );

  test(
    'number suggestions preserve zero no-change and reject invalid results',
    () async {
      final reads = _Reads()..response = 0;
      final repository = _repository(reads);

      expect(await repository.suggestNumber(), isNull);

      for (final value in <num>[-1, 1.5, double.infinity, 2147483648]) {
        reads.response = value;

        await expectLater(repository.suggestNumber(), throwsFormatException);
      }
    },
  );
}

ProductFormReads _repository(_Reads reads) {
  return ProductFormReads(
    read: reads.read,
    isCurrent: () {
      return true;
    },
    can: (permission) {
      return permission == 'view:products' || permission == 'manage:products';
    },
  );
}

class _Reads {
  Object? response;
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
