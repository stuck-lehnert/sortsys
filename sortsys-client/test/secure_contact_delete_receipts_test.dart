import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/features/contacts/contact_delete_coordinator.dart';
import 'package:sortsys_client/features/contacts/contact_delete_receipt.dart';
import 'package:sortsys_client/features/contacts/contact_draft.dart';
import 'package:sortsys_client/features/contacts/contact_receipt.dart';
import 'package:sortsys_client/features/contacts/contact_write_access.dart';
import 'package:sortsys_client/features/contacts/contact_write_coordinator.dart';
import 'package:sortsys_client/features/contacts/secure_contact_delete_receipts.dart';
import 'package:sortsys_client/features/contacts/secure_contact_receipts.dart';

const _scope = '["https://example.test","tenant","actor","contact"]';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    // Receipt I/O remains in this in-memory plugin, never native storage.
    FlutterSecureStorage.setMockInitialValues({});
  });

  test(
    'secure contact delete receipts persist all three forward stages',
    () async {
      final store = SecureContactDeleteReceipts();
      final prepared = _receipt(
        '["https://example.test","tenant","äctor","contact"]',
      );
      final started = prepared.started();
      final acknowledged = started.confirmed(
        const models.ContactsDeleteOutput(success: true),
      );

      for (final receipt in [prepared, started, acknowledged]) {
        await store.write(receipt);

        expect((await store.read(receipt.scope))!.encode(), receipt.encode());
        expect(
          await const FlutterSecureStorage().read(key: _key(receipt.scope)),
          receipt.encode(),
        );
      }
    },
  );

  test(
    'secure contact delete receipts isolate actors targets and cleanup one key',
    () async {
      FlutterSecureStorage.setMockInitialValues({'unrelated': 'preserved'});

      final store = SecureContactDeleteReceipts();
      final first = _receipt(_scope);
      final other = _receipt(
        '["https://example.test","tenant","other","contact"]',
      );

      final otherTarget = _receipt(
        '["https://example.test","tenant","actor","other-contact"]',
        id: 'other-contact',
      );

      await store.write(first);
      await store.write(other);
      await store.write(otherTarget);
      await store.clear(first.scope);

      expect(await store.read(first.scope), isNull);
      expect((await store.read(other.scope))!.encode(), other.encode());
      expect(
        (await store.read(otherTarget.scope))!.encode(),
        otherTarget.encode(),
      );
      expect(
        await const FlutterSecureStorage().read(key: 'unrelated'),
        'preserved',
      );
    },
  );

  test(
    'secure contact delete receipts reject invalid scopes and envelopes',
    () async {
      const scope = _scope;
      final store = SecureContactDeleteReceipts();

      for (final encoded in [
        _receipt('foreign').encode(),
        '{bad',
        List.filled(131073, 'x').join(),
      ]) {
        FlutterSecureStorage.setMockInitialValues({_key(scope): encoded});

        await expectLater(store.read(scope), throwsFormatException);
        expect(
          await const FlutterSecureStorage().read(key: _key(scope)),
          encoded,
        );
      }

      await expectLater(store.read(''), throwsFormatException);
      await expectLater(store.clear(''), throwsFormatException);
    },
  );

  test(
    'invalid contact delete writes retain the existing scoped intent',
    () async {
      const scope = _scope;
      final store = SecureContactDeleteReceipts();
      final previous = _receipt(scope);

      await store.write(previous);

      for (final receipt in [
        _receipt(scope, nonce: 'invalid'),
        _receipt(scope, firstName: List.filled(70000, 'ä').join()),
      ]) {
        await expectLater(store.write(receipt), throwsFormatException);
        expect((await store.read(scope))!.encode(), previous.encode());
      }
    },
  );

  test(
    'existing target contact edit journal blocks deletion without dispatch',
    () async {
      const scope = _scope;
      final oldStore = SecureContactReceipts();
      final deleteStore = SecureContactDeleteReceipts();
      final legacy = _legacy(scope);
      final access = _DeleteAccess(scope);
      final coordinator = ContactDeleteCoordinator(
        access: access,
        receipts: deleteStore,
      );

      await oldStore.write(legacy);

      await expectLater(deleteStore.read(scope), throwsFormatException);
      await expectLater(
        deleteStore.write(_receipt(scope)),
        throwsFormatException,
      );
      await expectLater(
        coordinator.delete(baseline: _contact(), confirmed: true),
        throwsFormatException,
      );
      expect(access.reads, 0);
      expect(access.writes, 0);
      expect((await oldStore.read(scope))!.encode(), legacy.encode());
      expect(
        await const FlutterSecureStorage().read(key: _key(scope)),
        legacy.encode(),
      );
    },
  );

  test(
    'pending contact deletion blocks actual existing edit coordinator',
    () async {
      const scope = _scope;
      final deleteStore = SecureContactDeleteReceipts();
      final oldStore = SecureContactReceipts();
      final pending = _receipt(scope).started();
      final access = _WriteAccess(scope);
      final coordinator = ContactWriteCoordinator(
        access: access,
        receipts: oldStore,
      );

      await deleteStore.write(_receipt(scope));
      await deleteStore.write(pending);
      await expectLater(coordinator.outstanding(), throwsFormatException);

      await expectLater(oldStore.read(scope), throwsFormatException);
      await expectLater(
        coordinator.save(
          ContactDraft(contactId: 'contact', firstName: 'Changed'),
          baseline: _contact(),
        ),
        throwsFormatException,
      );
      await expectLater(
        coordinator.recover(expectedNonce: pending.nonce),
        throwsFormatException,
      );
      expect(access.reads, 0);
      expect(access.writes, 0);
      expect((await deleteStore.read(scope))!.encode(), pending.encode());
    },
  );

  test(
    'contact delete storage rejects skipped stages regressions and new owners',
    () async {
      const scope = _scope;
      final store = SecureContactDeleteReceipts();
      final prepared = _receipt(scope);
      final started = prepared.started();
      final acknowledged = started.confirmed(
        const models.ContactsDeleteOutput(success: true),
      );

      await expectLater(store.write(started), throwsFormatException);
      await expectLater(store.write(acknowledged), throwsFormatException);
      expect(await store.read(scope), isNull);

      await store.write(prepared);

      await expectLater(
        store.write(_receipt(scope, nonce: 'ffffffffffffffffffffffffffffffff')),
        throwsFormatException,
      );
      await expectLater(store.write(acknowledged), throwsFormatException);
      expect((await store.read(scope))!.encode(), prepared.encode());

      await store.write(started);

      await expectLater(store.write(prepared), throwsFormatException);
      expect((await store.read(scope))!.encode(), started.encode());

      await store.write(acknowledged);
      await store.write(acknowledged);

      await expectLater(store.write(started), throwsFormatException);
      expect((await store.read(scope))!.encode(), acknowledged.encode());
    },
  );
}

