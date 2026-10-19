import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/contract.dart';
import 'package:sortsys_client/api/generated/api.g.dart';
import 'package:sortsys_client/api/procedure.dart';
import 'package:sortsys_client/features/tools/tool_filter_options.dart';

void main() {
  test('filter options use generated undefined inputs and preserve labels', (
  ) async {
    final source = ['Makita', 'Bosch', 'MAKITA', ' ma '];
    final reads = _FilterReads()..response = source;
    final options = _options(reads);
    final brands = await options.brands(' MA ');
    final categories = await options.categories('bosch');

    expect(brands, ['Makita', 'MAKITA', ' ma ']);
    expect(categories, ['Bosch']);
    expect(reads.requests.map((request) => request.$1), [
      ApiQueries.toolsBrands.path,
      ApiQueries.toolsCategories.path,
    ]);
    expect(reads.requests.every((request) {
      return identical(request.$2, rpcUndefined);
    }), isTrue);
    expect(() => brands.add('Other'), throwsUnsupportedError);
    expect(source, ['Makita', 'Bosch', 'MAKITA', ' ma ']);
  });

  test('denied or stale filter options dispatch no request', () async {
    for (final scope in [
      (current: true, allowed: false),
      (current: false, allowed: true),
    ]) {
      final reads = _FilterReads()..response = <String>[];
      final options = _options(
        reads,
        isCurrent: () {
          return scope.current;
        },
        can: (permission) {
          return scope.allowed && permission == 'view:tools';
        },
      );

      await expectLater(options.brands(''), throwsStateError);
      await expectLater(options.categories(''), throwsStateError);
      expect(reads.requests, isEmpty);
    }
  });

  test('revoked tool permission rejects either awaited option query', () async {
    for (final brands in [true, false]) {
      final pending = Completer<Object?>();
      final reads = _FilterReads()..response = pending.future;
      var allowed = true;
      final options = _options(reads, can: (permission) {
        return allowed && permission == 'view:tools';
      });
      final result = brands ? options.brands('') : options.categories('');
      allowed = false;
      pending.complete(<String>['Private option']);

      await expectLater(result, throwsStateError);
      expect(reads.requests, hasLength(1));
    }
  });

  test('changed session rejects either awaited option query', () async {
    for (final brands in [true, false]) {
      final pending = Completer<Object?>();
      final reads = _FilterReads()..response = pending.future;
      var current = true;
      final options = _options(reads, isCurrent: () {
        return current;
      });
      final result = brands ? options.brands('') : options.categories('');
      current = false;
      pending.complete(<String>['Previous session']);

      await expectLater(result, throwsStateError);
      expect(reads.requests, hasLength(1));
    }
  });
}

ToolFilterOptions _options(
  _FilterReads reads, {
  bool Function()? isCurrent,
  bool Function(String)? can,
}) {
  return ToolFilterOptions(
    read: reads.read,
    isCurrent: isCurrent ?? () {
      return true;
    },
    can: can ?? (permission) {
      return permission == 'view:tools';
    },
  );
}

final class _FilterReads {
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
