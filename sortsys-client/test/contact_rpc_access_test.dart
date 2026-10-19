import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/api.g.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/api/model.dart';
import 'package:sortsys_client/api/procedure.dart';
import 'package:sortsys_client/features/contacts/contact_draft.dart';
import 'package:sortsys_client/features/contacts/contact_rpc_access.dart';

void main() {
  test(
    'contact access uses exact RPCs and immutable request and readback',
    () async {
      final fixture = _Fixture();
      final base = _draft().createInput();
      final phones = List<models.CustomerPhoneNumbersItem>.from(
        base.phoneNumbers.value,
      );
      final input = models.ContactsCreateInput(
        salutation: base.salutation,
        firstName: base.firstName,
        lastName: base.lastName,
        address: base.address,
        phoneNumbers: RpcOptional.value(phones),
        emailAddresses: base.emailAddresses,
      );
      fixture.onWrite = phones.clear;

      final created = await fixture.access().createContact(input);
      fixture.onWrite = null;
      final contact = await fixture.access().getContact(created.id);
      fixture.readPhones.clear();
      final updated = await fixture
          .access(contactId: 'contact')
          .updateContact(
            ContactDraft(
              contactId: 'contact',
              firstName: 'Grace',
            ).updateInput(),
          );

      expect(created.id, 'contact');
      expect(updated.success, isTrue);
      expect(fixture.calls, [
        'contacts.create',
        'contacts.get',
        'contacts.update',
      ]);
      expect(fixture.created?.phoneNumbers.value.single.number, '+43 123');
      expect(contact?.phoneNumbers.single.number, '+43 123');
      expect(fixture.updated?.id, 'contact');
      expect(fixture.updated?.data.firstName.value, 'Grace');
      expect(fixture.updated?.data.lastName.hasValue, isTrue);
      expect(fixture.updated?.data.lastName.value, isNull);
      expect(
        () => fixture.created!.phoneNumbers.value.clear(),
        throwsUnsupportedError,
      );
      expect(() => contact!.phoneNumbers.clear(), throwsUnsupportedError);
    },
  );

  test(
    'contact access enforces actual roles and view-only recovery reads',
    () async {
      for (final roles in [
        <String>{},
        {'view:contacts'},
        {'manage:contacts'},
      ]) {
        final fixture = _Fixture();
        fixture.roles = roles;

        await expectLater(
          fixture.access().createContact(_draft().createInput()),
          throwsStateError,
        );

        if (roles.contains('view:contacts')) {
          expect((await fixture.access().getContact('contact'))?.id, 'contact');
        } else {
          await expectLater(
            fixture.access().getContact('contact'),
            throwsStateError,
          );
        }

        expect(fixture.writes, 0);
      }

      final fixture = _Fixture();
      fixture.onWrite = () {
        fixture.roles.remove('manage:contacts');
      };

      await expectLater(
        fixture.access().createContact(_draft().createInput()),
        throwsStateError,
      );

      expect(fixture.writes, 1);
      expect((await fixture.access().getContact('contact'))?.id, 'contact');
    },
  );

  test(
    'contact access rejects noncanonical or incomplete owned payloads',
    () async {
      final fixture = _Fixture();
      final wire = _draft().createInput().toWire();
      final cases = <Map<String, Object?>>[
        {...wire, 'firstName': ' Ada '},
        {...wire, 'lastName': List.filled(64, 'ä').join()},
        {...wire}..remove('address'),
        {
          ...wire,
          'address': {
            'streetAddress': ' Road',
            'city': 'Town',
            'zip': null,
            'country': null,
          },
        },
        {
          ...wire,
          'phoneNumbers': [
            {'number': '+43'},
          ],
        },
        {
          ...wire,
          'emailAddresses': [
            {'name': null, 'email': ' '},
          ],
        },
      ];

      for (final value in cases) {
        final input = models.ContactsCreateInput.fromWire(value);

        await expectLater(
          fixture.access().createContact(input),
          throwsFormatException,
        );
      }

      expect(fixture.writes, 0);
    },
  );

  test(
    'contact access pins context and rejects stale or false responses',
    () async {
      final fixture = _Fixture();
      final edit = fixture.access(contactId: 'contact');

      await expectLater(
        edit.createContact(_draft().createInput()),
        throwsFormatException,
      );
      await expectLater(
        fixture.access().updateContact(
          _draft(contactId: 'contact').updateInput(),
        ),
        throwsFormatException,
      );
      await expectLater(edit.getContact('foreign'), throwsFormatException);
      await expectLater(
        edit.updateContact(_draft(contactId: 'foreign').updateInput()),
        throwsFormatException,
      );

      expect(fixture.calls, isEmpty);
      fixture.createdId = '';

      await expectLater(
        fixture.access().createContact(_draft().createInput()),
        throwsFormatException,
      );
      fixture.updateSuccess = false;

      await expectLater(
        edit.updateContact(_draft(contactId: 'contact').updateInput()),
        throwsFormatException,
      );
      fixture.readId = 'foreign';

      await expectLater(edit.getContact('contact'), throwsFormatException);
      fixture.readId = 'contact';
      fixture.onRead = () {
        fixture.current = false;
      };

      await expectLater(edit.getContact('contact'), throwsStateError);
      final count = fixture.calls.length;

      await expectLater(edit.getContact('contact'), throwsStateError);

      expect(fixture.calls.length, count);
    },
  );
}

ContactDraft _draft({String? contactId}) {
  return ContactDraft(
    contactId: contactId,
    firstName: 'Ada',
    phoneNumbers: const [ContactChannelDraft(value: '+43 123')],
  );
}

final class _Fixture {
  Set<String> roles = {'view:contacts', 'manage:contacts'};
  bool current = true;
  String createdId = 'contact';
  String readId = 'contact';
  bool updateSuccess = true;
  int writes = 0;
  final calls = <String>[];
  final readPhones = <models.CustomerPhoneNumbersItem>[
    const models.CustomerPhoneNumbersItem(number: '+43 123'),
  ];
  models.ContactsCreateInput? created;
  models.ContactsUpdateInput? updated;
  void Function()? onWrite;
  void Function()? onRead;

  ContactRpcAccess access({String? contactId}) {
    return ContactRpcAccess(
      scope: 'origin|tenant|actor|$contactId',
      contactId: contactId,
      read: read,
      write: write,
      isCurrent: () {
        return current;
      },
      can: roles.contains,
    );
  }

  Future<O> write<I, O>(RpcMutation<I, O> mutation, I input) async {
    writes++;
    final Object output;

    if (mutation == ApiMutations.contactsCreate) {
      calls.add('contacts.create');
      created = input as models.ContactsCreateInput;
      output = models.ContactsCreateOutput(id: createdId);
    } else {
      expect(mutation, same(ApiMutations.contactsUpdate));
      calls.add('contacts.update');
      updated = input as models.ContactsUpdateInput;
      output = models.ContactsUpdateOutput(success: updateSuccess);
    }

    onWrite?.call();

    return output as O;
  }

  Future<O> read<I, O>(RpcQuery<I, O> query, I input) async {
    expect(query, same(ApiQueries.contactsGet));
    expect((input as models.ContactsGetInput).id, 'contact');
    calls.add('contacts.get');
    onRead?.call();

    return models.Contact(
      id: readId,
      firstName: 'Ada',
      phoneNumbers: readPhones,
      emailAddresses: [],
      createdAt: DateTime.utc(2024),
      modifiedAt: DateTime.utc(2024, 2),
    ) as O;
  }
}
