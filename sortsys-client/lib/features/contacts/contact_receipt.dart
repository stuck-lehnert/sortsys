import 'dart:convert';

import '../../api/contract.dart' show jsonMap;
import '../../api/generated/models.g.dart' as models;
import '../../api/model.dart';
import '../../api/wire.dart';
import 'contact_write_inputs.dart';

final class ContactWriteReceipt {
  ContactWriteReceipt({
    required this.scope,
    required this.nonce,
    required this.createdAt,
    models.ContactsCreateInput? createInput,
    models.ContactsUpdateInput? updateInput,
    models.Contact? baseline,
    this.dispatching = false,
    this.creation,
    this.updateAcknowledgement,
  }) : createInput = createInput == null
           ? null
           : copyContactWriteInput(createInput),
       updateInput = updateInput == null
           ? null
           : models.ContactsUpdateInput(
               id: updateInput.id,
               data: copyContactWriteInput(updateInput.data),
             ),
       baseline = baseline == null ? null : _copyContact(baseline);

  final String scope;
  final String nonce;
  final DateTime createdAt;
  final models.ContactsCreateInput? createInput;
  final models.ContactsUpdateInput? updateInput;
  final models.Contact? baseline;
  final bool dispatching;
  final models.ContactsCreateOutput? creation;
  final models.ContactsUpdateOutput? updateAcknowledgement;

  bool get acknowledged {
    return creation != null || updateAcknowledgement != null;
  }

  ContactWriteReceipt started() {
    if (dispatching || acknowledged) {
      throw StateError('INVALID_CONTACT_RECEIPT_STAGE');
    }

    return _copy(dispatching: true);
  }

  ContactWriteReceipt confirmedCreate(models.ContactsCreateOutput result) {
    if (createInput == null || !dispatching || acknowledged) {
      throw StateError('INVALID_CONTACT_RECEIPT_STAGE');
    }

    if (result.id.isEmpty) {
      throw const FormatException('INVALID_CONTACT_CREATE_ACK');
    }

    return _copy(dispatching: false, creation: result);
  }

  ContactWriteReceipt confirmedUpdate(models.ContactsUpdateOutput result) {
    if (updateInput == null || !dispatching || acknowledged) {
      throw StateError('INVALID_CONTACT_RECEIPT_STAGE');
    }

    if (!result.success) {
      throw const FormatException('INVALID_CONTACT_UPDATE_ACK');
    }

    return _copy(dispatching: false, updateAcknowledgement: result);
  }

  ContactWriteReceipt _copy({
    required bool dispatching,
    models.ContactsCreateOutput? creation,
    models.ContactsUpdateOutput? updateAcknowledgement,
  }) {
    return ContactWriteReceipt(
      scope: scope,
      nonce: nonce,
      createdAt: createdAt,
      createInput: createInput,
      updateInput: updateInput,
      baseline: baseline,
      dispatching: dispatching,
      creation: creation,
      updateAcknowledgement: updateAcknowledgement,
    );
  }

  String encode() {
    _validate();

    final encoded = jsonEncode(serializeWire({
      'version': 1,
      'scope': scope,
      'nonce': nonce,
      'createdAt': createdAt,
      'createInput': encodeRpcValue(createInput),
      'updateInput': encodeRpcValue(updateInput),
      'baseline': encodeRpcValue(baseline),
      'dispatching': dispatching,
      'creation': encodeRpcValue(creation),
      'updateAcknowledgement': encodeRpcValue(updateAcknowledgement),
    }));
    _checkSize(encoded);

    return encoded;
  }

  factory ContactWriteReceipt.decode(String encoded) {
    _checkSize(encoded);

    final data = readRpcObject(
      deserializeWire(jsonMap(jsonDecode(encoded))),
      _receiptFields,
    );
    readRpcLiteral(data['version'], 1);

    if (data.length != _receiptFields.length ||
        !_receiptFields.every(data.containsKey)) {
      throw const FormatException('INVALID_CONTACT_RECEIPT');
    }

    final receipt = ContactWriteReceipt(
      scope: readRpcString(data['scope']),
      nonce: readRpcString(data['nonce']),
      createdAt: readRpcDate(data['createdAt']),
      createInput: readRpcNullable(
        data['createInput'], models.ContactsCreateInput.fromWire,
      ),
      updateInput: readRpcNullable(
        data['updateInput'], models.ContactsUpdateInput.fromWire,
      ),
      baseline: readRpcNullable(data['baseline'], models.Contact.fromWire),
      dispatching: readRpcBoolean(data['dispatching']),
      creation: readRpcNullable(
        data['creation'], models.ContactsCreateOutput.fromWire,
      ),
      updateAcknowledgement: readRpcNullable(
        data['updateAcknowledgement'], models.ContactsUpdateOutput.fromWire,
      ),
    );
    receipt._validate();

    return receipt;
  }

