import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/contract.dart';

void main() {
  final contract = ApiContract();

  group('Refactored contract validation', () {
    test('retains procedure kinds and rejects mismatched calls', () {
      expect(
        contract.require('auth.login', RpcKind.mutation).name,
        'auth.login',
      );
      expect(
        () => contract.require('auth.login', RpcKind.query),
        throwsFormatException,
      );
      expect(
        () => contract.require('missing.procedure', RpcKind.query),
        throwsFormatException,
      );
    });

    test('preserves finite-number and actual DateTime requirements', () {
      const number = <String, Object?>{'kind': 'number'};
      const date = <String, Object?>{'kind': 'date'};

      expect(() => contract.validate(number, 0), returnsNormally);
      expect(
        () => contract.validate(number, double.nan),
        throwsFormatException,
      );
      expect(
        () => contract.validate(date, DateTime.utc(2026)),
        returnsNormally,
      );
      expect(
        () => contract.validate(date, '2026-01-01T00:00:00Z'),
        throwsFormatException,
      );
    });

    test('preserves null, undefined and optional-field distinctions', () {
      const shape = <String, Object?>{
        'kind': 'object',
        'fields': {
          'required': {
            'optional': false,
            'type': {'kind': 'string'},
          },

          'optional': {
            'optional': true,
            'type': {'kind': 'string'},
          },
        },
      };

      expect(
        () => contract.validate(shape, {'required': 'value'}),
        returnsNormally,
      );
      expect(() => contract.validate(shape, {}), throwsFormatException);
      expect(
        () => contract.validate(shape, {'required': 'value', 'optional': null}),
        throwsFormatException,
      );
      expect(
        () => contract.validate({'kind': 'undefined'}, rpcUndefined),
        returnsNormally,
      );
      expect(
        () => contract.validate({'kind': 'undefined'}, null),
        throwsFormatException,
      );
    });

    test('preserves literal unions, arrays and records', () {
      const item = <String, Object?>{
        'kind': 'union',
        'variants': [
          {'kind': 'literal', 'value': 'available'},
          {'kind': 'literal', 'value': 'broken'},
        ],
      };
      const array = <String, Object?>{'kind': 'array', 'item': item};
      const record = <String, Object?>{'kind': 'record', 'item': item};

      expect(
        () => contract.validate(array, ['available', 'broken']),
        returnsNormally,
      );
      expect(() => contract.validate(array, ['other']), throwsFormatException);
      expect(
        () => contract.validate(record, {'tool': 'available'}),
        returnsNormally,
      );
      expect(
        () => contract.validate(record, {'tool': false}),
        throwsFormatException,
      );
    });

    test(
      'continues rejecting unexpected object fields and excessive depth',
      () {
        const shape = <String, Object?>{'kind': 'object', 'fields': {}};

        expect(
          () => contract.validate(shape, {'unexpected': 'value'}),
          throwsFormatException,
        );
        expect(
          () => contract.validate({'kind': 'unknown'}, null, 101),
          throwsFormatException,
        );
      },
    );
  });
}
