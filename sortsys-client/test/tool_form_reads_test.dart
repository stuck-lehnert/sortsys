import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/contract.dart';
import 'package:sortsys_client/api/generated/api.g.dart';
import 'package:sortsys_client/api/procedure.dart';
import 'package:sortsys_client/features/tools/tool_form_reads.dart';
import 'package:sortsys_client/features/tools/tool_rpc_access.dart';

void main() {
  test(
    'tool form reads use exact generated undefined queries and freeze raw options',
    () async {
      final fixture = _FormReads();
      final brands = <String>[' Brand ', 'brand', ' Brand ', '\ufeffBrand'];
      final categories = <String>['Drill', '', ' drill ', '\ufffd'];
      fixture.responses['tools.brands'] = brands;
      fixture.responses['tools.categories'] = categories;
      fixture.responses['tools.suggestNextCustomId'] = 42;

      final actualBrands = await fixture.repository.brands();
      final actualCategories = await fixture.repository.categories();
      final number = await fixture.repository.suggestNumber();

      brands.clear();
      categories.clear();

      expect(actualBrands, [' Brand ', 'brand', ' Brand ', '\ufeffBrand']);
      expect(actualCategories, ['Drill', '', ' drill ', '\ufffd']);
      expect(number, 42);
      expect(() {
        actualBrands.add('other');
      }, throwsUnsupportedError);
      expect(() {
        actualCategories.clear();
      }, throwsUnsupportedError);

      expect(fixture.requests, hasLength(3));
      expect(fixture.requests[0].$1, same(ApiQueries.toolsBrands));
      expect(fixture.requests[1].$1, same(ApiQueries.toolsCategories));
      expect(fixture.requests[2].$1, same(ApiQueries.toolsSuggestNextCustomId));
      expect(
        fixture.requests.every((request) {
          return identical(request.$2, rpcUndefined);
        }),
        isTrue,
      );
      expect(fixture.writes, 0);
    },
  );

  test(
    'tool form reads reject lost owner and either role before any I/O',
    () async {
      for (final lookup in _Lookup.values) {
        for (final change in ['owner', 'view:tools', 'manage:tools']) {
          final fixture = _FormReads();
          fixture.revoke(change);

          await expectLater(
            _lookup(fixture.repository, lookup),
            _scopeFailure(change),
          );

          expect(fixture.requests, isEmpty);
          expect(fixture.writes, 0);
        }
      }
    },
  );

  test(
    'tool form reads reject lost owner and either role after every await',
    () async {
      for (final lookup in _Lookup.values) {
        for (final change in ['owner', 'view:tools', 'manage:tools']) {
          final pending = Completer<Object?>();
          final fixture = _FormReads();
          fixture.responses[lookup.path] = pending.future;

          final result = _lookup(fixture.repository, lookup);
          final rejected = expectLater(result, _scopeFailure(change));
          expect(fixture.requests, hasLength(1));

          fixture.revoke(change);
          pending.complete(lookup == _Lookup.number ? 42 : <String>['Private']);
          await rejected;

          expect(fixture.requests, hasLength(1));
          expect(fixture.writes, 0);
        }
      }
    },
  );

  test(
    'tool number suggestions preserve zero and exact positive i32 values',
    () async {
      final fixture = _FormReads();

      for (final value in <num>[0, -0.0, 1, 42.0, 2147483647]) {
        fixture.responses['tools.suggestNextCustomId'] = value;

        final number = await fixture.repository.suggestNumber();

        expect(number, value == 0 ? null : value.toInt());
        expect(number, value == 0 ? isNull : isA<int>());
      }

      expect(fixture.requests, hasLength(5));
      expect(fixture.writes, 0);
    },
  );

  test(
    'tool number suggestions never truncate round or accept nonfinite values',
    () async {
      final fixture = _FormReads();
      final invalid = <num>[
        -1,
        -double.minPositive,
        1.25,
        2147483647.5,
        2147483648,
        double.infinity,
        double.negativeInfinity,
        double.nan,
      ];

      for (final value in invalid) {
        fixture.responses['tools.suggestNextCustomId'] = value;

        await expectLater(
          fixture.repository.suggestNumber(),
          throwsA(
            isA<FormatException>().having(
              (error) {
                return error.message;
              },
              'message',
              'INVALID_TOOL_NUMBER_SUGGESTION',
            ),
          ),
        );
      }

      expect(fixture.requests, hasLength(invalid.length));
      expect(fixture.writes, 0);
    },
  );

  test(
    'tool number suggestions are create only but edit options remain available',
    () async {
      final fixture = _FormReads(toolId: 'tool');
      fixture.responses['tools.brands'] = <String>['Brand'];
      fixture.responses['tools.categories'] = <String>['Category'];

      await expectLater(
        fixture.repository.suggestNumber(),
        throwsA(
          isA<FormatException>().having(
            (error) {
              return error.message;
            },
            'message',
            'INVALID_TOOL_NUMBER_CONTEXT',
          ),
        ),
      );

      expect(fixture.requests, isEmpty);

      final brands = await fixture.repository.brands();
      final categories = await fixture.repository.categories();

      expect(brands, ['Brand']);
      expect(categories, ['Category']);
      expect(fixture.requests, hasLength(2));
      expect(fixture.writes, 0);
    },
  );

  test(
    'tool form reads retain transport errors and reject malformed option strings',
    () async {
      for (final lookup in _Lookup.values) {
        final failure = StateError('TRANSPORT_UNAVAILABLE');
        final pending = Completer<Object?>();
        final fixture = _FormReads();
        fixture.responses[lookup.path] = pending.future;

        final result = _lookup(fixture.repository, lookup);
        final rejected = expectLater(result, throwsA(same(failure)));

        pending.completeError(failure);
        await rejected;

        expect(fixture.requests, hasLength(1));
        expect(fixture.writes, 0);
      }

      for (final lookup in [_Lookup.brands, _Lookup.categories]) {
        for (final malformed in ['\ud800', '\udc00']) {
          final fixture = _FormReads();
          fixture.responses[lookup.path] = <String>['Valid', malformed];

          await expectLater(
            _lookup(fixture.repository, lookup),
            throwsA(
              isA<FormatException>().having(
                (error) {
                  return error.message;
                },
                'message',
                'INVALID_TOOL_FORM_SUGGESTIONS',
              ),
            ),
          );

          expect(fixture.requests, hasLength(1));
          expect(fixture.writes, 0);
        }
      }
    },
  );
}