  void _validate() {
    if (scope.isEmpty ||
        !RegExp(r'^[0-9a-f]{32}$').hasMatch(nonce) ||
        createdAt.year < 100 ||
        (createInput == null) == (updateInput == null)) {
      throw const FormatException('INVALID_CONTACT_RECEIPT');
    }

    if ((dispatching && acknowledged) ||
        creation?.id.isEmpty == true ||
        updateAcknowledgement?.success == false) {
      throw const FormatException('INVALID_CONTACT_RECEIPT_STAGE');
    }

    final create = createInput;
    final update = updateInput;
    final original = baseline;

    if (create != null) {
      if (original != null || updateAcknowledgement != null) {
        throw const FormatException('INVALID_CONTACT_CREATE_RECEIPT');
      }

      copyContactWriteInput(create);
    } else if (update != null) {
      if (original == null ||
          original.id.isEmpty ||
          original.id != update.id ||
          creation != null) {
        throw const FormatException('INVALID_CONTACT_UPDATE_RECEIPT');
      }

      copyContactWriteInput(update.data);
    }
  }

  bool confirms(models.Contact contact) {
    _validate();

    final create = createInput;
    final update = updateInput;

    if (create != null) {
      // Similar contacts do not establish ownership without the actual ID.
      return creation?.id == contact.id && _matches(contact, create);
    }

    return update != null &&
        (dispatching || updateAcknowledgement != null) &&
        contactUpdateMatches(update, contact);
  }
}

const _receiptFields = {
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

abstract interface class ContactReceiptStore {
  Future<ContactWriteReceipt?> read(String scope);

  Future<void> write(ContactWriteReceipt receipt);

  Future<void> clear(String scope);
}

bool contactUpdateMatches(
  models.ContactsUpdateInput input,
  models.Contact contact,
) {
  final data = copyContactWriteInput(input.data);

  return contact.id == input.id && _matches(contact, data);
}

bool sameContactSnapshot(models.Contact left, models.Contact right) {
  return left.id == right.id &&
      left.createdAt.isAtSameMomentAs(right.createdAt) &&
      left.modifiedAt.isAtSameMomentAs(right.modifiedAt) &&
      jsonEncode(_contactFields(left)) == jsonEncode(_contactFields(right));
}

bool _matches(models.Contact contact, models.ContactsCreateInput input) {
  return jsonEncode(_contactFields(contact)) == jsonEncode(_fields(
    salutation: input.salutation.value,
    firstName: input.firstName.value,
    lastName: input.lastName.value,
    address: input.address.value,
    phones: input.phoneNumbers.value,
    emails: input.emailAddresses.value,
  ));
}

Map<String, Object?> _contactFields(models.Contact contact) {
  return _fields(
    salutation: contact.salutation,
    firstName: contact.firstName,
    lastName: contact.lastName,
    address: contact.address,
    phones: contact.phoneNumbers,
    emails: contact.emailAddresses,
  );
}

Map<String, Object?> _fields({
  required String? salutation,
  required String? firstName,
  required String? lastName,
  required models.ProjectAddress? address,
  required List<models.CustomerPhoneNumbersItem> phones,
  required List<models.CustomerEmailAddressesItem> emails,
}) {
  return {
    'salutation': salutation,
    'firstName': firstName,
    'lastName': lastName,
    'address': address == null ? null : {
      'streetAddress': address.streetAddress,
      'city': address.city,
      'zip': address.zip.valueOrNull,
      'country': address.country.valueOrNull,
    },
    'phoneNumbers': [
      for (final phone in phones)
        {'name': phone.name.valueOrNull, 'number': phone.number},
    ],
    'emailAddresses': [
      for (final email in emails)
        {'name': email.name.valueOrNull, 'email': email.email},
    ],
  };
}

models.Contact _copyContact(models.Contact contact) {
  return models.Contact(
    id: contact.id,
    salutation: contact.salutation,
    firstName: contact.firstName,
    lastName: contact.lastName,
    address: contact.address,
    phoneNumbers: List.unmodifiable(contact.phoneNumbers),
    emailAddresses: List.unmodifiable(contact.emailAddresses),
    createdAt: contact.createdAt,
    modifiedAt: contact.modifiedAt,
  );
}

void _checkSize(String encoded) {
  if (utf8.encode(encoded).length > 131072) {
    throw const FormatException('CONTACT_RECEIPT_TOO_LARGE');
  }
}
