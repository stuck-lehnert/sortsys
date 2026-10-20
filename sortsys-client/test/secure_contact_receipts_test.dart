import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/features/contacts/contact_draft.dart';
import 'package:sortsys_client/features/contacts/contact_receipt.dart';
import 'package:sortsys_client/features/contacts/secure_contact_receipts.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    // Keep every plugin operation inside the in-memory test implementation.
    FlutterSecureStorage.setMockInitialValues({});
  });

  test(
    'secure contact receipts preserve create and edit durable stages',
    () async {
      final store = SecureContactReceipts();

      for (final update in [false, true]) {
        final prepared = _receipt('origin|tenant|äctor', update: update);
        final started = prepared.started();
        final confirmed = update
            ? started.confirmedUpdate(
                const models.ContactsUpdateOutput(success: true),
              )
            : started.confirmedCreate(
                const models.ContactsCreateOutput(id: 'contact'),
              );

        for (final receipt in [prepared, started, confirmed]) {
          await store.write(receipt);

          expect((await store.read(receipt.scope))!.encode(), receipt.encode());
        }
      }
    },
  );

  test(
    'secure contact receipts isolate actors and targets during cleanup',
    () async {
      FlutterSecureStorage.setMockInitialValues({'unrelated': 'preserved'});

      final store = SecureContactReceipts();
      final creation = _receipt('origin|tenant|actor|create');
      final target = _receipt('origin|tenant|actor|contact');
      final other = _receipt('origin|tenant|other|contact');

      await store.write(creation);
      await store.write(target);
      await store.write(other);
      await store.clear(creation.scope);

      expect(await store.read(creation.scope), isNull);
      expect((await store.read(target.scope))!.scope, target.scope);
      expect((await store.read(other.scope))!.scope, other.scope);
      expect(
        await const FlutterSecureStorage().read(key: 'unrelated'),
        'preserved',
      );
    },
  );

  test(
    'secure contact receipts reject foreign and malformed persisted data',
    () async {
      const scope = 'origin|tenant|actor';
      final encodedScope = base64UrlEncode(utf8.encode(scope));
      final key = 'sortsys.contact_write.v1.$encodedScope';
      final store = SecureContactReceipts();

      for (final value in [
        _receipt('foreign').encode(),
        '{bad',
        List.filled(131073, 'x').join(),
      ]) {
        FlutterSecureStorage.setMockInitialValues({key: value});

        await expectLater(store.read(scope), throwsFormatException);
      }

      await expectLater(store.read(''), throwsFormatException);
      await expectLater(store.clear(''), throwsFormatException);
    },
  );
}

ContactWriteReceipt _receipt(String scope, {bool update = false}) {
  final draft = ContactDraft(
    contactId: update ? 'contact' : null,
    firstName: 'Ada',
    lastName: 'Example',
  );

  return ContactWriteReceipt(
    scope: scope,
    nonce: '0123456789abcdef0123456789abcdef',
    createdAt: DateTime.utc(2024),
    createInput: update ? null : draft.createInput(),
    updateInput: update ? draft.updateInput() : null,
    baseline: update
        ? models.Contact(
            id: 'contact',
            firstName: 'Before',
            phoneNumbers: const [],
            emailAddresses: const [],
            createdAt: DateTime.utc(2024),
            modifiedAt: DateTime.utc(2024),
          )
        : null,
  );
}
