import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/features/customers/customer_delete_coordinator.dart';
import 'package:sortsys_client/features/customers/customer_delete_receipt.dart';
import 'package:sortsys_client/features/customers/customer_draft.dart';
import 'package:sortsys_client/features/customers/customer_write.dart';
import 'package:sortsys_client/features/customers/secure_customer_delete_receipts.dart';
import 'package:sortsys_client/features/customers/secure_customer_receipts.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    // Receipt I/O remains in this in-memory plugin, never native storage.
    FlutterSecureStorage.setMockInitialValues({});
  });

  test(
    'secure customer delete receipts persist all three forward stages',
    () async {
      final store = SecureCustomerDeleteReceipts();
      final prepared = _receipt('origin|tenant|äctor');
      final started = prepared.started();
      final acknowledged = started.confirmed(
        const models.CustomersDeleteOutput(success: true),
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
    'secure customer delete receipts isolate actors and cleanup one key',
    () async {
      FlutterSecureStorage.setMockInitialValues({'unrelated': 'preserved'});

      final store = SecureCustomerDeleteReceipts();
      final first = _receipt('origin|tenant|actor');
      final other = _receipt('origin|tenant|other');

      await store.write(first);
      await store.write(other);
      await store.clear(first.scope);

      expect(await store.read(first.scope), isNull);
      expect((await store.read(other.scope))!.encode(), other.encode());
      expect(
        await const FlutterSecureStorage().read(key: 'unrelated'),
        'preserved',
      );
    },
  );

  test(
    'secure customer delete receipts reject invalid scopes and envelopes',
    () async {
      const scope = 'origin|tenant|actor';
      final store = SecureCustomerDeleteReceipts();

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
    'invalid customer delete writes retain the existing scoped intent',
    () async {
      const scope = 'origin|tenant|actor';
      final store = SecureCustomerDeleteReceipts();
      final previous = _receipt(scope);

      await store.write(previous);

      for (final receipt in [
        _receipt(scope, nonce: 'invalid'),
        _receipt(scope, name: List.filled(70000, 'ä').join()),
      ]) {
        await expectLater(store.write(receipt), throwsFormatException);
        expect((await store.read(scope))!.encode(), previous.encode());
      }
    },
  );

  test(
    'existing customer create journal blocks deletion without dispatch',
    () async {
      const scope = 'origin|tenant|actor';
      final oldStore = SecureCustomerReceipts();
      final deleteStore = SecureCustomerDeleteReceipts();
      final legacy = _legacy(scope);
      final access = _DeleteAccess(scope);
      final coordinator = CustomerDeleteCoordinator(
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
        coordinator.delete(baseline: _customer(), confirmed: true),
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
    'pending customer deletion blocks actual existing edit coordinator',
    () async {
      const scope = 'origin|tenant|actor';
      final deleteStore = SecureCustomerDeleteReceipts();
      final oldStore = SecureCustomerReceipts();
      final pending = _receipt(scope).started();
      final access = _WriteAccess(scope);
      final coordinator = CustomerWriteCoordinator(
        access: access,
        receipts: oldStore,
      );

      await deleteStore.write(_receipt(scope));
      await deleteStore.write(pending);
      await coordinator.load('customer');

      await expectLater(oldStore.read(scope), throwsFormatException);
      await expectLater(
        coordinator.save(CustomerDraft(name: 'Changed')),
        throwsFormatException,
      );
      expect(access.writes, 0);
      expect((await deleteStore.read(scope))!.encode(), pending.encode());
    },
  );

  test(
    'customer delete storage rejects skipped stages regressions and new owners',
    () async {
      const scope = 'origin|tenant|actor';
      final store = SecureCustomerDeleteReceipts();
      final prepared = _receipt(scope);
      final started = prepared.started();
      final acknowledged = started.confirmed(
        const models.CustomersDeleteOutput(success: true),
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
  return 'sortsys.customer_write.v1.${base64UrlEncode(utf8.encode(scope))}';
}

models.Customer _customer({String name = 'Customer'}) {
  return models.Customer(
    id: 'customer',
    name: name,
    phoneNumbers: const [],
    emailAddresses: const [],
    createdAt: DateTime.utc(2024),
    modifiedAt: DateTime.utc(2024, 2),
  );
}

CustomerDeleteReceipt _receipt(
  String scope, {
  String nonce = '0123456789abcdef0123456789abcdef',
  String name = 'Customer',
}) {
  return CustomerDeleteReceipt(
    scope: scope,
    nonce: nonce,
    createdAt: DateTime.utc(2024, 3),
    input: const models.CustomersDeleteInput(id: 'customer'),
    baseline: _customer(name: name),
  );
}

CustomerWriteReceipt _legacy(String scope) {
  final draft = CustomerDraft(name: 'Customer');

  return CustomerWriteReceipt(
    scope: scope,
    nonce: '0123456789abcdef0123456789abcdef',
    stage: CustomerWriteStage.basePending,
    target: draft.createInput(),
    createInput: draft.createInput(),
  );
}

final class _DeleteAccess implements CustomerDeleteAccess {
  _DeleteAccess(this.scope);

  @override
  final String scope;

  int reads = 0;
  int writes = 0;

  @override
  void checkCurrent() {
    // Domain fixture; no session or authentication is replaced.
  }

  @override
  void checkDelete(models.CustomersDeleteInput input) {
    checkCurrent();
  }

  @override
  Future<models.Customer> getCustomer(String id) async {
    reads++;

    return _customer();
  }

  @override
  Future<models.CustomersDeleteOutput> deleteCustomer(
    models.CustomersDeleteInput input,
  ) async {
    writes++;

    return const models.CustomersDeleteOutput(success: true);
  }
}

final class _WriteAccess implements CustomerWriteAccess {
  _WriteAccess(this.scope);

  @override
  final String scope;

  int writes = 0;

  @override
  bool get canSelectContacts {
    return false;
  }

  @override
  void checkCurrent() {
    // The actual existing coordinator still owns all write/journal decisions.
  }

  @override
  Future<models.Customer> getCustomer(String id) async {
    return _customer();
  }

  @override
  Future<List<models.Contact>> getContacts(String id) async {
    throw StateError('UNEXPECTED_CONTACT_READ');
  }

  @override
  Future<void> validateContactIds(List<String> ids) async {
    throw StateError('UNEXPECTED_CONTACT_VALIDATION');
  }

  @override
  Future<String> createCustomer(models.CustomersCreateInput input) async {
    writes++;

    return 'unexpected-create';
  }

  @override
  Future<void> updateCustomer(models.CustomersUpdateInput input) async {
    writes++;
  }

  @override
  Future<void> setContacts(models.CustomersContactsSetInput input) async {
    writes++;
  }
}
