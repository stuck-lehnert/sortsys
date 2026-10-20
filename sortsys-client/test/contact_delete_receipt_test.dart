import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/api/model.dart';
import 'package:sortsys_client/features/contacts/contact_delete_receipt.dart';
import 'package:sortsys_client/features/contacts/contact_receipt.dart';

const _scope = '["https://example.test","tenant","actor","contact"]';

void main() {
  test(
    'contact delete receipt round trips every durable stage and full snapshot',
    () {
      final prepared = _receipt();
      final dispatching = prepared.started();
      final acknowledged = dispatching.confirmed(
        const models.ContactsDeleteOutput(success: true),
      );

      for (final receipt in [prepared, dispatching, acknowledged]) {
        final encoded = receipt.encode();
        final decoded = ContactDeleteReceipt.decode(encoded);
        final envelope = jsonDecode(encoded) as Map<String, dynamic>;
        final data = envelope['json'] as Map<String, dynamic>;
        final annotations =
            (envelope['meta'] as Map<String, dynamic>)['values'];

        expect(decoded.encode(), encoded);
        expect(data.keys.toSet(), {
          'version',
          'operation',
          'scope',
          'nonce',
          'createdAt',
          'input',
          'baseline',
          'dispatching',
          'acknowledgement',
        });
        expect(data['version'], 2);
        expect(data['operation'], 'delete');
        expect((data['baseline'] as Map<String, dynamic>).keys.toSet(), {
          'id',
          'salutation',
          'firstName',
          'lastName',
          'address',
          'phoneNumbers',
          'emailAddresses',
          'createdAt',
          'modifiedAt',
        });
        expect(annotations, containsPair('createdAt', ['Date']));
        expect(annotations, containsPair('baseline.createdAt', ['Date']));
        expect(annotations, containsPair('baseline.modifiedAt', ['Date']));
        expect(sameContactDeleteBaseline(decoded.baseline, _contact()), isTrue);
        expect(decoded.input.id, 'contact');
        expect(decoded.scope, _scope);
      }

      expect(prepared.dispatching, isFalse);
      expect(prepared.acknowledged, isFalse);
      expect(dispatching.dispatching, isTrue);
      expect(dispatching.acknowledged, isFalse);
      expect(acknowledged.dispatching, isFalse);
      expect(acknowledged.acknowledged, isTrue);
    },
  );

  test(
    'contact delete receipt freezes mutable channels and raw optional values',
    () {
      final phones = [
        const models.CustomerPhoneNumbersItem(
          number: ' +49 123 ',
          name: RpcOptional.value(null),
        ),
      ];
      final emails = [
        const models.CustomerEmailAddressesItem(email: ' raw@example.com '),
      ];
      final baseline = _contact(phones: phones, emails: emails);
      final receipt = _receipt(baseline: baseline);
      final original = receipt.encode();

      phones[0] = const models.CustomerPhoneNumbersItem(number: 'replacement');
      emails.clear();

      expect(receipt.encode(), original);
      expect(receipt.baseline.phoneNumbers.single.number, ' +49 123 ');
      expect(
        receipt.baseline.phoneNumbers.single.toWire(),
        containsPair('name', null),
      );
      expect(receipt.baseline.emailAddresses.single.email, ' raw@example.com ');
      expect(
        receipt.baseline.emailAddresses.single.toWire().containsKey('name'),
        isFalse,
      );
      expect(() {
        receipt.baseline.phoneNumbers.clear();
      }, throwsUnsupportedError);
      expect(() {
        receipt.baseline.emailAddresses.add(
          const models.CustomerEmailAddressesItem(email: 'new@example.com'),
        );
      }, throwsUnsupportedError);
    },
  );

  test(
    'contact delete codec rejects missing extra malformed and foreign intent fields',
    () {
      for (final change in <void Function(Map<String, dynamic>)>[
        (data) {
          data.remove('acknowledgement');
        },
        (data) {
          data['extra'] = true;
        },
        (data) {
          data['version'] = 1;
        },
        (data) {
          data['operation'] = 'update';
        },
        (data) {
          data['scope'] = '';
        },
        (data) {
          data['nonce'] = '0123456789ABCDEF0123456789ABCDEF';
        },
        (data) {
          data['nonce'] = 'short';
        },
        (data) {
          data['nonce'] = '0123456789abcdef0123456789abcdef\n';
        },
        (data) {
          data['dispatching'] = 'false';
        },
        (data) {
          data['input'] = {'id': 'other'};
        },
        (data) {
          data['input'] = {'id': ''};
        },
        (data) {
          data['acknowledgement'] = {'success': false};
        },
        (data) {
          data['dispatching'] = true;
          data['acknowledgement'] = {'success': true};
        },
      ]) {
        final envelope =
            jsonDecode(_receipt().encode()) as Map<String, dynamic>;
        final data = envelope['json'] as Map<String, dynamic>;

        change(data);

        expect(() {
          ContactDeleteReceipt.decode(jsonEncode(envelope));
        }, throwsFormatException);
      }

      expect(() {
        ContactDeleteReceipt.decode('{bad');
      }, throwsFormatException);
    },
  );

  test(
    'contact delete stages require dispatch before a genuine acknowledgement',
    () {
      final prepared = _receipt();
      final dispatching = prepared.started();
      final acknowledged = dispatching.confirmed(
        const models.ContactsDeleteOutput(success: true),
      );

      expect(() {
        prepared.confirmed(const models.ContactsDeleteOutput(success: true));
      }, throwsStateError);
      expect(() {
        dispatching.started();
      }, throwsStateError);
      expect(() {
        dispatching.confirmed(
          const models.ContactsDeleteOutput(success: false),
        );
      }, throwsFormatException);
      expect(() {
        acknowledged.started();
      }, throwsStateError);
      expect(() {
        acknowledged.confirmed(
          const models.ContactsDeleteOutput(success: true),
        );
      }, throwsStateError);
    },
  );

  test('contact delete receipt rejects untagged and pre100 journal dates', () {
    final envelope = jsonDecode(_receipt().encode()) as Map<String, dynamic>;
    (envelope['meta'] as Map<String, dynamic>)['values'] = <String, dynamic>{};

    expect(() {
      ContactDeleteReceipt.decode(jsonEncode(envelope));
    }, throwsFormatException);
    expect(() {
      _receipt(createdAt: DateTime.utc(99)).encode();
    }, throwsFormatException);
    expect(() {
      _receipt(baseline: _contact(createdAt: DateTime.utc(99))).encode();
    }, throwsFormatException);
    expect(() {
      _receipt(baseline: _contact(modifiedAt: DateTime.utc(99))).encode();
    }, throwsFormatException);
  });

  test(
    'contact delete receipt enforces UTF8 payload size before persistence',
    () {
      final small = _receipt(
        baseline: _contact(firstName: List.filled(1000, 'ä').join()),
      );
      final oversized = _receipt(
        baseline: _contact(firstName: List.filled(70000, 'ä').join()),
      );

      expect(
        ContactDeleteReceipt.decode(small.encode()).baseline.firstName!.length,
        1000,
      );
      expect(() {
        oversized.encode();
      }, throwsFormatException);
      expect(() {
        ContactDeleteReceipt.decode(List.filled(131073, 'x').join());
      }, throwsFormatException);
      expect(
        () {
          ContactDeleteReceipt.decode(List.filled(70000, 'ä').join());
        },
        throwsA(
          isA<FormatException>().having(
            (error) {
              return error.message;
            },
            'message',
            'CONTACT_DELETE_RECEIPT_TOO_LARGE',
          ),
        ),
      );
    },
  );

  test('contact delete baseline owns record fields and channel ordering', () {
    final baseline = _contact();
    final original = baseline.toWire();

    for (final change in <void Function(Map<String, dynamic>)>[
      (data) {
        data['id'] = 'other';
      },
      (data) {
        data['firstName'] = 'Other';
      },
      (data) {
        data['salutation'] = 'Other';
      },
      (data) {
        data['lastName'] = 'Other';
      },
      (data) {
        data['address'] = {'city': ' Town ', 'streetAddress': ' Other street '};
      },
      (data) {
        data['createdAt'] = DateTime.utc(2023);
      },
      (data) {
        data['modifiedAt'] = DateTime.utc(2025);
      },
      (data) {
        data['phoneNumbers'] = [
          {'number': 'first'},
          {'number': 'second'},
        ];
      },
      (data) {
        data['emailAddresses'] = [
          {'email': 'changed@example.com'},
        ];
      },
    ]) {
      final changed = Map<String, dynamic>.from(original);
      change(changed);

      expect(
        sameContactDeleteBaseline(baseline, models.Contact.fromWire(changed)),
        isFalse,
      );
    }

    final first = _contact(
      phones: const [
        models.CustomerPhoneNumbersItem(number: 'first'),
        models.CustomerPhoneNumbersItem(number: 'second'),
      ],
    );
    final reversed = _contact(phones: first.phoneNumbers.reversed.toList());

    expect(sameContactDeleteBaseline(first, reversed), isFalse);
    expect(
      sameContactDeleteBaseline(
        baseline,
        freezeContactDeleteBaseline(baseline),
      ),
      isTrue,
    );
  });

  test(
    'contact delete baseline distinguishes null empty and omitted values',
    () {
      final absentNames = _contact(firstName: null, lastName: null);
      final emptyFirst = _contact(firstName: '', lastName: null);
      final emptyLast = _contact(firstName: null, lastName: '');
      const address = models.ProjectAddress(
        city: ' Town ',
        streetAddress: ' Street ',
      );
      const nullZip = models.ProjectAddress(
        city: ' Town ',
        streetAddress: ' Street ',
        zip: RpcOptional.value(null),
      );
      final frozenAddress = freezeContactDeleteBaseline(
        _contact(address: nullZip),
      );
      final absentPhoneName = _contact(
        phones: const [models.CustomerPhoneNumbersItem(number: ' raw ')],
      );
      final nullPhoneName = _contact(
        phones: const [
          models.CustomerPhoneNumbersItem(
            number: ' raw ',
            name: RpcOptional.value(null),
          ),
        ],
      );
      final orderedEmails = _contact(
        emails: const [
          models.CustomerEmailAddressesItem(email: ' first@example.com '),
          models.CustomerEmailAddressesItem(email: 'second@example.com'),
        ],
      );
      final reversedEmails = _contact(
        emails: orderedEmails.emailAddresses.reversed.toList(),
      );
      final duplicatedEmails = _contact(
        emails: [
          ...orderedEmails.emailAddresses,
          orderedEmails.emailAddresses.first,
        ],
      );

      expect(sameContactDeleteBaseline(absentNames, emptyFirst), isFalse);
      expect(sameContactDeleteBaseline(absentNames, emptyLast), isFalse);
      expect(frozenAddress.address!.city, ' Town ');
      expect(frozenAddress.address!.streetAddress, ' Street ');
      expect(frozenAddress.address!.zip.isAbsent, isFalse);
      expect(frozenAddress.address!.zip.value, isNull);
      expect(frozenAddress.address!.country.isAbsent, isTrue);
      expect(
        sameContactDeleteBaseline(
          _contact(address: address),
          _contact(address: nullZip),
        ),
        isFalse,
      );
      expect(
        sameContactDeleteBaseline(absentPhoneName, nullPhoneName),
        isFalse,
      );
      expect(sameContactDeleteBaseline(orderedEmails, reversedEmails), isFalse);
      expect(
        sameContactDeleteBaseline(orderedEmails, duplicatedEmails),
        isFalse,
      );
      expect(
        sameContactDeleteBaseline(
          orderedEmails,
          freezeContactDeleteBaseline(orderedEmails),
        ),
        isTrue,
      );
    },
  );

  test('contact delete v2 and actual legacy v1 receipts reject each other', () {
    final deletion = _receipt();
    final legacy = ContactWriteReceipt(
      scope: _scope,
      nonce: '0123456789abcdef0123456789abcdef',
      createdAt: DateTime.utc(2024, 3),
      updateInput: const models.ContactsUpdateInput(
        id: 'contact',
        data: models.ContactsCreateInput(
          salutation: RpcOptional.value(null),
          firstName: RpcOptional.value('First'),
          lastName: RpcOptional.value('Last'),
          address: RpcOptional.value(null),
          phoneNumbers: RpcOptional.value([]),
          emailAddresses: RpcOptional.value([]),
        ),
      ),
      baseline: _contact(),
    );
    final originalLegacy = legacy.encode();
    final originalDeletion = deletion.encode();

    expect(ContactWriteReceipt.decode(originalLegacy).encode(), originalLegacy);
    expect(
      ContactDeleteReceipt.decode(originalDeletion).encode(),
      originalDeletion,
    );
    expect(() {
      ContactWriteReceipt.decode(originalDeletion);
    }, throwsFormatException);
    expect(() {
      ContactDeleteReceipt.decode(originalLegacy);
    }, throwsFormatException);
    expect(legacy.encode(), originalLegacy);
    expect(deletion.encode(), originalDeletion);
  });
}

ContactDeleteReceipt _receipt({models.Contact? baseline, DateTime? createdAt}) {
  return ContactDeleteReceipt(
    scope: _scope,
    nonce: '0123456789abcdef0123456789abcdef',
    createdAt: createdAt ?? DateTime.utc(2024, 3),
    input: const models.ContactsDeleteInput(id: 'contact'),
    baseline: baseline ?? _contact(),
  );
}

models.Contact _contact({
  String? firstName = ' Raw first ',
  String? lastName = ' Raw last ',
  models.ProjectAddress? address,
  List<models.CustomerPhoneNumbersItem> phones = const [],
  List<models.CustomerEmailAddressesItem> emails = const [],
  DateTime? createdAt,
  DateTime? modifiedAt,
}) {
  return models.Contact(
    id: 'contact',
    salutation: ' Raw salutation ',
    firstName: firstName,
    lastName: lastName,
    address: address,
    phoneNumbers: phones,
    emailAddresses: emails,
    createdAt: createdAt ?? DateTime.utc(2024),
    modifiedAt: modifiedAt ?? DateTime.utc(2024, 2),
  );
}
