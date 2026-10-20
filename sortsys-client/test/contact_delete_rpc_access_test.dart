import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/api.g.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/api/procedure.dart';
import 'package:sortsys_client/features/contacts/contact_delete_rpc_access.dart';
import 'package:sortsys_client/features/contacts/session_contact_access.dart';
import 'package:sortsys_client/features/contacts/session_contact_delete_access.dart';
import 'package:sortsys_client/state/session_controller.dart';

const _scope = '["https://example.test","tenant","actor","contact"]';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test(
    'contact delete RPC uses exact known-ID get and delete contracts',
    () async {
      final fixture = _Fixture();
      final access = fixture.access();

      final contact = await access.getContact('contact');
      final result = await access.deleteContact(_input());

      expect(contact.id, 'contact');
      expect(result.success, isTrue);
      expect(fixture.readInput!.toWire(), {'id': 'contact'});
      expect(fixture.writeInput!.toWire(), {'id': 'contact'});
      expect(fixture.reads, 1);
      expect(fixture.writes, 1);
    },
  );

  test(
    'contact delete RPC requires view and delete but permits view-only reads',
    () async {
      for (final permission in ['view:contacts', 'delete:contacts']) {
        final fixture = _Fixture();
        fixture.permissions.remove(permission);

        await expectLater(
          fixture.access().deleteContact(_input()),
          throwsStateError,
        );
        expect(fixture.writes, 0);
      }

      final fixture = _Fixture();
      fixture.permissions.remove('delete:contacts');

      expect((await fixture.access().getContact('contact')).id, 'contact');
      expect(fixture.reads, 1);

      fixture.permissions.remove('view:contacts');

      await expectLater(
        fixture.access().getContact('contact'),
        throwsStateError,
      );
      expect(fixture.reads, 1);
    },
  );

  test(
    'contact delete RPC rejects invalid owners and foreign targets before I-O',
    () async {
      final fixture = _Fixture();

      for (final access in [
        fixture.access(scope: ''),
        fixture.access(contactId: ''),
      ]) {
        expect(() {
          access.checkCurrent();
        }, throwsFormatException);
      }

      await expectLater(
        fixture.access().getContact('foreign'),
        throwsFormatException,
      );
      await expectLater(
        fixture.access().deleteContact(_input(id: 'foreign')),
        throwsFormatException,
      );
      expect(fixture.reads, 0);
      expect(fixture.writes, 0);
    },
  );

  test(
    'contact delete RPC rejects stale view-revoked and mismatched reads',
    () async {
      for (final revoke in [false, true]) {
        final fixture = _Fixture();
        fixture.onRead = () async {
          if (revoke) {
            fixture.permissions.remove('view:contacts');
          } else {
            fixture.current = false;
          }
        };

        await expectLater(
          fixture.access().getContact('contact'),
          throwsStateError,
        );
        expect(fixture.reads, 1);
      }

      final fixture = _Fixture();
      fixture.responseId = 'foreign';

      await expectLater(
        fixture.access().getContact('contact'),
        throwsFormatException,
      );
      expect(fixture.reads, 1);
    },
  );

  test(
    'contact delete RPC preserves genuine ACK after delete-role loss only',
    () async {
      final fixture = _Fixture();
      fixture.onWrite = () async {
        fixture.permissions.remove('delete:contacts');
      };

      expect((await fixture.access().deleteContact(_input())).success, isTrue);
      expect(fixture.writes, 1);

      for (final revokeView in [false, true]) {
        final stale = _Fixture();
        stale.onWrite = () async {
          if (revokeView) {
            stale.permissions.remove('view:contacts');
          } else {
            stale.current = false;
          }
        };

        await expectLater(
          stale.access().deleteContact(_input()),
          throwsStateError,
        );
        expect(stale.writes, 1);
      }
    },
  );

  test(
    'contact delete RPC requires a genuine positive acknowledgement',
    () async {
      final fixture = _Fixture();
      fixture.success = false;

      await expectLater(
        fixture.access().deleteContact(_input()),
        throwsFormatException,
      );
      expect(fixture.writes, 1);
      expect(fixture.reads, 0);
    },
  );

  test('contact delete RPC returns frozen raw channel snapshots', () async {
    final fixture = _Fixture();

    final contact = await fixture.access().getContact('contact');

    fixture.phones.clear();
    fixture.emails.clear();

    expect(contact.firstName, ' Raw contact ');
    expect(contact.lastName, isNull);
    expect(contact.phoneNumbers.single.number, ' +49 raw ');
    expect(contact.emailAddresses.single.email, ' raw@example.com ');
    expect(() {
      contact.phoneNumbers.clear();
    }, throwsUnsupportedError);
    expect(() {
      contact.emailAddresses.clear();
    }, throwsUnsupportedError);
  });

  test(
    'real final session rejects contact deletion and shares target journal scope',
    () async {
      final session = SessionController();
      addTearDown(session.dispose);
      final delete = sessionContactDeleteAccess(session, contactId: 'contact');
      final edit = sessionContactWriteAccess(session, contactId: 'contact');
      final create = sessionContactWriteAccess(session);
      final inactive = sessionContactDeleteAccess(
        session,
        contactId: 'contact',
        isActive: () {
          return false;
        },
      );

      expect(delete.scope, edit.scope);
      expect(jsonDecode(delete.scope), [null, null, null, 'contact']);
      expect(create.scope, isNot(delete.scope));
      expect(jsonDecode(create.scope), [null, null, null, null]);
      expect(delete.contactId, 'contact');
      expect(() {
        delete.checkCurrent();
      }, throwsStateError);
      expect(() {
        inactive.checkCurrent();
      }, throwsStateError);
      await expectLater(delete.getContact('contact'), throwsStateError);
      await expectLater(delete.deleteContact(_input()), throwsStateError);
    },
  );
}

