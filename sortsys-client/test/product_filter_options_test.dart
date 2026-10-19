import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/contract.dart';
import 'package:sortsys_client/api/procedure.dart';
import 'package:sortsys_client/features/products/product_filter_options.dart';

void main() {
  test(
    'product filter options use actual undefined queries and original labels',
    () async {
      final reads = _Reads()..response = ['ACME', ' acme ', 'Beta'];
      final options = ProductFilterOptions(
        read: reads.read,
        isCurrent: () {
          return true;
        },
        can: (permission) {
          return permission == 'view:products';
        },
      );

      final brands = await options.brands('Ac');
      final categories = await options.categories(' ac');

      expect(brands, ['ACME', ' acme ']);
      expect(categories, [' acme ']);
      expect(reads.requests.map((request) => request.$1), [
        'products.brands.list',
        'products.categories.list',
      ]);
      expect(
        reads.requests.every((request) => identical(request.$2, rpcUndefined)),
        isTrue,
      );
      expect(() => brands.add('other'), throwsUnsupportedError);
    },
  );

  test(
    'product filter options reject denied or stale scope before dispatch',
    () async {
      for (final deniedRole in [true, false]) {
        final reads = _Reads()..response = <String>[];
        final options = ProductFilterOptions(
          read: reads.read,
          isCurrent: () {
            return deniedRole;
          },
          can: (permission) {
            return !deniedRole;
          },
        );

        await expectLater(options.brands(''), throwsStateError);
        await expectLater(options.categories(''), throwsStateError);
        expect(reads.requests, isEmpty);
      }
    },
  );

  test(
    'product filter options reject scope changes during either read',
    () async {
      for (final brands in [true, false]) {
        final pending = Completer<Object?>();
        final reads = _Reads()..response = pending.future;
        var current = true;
        var permitted = true;
        final options = ProductFilterOptions(
          read: reads.read,
          isCurrent: () {
            return current;
          },
          can: (permission) {
            return permitted;
          },
        );

        final result = brands ? options.brands('') : options.categories('');

        if (brands) {
          current = false;
        } else {
          permitted = false;
        }

        pending.complete(<String>['ACME']);
        await expectLater(result, throwsStateError);
      }
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
