import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/features/customers/customer_draft.dart';
import 'package:sortsys_client/features/customers/customer_write.dart';
import 'package:sortsys_client/features/customers/secure_customer_receipts.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    // Keep receipt persistence inside the test plugin, never native storage.
    FlutterSecureStorage.setMockInitialValues({});
  });

  test(
    'secure customer receipts preserve base and relationship stages',
    () async {
      final store = SecureCustomerReceipts();

      for (final update in [false, true]) {
        final prepared = _receipt('origin|tenant|äctor', update: update);
        final acknowledged = prepared.advance(
          CustomerWriteStage.basePending,
          'customer',
        );
        final relationships = acknowledged.advance(
          CustomerWriteStage.contactsPending,
          'customer',
        );

        for (final receipt in [prepared, acknowledged, relationships]) {
          await store.write(receipt);

          expect((await store.read(receipt.scope))!.encode(), receipt.encode());
        }
      }
    },
  );

  test(
    'secure customer receipts isolate scopes and use targeted cleanup',
    () async {
      FlutterSecureStorage.setMockInitialValues({'unrelated': 'preserved'});

      final store = SecureCustomerReceipts();
      final first = _receipt('origin|tenant|actor');
      final other = _receipt('origin|tenant|other');

      await store.write(first);
      await store.write(other);
      await store.clear(first.scope);

      expect(await store.read(first.scope), isNull);
      expect((await store.read(other.scope))!.scope, other.scope);
      expect(
        await const FlutterSecureStorage().read(key: 'unrelated'),
        'preserved',
      );
      await expectLater(store.read(''), throwsFormatException);
      await expectLater(store.clear(''), throwsFormatException);
    },
  );

  test(
    'secure customer receipts reject malformed stages and inconsistent intent',
    () async {
      const scope = 'origin|tenant|actor';
      final key =
          'sortsys.customer_write.v1.${base64UrlEncode(utf8.encode(scope))}';
      final store = SecureCustomerReceipts();

      Map<String, dynamic> data() {
        return jsonDecode(_receipt(scope).encode()) as Map<String, dynamic>;
      }

      final missing = data()..remove('updateInput');
      final wrongTarget = data();
      (wrongTarget['target'] as Map<String, dynamic>)['name'] = ' Raw ';
      final mismatchedCreate = data();
      (mismatchedCreate['createInput'] as Map<String, dynamic>)['name'] =
          'Other';
      final wrongUpdate = data()
        ..['createInput'] = null
        ..['customerId'] = 'customer'
        ..['updateInput'] = {
          'id': 'customer',
          'data': {'name': 'Other'},
        };

      for (final encoded in [
        _receipt('foreign').encode(),
        jsonEncode(missing),
        jsonEncode(data()..['nonce'] = 'short'),
        jsonEncode(data()..['stage'] = 'unknown'),
        jsonEncode(data()..['contactIds'] = ['contact', 'contact']),
        jsonEncode(data()..['contactIds'] = ['']),
        jsonEncode(wrongTarget),
        jsonEncode(mismatchedCreate),
        jsonEncode(wrongUpdate),
        '{bad',
        List.filled(131073, 'x').join(),
      ]) {
        FlutterSecureStorage.setMockInitialValues({key: encoded});

        await expectLater(store.read(scope), throwsFormatException);
      }
    },
  );
}

CustomerWriteReceipt _receipt(String scope, {bool update = false}) {
  final draft = CustomerDraft(name: 'After', contactIds: ['contact']);
  final baseline = models.Customer(
    id: 'customer',
    name: 'Before',
    phoneNumbers: const [],
    emailAddresses: const [],
    createdAt: DateTime(2024),
    modifiedAt: DateTime(2024),
  );

  return CustomerWriteReceipt(
    scope: scope,
    nonce: '0123456789abcdef0123456789abcdef',
    stage: CustomerWriteStage.basePending,
    target: draft.createInput(),
    createInput: update ? null : draft.createInput(),
    updateInput: update ? draft.updateInput(baseline) : null,
    customerId: update ? baseline.id : null,
    contactIds: const ['contact'],
    baselineContactIds: const [],
  );
}