enum _Lookup {
  brands('tools.brands'),
  categories('tools.categories'),
  number('tools.suggestNextCustomId');

  const _Lookup(this.path);

  final String path;
}

Future<Object?> _lookup(ToolFormReads repository, _Lookup lookup) {
  return switch (lookup) {
    _Lookup.brands => repository.brands(),
    _Lookup.categories => repository.categories(),
    _Lookup.number => repository.suggestNumber(),
  };
}

Matcher _scopeFailure(String change) {
  return throwsA(
    isA<StateError>().having(
      (error) {
        return error.message;
      },
      'message',
      change == 'manage:tools'
          ? 'TOOL_FORM_FORBIDDEN'
          : 'TOOL_WRITE_SCOPE_CHANGED',
    ),
  );
}

class _FormReads {
  _FormReads({this.toolId});

  final String? toolId;
  bool current = true;
  int writes = 0;
  final permissions = {'view:tools', 'manage:tools'};
  final responses = <String, Object?>{};
  final requests = <(Object, Object?)>[];

  late final repository = ToolFormReads(
    access: ToolRpcAccess(
      scope: jsonEncode(['https://example.test', 'tenant', 'actor', toolId]),
      toolId: toolId,
      read: read,
      write: write,
      isCurrent: () {
        return current;
      },
      can: permissions.contains,
    ),
  );

  void revoke(String change) {
    if (change == 'owner') {
      current = false;
    } else {
      permissions.remove(change);
    }
  }

  Future<O> read<I, O>(RpcQuery<I, O> query, I input) async {
    requests.add((query, input));

    final response = responses[query.path];

    if (response is Future<Object?>) {
      return await response as O;
    }

    return response as O;
  }

  Future<O> write<I, O>(RpcMutation<I, O> mutation, I input) async {
    writes++;

    throw StateError('UNEXPECTED_TOOL_FORM_WRITE');
  }
}