String _key(String scope) {
  return 'sortsys.contact_write.v1.${base64UrlEncode(utf8.encode(scope))}';
}

models.Contact _contact({String id = 'contact', String firstName = 'Contact'}) {
  return models.Contact(
    id: id,
    firstName: firstName,
    lastName: null,
    phoneNumbers: const [],
    emailAddresses: const [],
    createdAt: DateTime.utc(2024),
    modifiedAt: DateTime.utc(2024, 2),
  );
}

ContactDeleteReceipt _receipt(
  String scope, {
  String nonce = '0123456789abcdef0123456789abcdef',
  String id = 'contact',
  String firstName = 'Contact',
}) {
  return ContactDeleteReceipt(
    scope: scope,
    nonce: nonce,
    createdAt: DateTime.utc(2024, 3),
    input: models.ContactsDeleteInput(id: id),
    baseline: _contact(id: id, firstName: firstName),
  );
}

ContactWriteReceipt _legacy(String scope) {
  final draft = ContactDraft(contactId: 'contact', firstName: 'Contact');

  return ContactWriteReceipt(
    scope: scope,
    nonce: '0123456789abcdef0123456789abcdef',
    createdAt: DateTime.utc(2024, 3),
    updateInput: draft.updateInput(),
    baseline: _contact(),
  );
}

final class _DeleteAccess implements ContactDeleteAccess {
  _DeleteAccess(this.scope);

  @override
  final String scope;

  @override
  final String contactId = 'contact';

  int reads = 0;
  int writes = 0;

  @override
  void checkCurrent() {
    // Domain fixture; no session or authentication is replaced.
  }

  @override
  void checkDelete(models.ContactsDeleteInput input) {
    checkCurrent();
    expect(input.id, contactId);
  }

  @override
  Future<models.Contact> getContact(String id) async {
    reads++;

    return _contact();
  }

  @override
  Future<models.ContactsDeleteOutput> deleteContact(
    models.ContactsDeleteInput input,
  ) async {
    writes++;

    return const models.ContactsDeleteOutput(success: true);
  }
}

final class _WriteAccess implements ContactWriteAccess {
  _WriteAccess(this.scope);

  @override
  final String scope;

  int reads = 0;
  int writes = 0;

  @override
  void checkCurrent() {
    // The actual existing coordinator still owns all write/journal decisions.
  }

  @override
  void checkCreate(models.ContactsCreateInput input) {
    throw StateError('UNEXPECTED_CONTACT_CREATION');
  }

  @override
  void checkUpdate(models.ContactsUpdateInput input) {
    checkCurrent();
    expect(input.id, 'contact');
  }

  @override
  Future<models.Contact?> getContact(String id) async {
    reads++;

    return _contact();
  }

  @override
  Future<models.ContactsCreateOutput> createContact(
    models.ContactsCreateInput input,
  ) async {
    writes++;

    throw StateError('UNEXPECTED_CONTACT_CREATION');
  }

  @override
  Future<models.ContactsUpdateOutput> updateContact(
    models.ContactsUpdateInput input,
  ) async {
    writes++;

    return const models.ContactsUpdateOutput(success: true);
  }
}