models.ContactsDeleteInput _input({String id = 'contact'}) {
  return models.ContactsDeleteInput(id: id);
}

final class _Fixture {
  bool current = true;
  bool success = true;
  String responseId = 'contact';
  int reads = 0;
  int writes = 0;
  final permissions = {'view:contacts', 'delete:contacts'};
  final phones = [const models.CustomerPhoneNumbersItem(number: ' +49 raw ')];
  final emails = [
    const models.CustomerEmailAddressesItem(email: ' raw@example.com '),
  ];
  models.ContactsGetInput? readInput;
  models.ContactsDeleteInput? writeInput;
  Future<void> Function()? onRead;
  Future<void> Function()? onWrite;

  ContactDeleteRpcAccess access({
    String scope = _scope,
    String contactId = 'contact',
  }) {
    return ContactDeleteRpcAccess(
      scope: scope,
      contactId: contactId,
      read: read,
      write: write,
      isCurrent: () {
        return current;
      },
      can: permissions.contains,
    );
  }

  Future<O> read<I, O>(RpcQuery<I, O> query, I input) async {
    expect(identical(query, ApiQueries.contactsGet), isTrue);

    reads++;
    readInput = input as models.ContactsGetInput;

    final callback = onRead;

    if (callback != null) {
      await callback();
    }

    return models.Contact(
          id: responseId,
          firstName: ' Raw contact ',
          lastName: null,
          phoneNumbers: phones,
          emailAddresses: emails,
          createdAt: DateTime.utc(2024),
          modifiedAt: DateTime.utc(2024, 2),
        )
        as O;
  }

  Future<O> write<I, O>(RpcMutation<I, O> mutation, I input) async {
    expect(identical(mutation, ApiMutations.contactsDelete), isTrue);

    writes++;
    writeInput = input as models.ContactsDeleteInput;

    final callback = onWrite;

    if (callback != null) {
      await callback();
    }

    return models.ContactsDeleteOutput(success: success) as O;
  }
}
