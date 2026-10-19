import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/contract.dart' show jsonMap;
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/api/model.dart';
import 'package:sortsys_client/api/wire.dart';
import 'package:sortsys_client/features/contacts/contact_draft.dart';
import 'package:sortsys_client/features/contacts/contact_receipt.dart';

const _fields = {
  'version',
  'scope',
  'nonce',
  'createdAt',
  'createInput',
  'updateInput',
  'baseline',
  'dispatching',
  'creation',
  'updateAcknowledgement',
};

void main() {
  test('contact receipt roundtrips both kinds and all durable stages', () {
    for (final update in [false, true]) {
      final prepared = _receipt(update: update);
      final started = prepared.started();
      final acknowledged = update
          ? started.confirmedUpdate(
              const models.ContactsUpdateOutput(success: true),
            )
          : started.confirmedCreate(
              const models.ContactsCreateOutput(id: 'contact'),
            );

      for (final receipt in [prepared, started, acknowledged]) {
        expect(ContactWriteReceipt.decode(receipt.encode()).encode(),
            receipt.encode());
      }

      expect(prepared.acknowledged, isFalse);
      expect(started.dispatching, isTrue);
      expect(acknowledged.dispatching, isFalse);
      expect(acknowledged.acknowledged, isTrue);
    }
  });

  test('contact creation requires genuine ID and every owned field', () {
    final prepared = _receipt();
    final started = prepared.started();
    final confirmed = started.confirmedCreate(
      const models.ContactsCreateOutput(id: 'contact'),
    );
    final expected = _contact(name: 'After');

    expect(prepared.confirms(expected), isFalse);
    expect(started.confirms(expected), isFalse);
    expect(confirmed.confirms(expected), isTrue);
    expect(confirmed.confirms(_contact(id: 'similar', name: 'After')), isFalse);
    expect(confirmed.confirms(_contact(name: 'Other')), isFalse);
    expect(confirmed.confirms(_contact(
      name: 'After',
      phones: const [models.CustomerPhoneNumbersItem(number: 'other')],
    )), isFalse);
    expect(confirmed.confirms(models.Contact(
      id: 'contact', firstName: 'After', lastName: 'Unexpected',
      phoneNumbers: expected.phoneNumbers, emailAddresses: [],
      createdAt: expected.createdAt, modifiedAt: expected.modifiedAt,
    )), isFalse);
  });

  test('contact update can verify known target without replay or create ID', () {
    final prepared = _receipt(update: true);
    final started = prepared.started();
    final confirmed = started.confirmedUpdate(
      const models.ContactsUpdateOutput(success: true),
    );
    final expected = _contact(name: 'After');

    expect(prepared.confirms(expected), isFalse);
    expect(started.confirms(expected), isTrue);
    expect(confirmed.confirms(expected), isTrue);
    expect(started.confirms(_contact(id: 'foreign', name: 'After')), isFalse);
    expect(contactUpdateMatches(started.updateInput!, expected), isTrue);
    expect(sameContactSnapshot(_contact(), _contact()), isTrue);
    expect(sameContactSnapshot(_contact(), _contact(name: 'Other')), isFalse);
    expect(sameContactSnapshot(
      _contact(), _contact(modifiedAt: DateTime.utc(2024, 3)),
    ), isFalse);
  });

  test('contact receipt copies intent and baseline channel collections', () {
    final base = _draft().createInput();
    final inputPhones = List<models.CustomerPhoneNumbersItem>.from(
      base.phoneNumbers.value,
    );
    final baselinePhones = <models.CustomerPhoneNumbersItem>[
      const models.CustomerPhoneNumbersItem(number: 'before'),
    ];
    final receipt = ContactWriteReceipt(
      scope: 'scope',
      nonce: '0123456789abcdef0123456789abcdef',
      createdAt: DateTime.utc(2024),
      updateInput: models.ContactsUpdateInput(
        id: 'contact',
        data: models.ContactsCreateInput(
          salutation: base.salutation,
          firstName: base.firstName,
          lastName: base.lastName,
          address: base.address,
          phoneNumbers: RpcOptional.value(inputPhones),
          emailAddresses: base.emailAddresses,
        ),
      ),
      baseline: _contact(phones: baselinePhones),
    );

    inputPhones.clear();
    baselinePhones.clear();

    expect(receipt.updateInput?.data.phoneNumbers.value.single.number, '+43');
    expect(receipt.baseline?.phoneNumbers.single.number, 'before');
    expect(() => receipt.updateInput!.data.phoneNumbers.value.clear(),
        throwsUnsupportedError);
    expect(() => receipt.baseline!.phoneNumbers.clear(), throwsUnsupportedError);
  });

  test('contact receipt rejects malformed exact envelopes and stage unions', () {
    final data = readRpcObject(
      deserializeWire(jsonMap(jsonDecode(_receipt().encode()))),
      _fields,
    );

    for (final change in <Map<String, Object?>>[
      {'version': 2},
      {'scope': ''},
      {'nonce': 'invalid'},
      {'extra': true},
      {'dispatching': true, 'creation': {'id': 'contact'}},
      {'creation': {'id': ''}},
      {'updateAcknowledgement': {'success': true}},
      {'baseline': encodeRpcValue(_contact())},
      {'createInput': null},
    ]) {
      final encoded = jsonEncode(serializeWire({...data, ...change}));

      expect(() => ContactWriteReceipt.decode(encoded), throwsFormatException);
    }

    for (final key in _fields) {
      final changed = Map<String, Object?>.from(data)..remove(key);
      final encoded = jsonEncode(serializeWire(changed));

      expect(() => ContactWriteReceipt.decode(encoded), throwsFormatException);
    }

    expect(() => ContactWriteReceipt.decode('{bad'), throwsFormatException);
    expect(() => ContactWriteReceipt.decode(List.filled(131073, 'x').join()),
        throwsFormatException);
    expect(() => _receipt(update: true, baselineId: 'foreign').encode(),
        throwsFormatException);
  });

  test('contact receipt rejects wrong acknowledgements and stage transitions', () {
    final create = _receipt();
    final update = _receipt(update: true);

    expect(() => create.confirmedCreate(
      const models.ContactsCreateOutput(id: 'contact'),
    ), throwsStateError);
    expect(() => update.started().confirmedCreate(
      const models.ContactsCreateOutput(id: 'contact'),
    ), throwsStateError);
    expect(() => create.started().confirmedUpdate(
      const models.ContactsUpdateOutput(success: true),
    ), throwsStateError);
    expect(() => create.started().confirmedCreate(
      const models.ContactsCreateOutput(id: ''),
    ), throwsFormatException);
    expect(() => update.started().confirmedUpdate(
      const models.ContactsUpdateOutput(success: false),
    ), throwsFormatException);
    expect(create.started().started, throwsStateError);
  });
}

ContactDraft _draft({bool update = false}) {
  return ContactDraft(
    contactId: update ? 'contact' : null,
    firstName: 'After',
    phoneNumbers: const [ContactChannelDraft(value: '+43')],
  );
}

ContactWriteReceipt _receipt({bool update = false, String baselineId = 'contact'}) {
  final draft = _draft(update: update);

  return ContactWriteReceipt(
    scope: 'scope',
    nonce: '0123456789abcdef0123456789abcdef',
    createdAt: DateTime.utc(2024),
    createInput: update ? null : draft.createInput(),
    updateInput: update ? draft.updateInput() : null,
    baseline: update ? _contact(id: baselineId) : null,
  );
}

models.Contact _contact({
  String id = 'contact',
  String name = 'Before',
  List<models.CustomerPhoneNumbersItem> phones = const [
    models.CustomerPhoneNumbersItem(name: RpcOptional.value(null), number: '+43'),
  ],
  DateTime? modifiedAt,
}) {
  return models.Contact(
    id: id,
    firstName: name,
    phoneNumbers: phones,
    emailAddresses: [],
    createdAt: DateTime.utc(2024),
    modifiedAt: modifiedAt ?? DateTime.utc(2024, 2),
  );
}
