import 'dart:convert';

import '../../api/contract.dart' show jsonMap;
import '../../api/generated/models.g.dart' as models;
import '../../api/model.dart';
import '../../api/wire.dart';

final class ContactDeleteReceipt {
  ContactDeleteReceipt({
    required this.scope,
    required this.nonce,
    required this.createdAt,
    required models.ContactsDeleteInput input,
    required models.Contact baseline,
    this.dispatching = false,
    this.acknowledgement,
  }) : input = models.ContactsDeleteInput(id: input.id),
       baseline = freezeContactDeleteBaseline(baseline);

  final String scope;
  final String nonce;
  final DateTime createdAt;
  final models.ContactsDeleteInput input;
  final models.Contact baseline;
  final bool dispatching;
  final models.ContactsDeleteOutput? acknowledgement;

  bool get acknowledged {
    return acknowledgement != null;
  }

  ContactDeleteReceipt started() {
    _validate();

    if (dispatching || acknowledged) {
      throw StateError('INVALID_CONTACT_DELETE_RECEIPT_STAGE');
    }

    return _copy(dispatching: true);
  }

  ContactDeleteReceipt confirmed(models.ContactsDeleteOutput result) {
    _validate();

    if (!dispatching || acknowledged) {
      throw StateError('INVALID_CONTACT_DELETE_RECEIPT_STAGE');
    }

    if (!result.success) {
      throw const FormatException('INVALID_CONTACT_DELETE_ACK');
    }

    return _copy(dispatching: false, acknowledgement: result);
  }

  ContactDeleteReceipt _copy({
    required bool dispatching,
    models.ContactsDeleteOutput? acknowledgement,
  }) {
    return ContactDeleteReceipt(
      scope: scope,
      nonce: nonce,
      createdAt: createdAt,
      input: input,
      baseline: baseline,
      dispatching: dispatching,
      acknowledgement: acknowledgement,
    );
  }

  String encode() {
    _validate();

    final encoded = jsonEncode(
      serializeWire({
        'version': 2,
        'operation': 'delete',
        'scope': scope,
        'nonce': nonce,
        'createdAt': createdAt,
        'input': encodeRpcValue(input),
        'baseline': encodeRpcValue(baseline),
        'dispatching': dispatching,
        'acknowledgement': encodeRpcValue(acknowledgement),
      }),
    );

    _checkSize(encoded);

    return encoded;
  }

  factory ContactDeleteReceipt.decode(String encoded) {
    _checkSize(encoded);

    final data = readRpcObject(
      deserializeWire(jsonMap(jsonDecode(encoded))),
      _fields,
    );

    readRpcLiteral(data['version'], 2);
    readRpcLiteral(data['operation'], 'delete');

    if (data.length != _fields.length || !_fields.every(data.containsKey)) {
      throw const FormatException('INVALID_CONTACT_DELETE_RECEIPT');
    }

    final receipt = ContactDeleteReceipt(
      scope: readRpcString(data['scope']),
      nonce: readRpcString(data['nonce']),
      createdAt: readRpcDate(data['createdAt']),
      input: models.ContactsDeleteInput.fromWire(data['input']),
      baseline: models.Contact.fromWire(data['baseline']),
      dispatching: readRpcBoolean(data['dispatching']),
      acknowledgement: readRpcNullable(
        data['acknowledgement'],
        models.ContactsDeleteOutput.fromWire,
      ),
    );

    receipt._validate();

    return receipt;
  }

  void _validate() {
    if (scope.isEmpty ||
        nonce.length != 32 ||
        !RegExp(r'^[0-9a-f]{32}$').hasMatch(nonce) ||
        createdAt.year < 100 ||
        input.id.isEmpty ||
        baseline.id != input.id ||
        baseline.createdAt.year < 100 ||
        baseline.modifiedAt.year < 100) {
      throw const FormatException('INVALID_CONTACT_DELETE_RECEIPT');
    }

    if ((dispatching && acknowledged) || acknowledgement?.success == false) {
      throw const FormatException('INVALID_CONTACT_DELETE_RECEIPT_STAGE');
    }
  }
}

models.Contact freezeContactDeleteBaseline(models.Contact contact) {
  final snapshot = models.Contact.fromWire(contact.toWire());

  return models.Contact(
    id: snapshot.id,
    salutation: snapshot.salutation,
    firstName: snapshot.firstName,
    lastName: snapshot.lastName,
    address: snapshot.address,
    phoneNumbers: List.unmodifiable(snapshot.phoneNumbers),
    emailAddresses: List.unmodifiable(snapshot.emailAddresses),
    createdAt: snapshot.createdAt,
    modifiedAt: snapshot.modifiedAt,
  );
}

bool sameContactDeleteBaseline(models.Contact first, models.Contact second) {
  return jsonEncode(serializeWire(first.toWire())) ==
      jsonEncode(serializeWire(second.toWire()));
}

const _fields = {
  'version',
  'operation',
  'scope',
  'nonce',
  'createdAt',
  'input',
  'baseline',
  'dispatching',
  'acknowledgement',
};

void _checkSize(String encoded) {
  const maxBytes = 128 * 1024;

  if (encoded.length > maxBytes || utf8.encode(encoded).length > maxBytes) {
    throw const FormatException('CONTACT_DELETE_RECEIPT_TOO_LARGE');
  }
}

abstract interface class ContactDeleteReceiptStore {
  Future<ContactDeleteReceipt?> read(String scope);

  Future<void> write(ContactDeleteReceipt receipt);

  Future<void> clear(String scope);
}
