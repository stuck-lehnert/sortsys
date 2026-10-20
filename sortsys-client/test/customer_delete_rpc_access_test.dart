import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/api.g.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/api/procedure.dart';
import 'package:sortsys_client/features/customers/customer_delete_rpc_access.dart';
import 'package:sortsys_client/features/customers/session_customer_access.dart';
import 'package:sortsys_client/features/customers/session_customer_delete_access.dart';
import 'package:sortsys_client/state/session_controller.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test(
    'customer delete RPC uses exact known-ID get and delete contracts',
    () async {
      final fixture = _Fixture();
      final access = fixture.access();

      final customer = await access.getCustomer('customer');
      final result = await access.deleteCustomer(_input());

      expect(customer.id, 'customer');
      expect(result.success, isTrue);
      expect(fixture.readInput!.toWire(), {'id': 'customer'});
      expect(fixture.writeInput!.toWire(), {'id': 'customer'});
      expect(fixture.reads, 1);
      expect(fixture.writes, 1);
    },
  );

  test(
    'customer delete RPC requires view and delete but permits view-only reads',
    () async {
      for (final permission in ['view:customers', 'delete:customers']) {
        final fixture = _Fixture();
        fixture.permissions.remove(permission);

        await expectLater(
          fixture.access().deleteCustomer(_input()),
          throwsStateError,
        );
        expect(fixture.writes, 0);
      }

      final fixture = _Fixture();
      fixture.permissions.remove('delete:customers');

      expect((await fixture.access().getCustomer('customer')).id, 'customer');
      expect(fixture.reads, 1);

      fixture.permissions.remove('view:customers');

      await expectLater(
        fixture.access().getCustomer('customer'),
        throwsStateError,
      );
      expect(fixture.reads, 1);
    },
  );

  test(
    'customer delete RPC rejects invalid owners and foreign targets before I-O',
    () async {
      final fixture = _Fixture();

      for (final access in [
        fixture.access(scope: ''),
        fixture.access(customerId: ''),
      ]) {
        expect(() {
          access.checkCurrent();
        }, throwsFormatException);
      }

      await expectLater(
        fixture.access().getCustomer('foreign'),
        throwsFormatException,
      );
      await expectLater(
        fixture.access().deleteCustomer(_input(id: 'foreign')),
        throwsFormatException,
      );
      expect(fixture.reads, 0);
      expect(fixture.writes, 0);
    },
  );

  test(
    'customer delete RPC rejects stale view-revoked and mismatched reads',
    () async {
      for (final revoke in [false, true]) {
        final fixture = _Fixture();
        fixture.onRead = () async {
          if (revoke) {
            fixture.permissions.remove('view:customers');
          } else {
            fixture.current = false;
          }
        };

        await expectLater(
          fixture.access().getCustomer('customer'),
          throwsStateError,
        );
        expect(fixture.reads, 1);
      }

      final fixture = _Fixture();
      fixture.responseId = 'foreign';

      await expectLater(
        fixture.access().getCustomer('customer'),
        throwsFormatException,
      );
      expect(fixture.reads, 1);
    },
  );

  test(
    'customer delete RPC preserves genuine ACK after delete-role loss only',
    () async {
      final fixture = _Fixture();
      fixture.onWrite = () async {
        fixture.permissions.remove('delete:customers');
      };

      expect((await fixture.access().deleteCustomer(_input())).success, isTrue);
      expect(fixture.writes, 1);

      for (final revokeView in [false, true]) {
        final stale = _Fixture();
        stale.onWrite = () async {
          if (revokeView) {
            stale.permissions.remove('view:customers');
          } else {
            stale.current = false;
          }
        };

        await expectLater(
          stale.access().deleteCustomer(_input()),
          throwsStateError,
        );
        expect(stale.writes, 1);
      }
    },
  );

  test(
    'customer delete RPC requires a genuine positive acknowledgement',
    () async {
      final fixture = _Fixture();
      fixture.success = false;

      await expectLater(
        fixture.access().deleteCustomer(_input()),
        throwsFormatException,
      );
      expect(fixture.writes, 1);
      expect(fixture.reads, 0);
    },
  );

  test('customer delete RPC returns frozen raw channel snapshots', () async {
    final fixture = _Fixture();

    final customer = await fixture.access().getCustomer('customer');

    fixture.phones.clear();
    fixture.emails.clear();

    expect(customer.phoneNumbers.single.number, ' +49 raw ');
    expect(customer.emailAddresses.single.email, ' raw@example.com ');
    expect(() {
      customer.phoneNumbers.clear();
    }, throwsUnsupportedError);
    expect(() {
      customer.emailAddresses.clear();
    }, throwsUnsupportedError);
  });

  test(
    'real final session rejects customer deletion and shares actor journal scope',
    () async {
      final session = SessionController();
      addTearDown(session.dispose);
      final delete = sessionCustomerDeleteAccess(
        session,
        customerId: 'customer',
      );
      final edit = SessionCustomerAccess(session);
      final inactive = sessionCustomerDeleteAccess(
        session,
        customerId: 'customer',
        isActive: () {
          return false;
        },
      );

      expect(delete.scope, edit.scope);
      expect(jsonDecode(delete.scope), [null, null, null]);
      expect(delete.customerId, 'customer');
      expect(() {
        delete.checkCurrent();
      }, throwsStateError);
      expect(() {
        inactive.checkCurrent();
      }, throwsStateError);
      await expectLater(delete.getCustomer('customer'), throwsStateError);
      await expectLater(delete.deleteCustomer(_input()), throwsStateError);
    },
  );
}

models.CustomersDeleteInput _input({String id = 'customer'}) {
  return models.CustomersDeleteInput(id: id);
}

final class _Fixture {
  bool current = true;
  bool success = true;
  String responseId = 'customer';
  int reads = 0;
  int writes = 0;
  final permissions = {'view:customers', 'delete:customers'};
  final phones = [const models.CustomerPhoneNumbersItem(number: ' +49 raw ')];
  final emails = [
    const models.CustomerEmailAddressesItem(email: ' raw@example.com '),
  ];
  models.CustomersGetInput? readInput;
  models.CustomersDeleteInput? writeInput;
  Future<void> Function()? onRead;
  Future<void> Function()? onWrite;

  CustomerDeleteRpcAccess access({
    String scope = 'origin|tenant|actor',
    String customerId = 'customer',
  }) {
    return CustomerDeleteRpcAccess(
      scope: scope,
      customerId: customerId,
      read: read,
      write: write,
      isCurrent: () {
        return current;
      },
      can: permissions.contains,
    );
  }

  Future<O> read<I, O>(RpcQuery<I, O> query, I input) async {
    expect(identical(query, ApiQueries.customersGet), isTrue);

    reads++;
    readInput = input as models.CustomersGetInput;

    final callback = onRead;

    if (callback != null) {
      await callback();
    }

    return models.Customer(
          id: responseId,
          name: ' Raw customer ',
          phoneNumbers: phones,
          emailAddresses: emails,
          createdAt: DateTime.utc(2024),
          modifiedAt: DateTime.utc(2024, 2),
        )
        as O;
  }

  Future<O> write<I, O>(RpcMutation<I, O> mutation, I input) async {
    expect(identical(mutation, ApiMutations.customersDelete), isTrue);

    writes++;
    writeInput = input as models.CustomersDeleteInput;

    final callback = onWrite;

    if (callback != null) {
      await callback();
    }

    return models.CustomersDeleteOutput(success: success) as O;
  }
}
