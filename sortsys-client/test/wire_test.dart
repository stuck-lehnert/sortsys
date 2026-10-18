import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/contract.dart';
import 'package:sortsys_client/api/wire.dart';

void main() {
  group('SuperJSON wire compatibility', () {
    test('encodes root undefined with the existing annotation', () {
      expect(serializeWire(rpcUndefined), {
        'json': null,
        'meta': {
          'values': ['undefined'],
        },
      });
    });

    test('round-trips UTC dates, bigint and undefined in nested arrays', () {
      final timestamp = DateTime.utc(2026, 3, 29, 1, 30);
      final source = <String, Object?>{
        'rows': [timestamp, BigInt.parse('9007199254740993'), rpcUndefined],
      };
      final decoded = jsonMap(deserializeWire(serializeWire(source)));
      final rows = decoded['rows']! as List<Object?>;

      expect(rows[0], timestamp);
      expect(rows[1], BigInt.parse('9007199254740993'));
      expect(rows[2], isA<RpcUndefined>());
    });

    test('preserves literal dots and backslashes in field names', () {
      final source = <String, Object?>{
        r'a.b\c': [BigInt.from(42)],
      };
      final envelope = serializeWire(source);
      final values = jsonMap(jsonMap(envelope['meta'])['values']);
      final decoded = jsonMap(deserializeWire(envelope));

      expect(values.keys.single, r'a\.b\\c.0');
      expect(decoded[r'a.b\c'], [BigInt.from(42)]);
    });

    test('rejects non-finite values before request construction', () {
      expect(() => serializeWire(double.nan), throwsFormatException);
      expect(() => serializeWire(double.infinity), throwsFormatException);
    });

    test('rejects unknown annotations and missing envelope data', () {
      expect(
        () => deserializeWire({
          'json': 'private',
          'meta': {
            'values': ['unsupported'],
          },
        }),
        throwsFormatException,
      );
      expect(() => deserializeWire({}), throwsFormatException);
    });

    test('rejects annotation paths outside the response tree', () {
      final envelope = {
        'json': {'rows': <Object?>[]},
        'meta': {
          'values': {
            'rows.2': ['Date'],
          },
        },
      };

      expect(() => deserializeWire(envelope), throwsFormatException);
    });
  });
}
