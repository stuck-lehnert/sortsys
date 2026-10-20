import 'dart:convert';

import '../../api/contract.dart' show jsonMap;
import '../../api/generated/models.g.dart' as models;
import '../../api/model.dart';
import '../../api/wire.dart';

final class CustomerDeleteReceipt {
  CustomerDeleteReceipt({
    required this.scope,
    required this.nonce,
    required this.createdAt,
    required models.CustomersDeleteInput input,
    required models.Customer baseline,
    this.dispatching = false,
    this.acknowledgement,
  }) : input = models.CustomersDeleteInput(id: input.id),
       baseline = freezeCustomerDeleteBaseline(baseline);

  final String scope;
  final String nonce;
  final DateTime createdAt;
  final models.CustomersDeleteInput input;
  final models.Customer baseline;
  final bool dispatching;
  final models.CustomersDeleteOutput? acknowledgement;

  bool get acknowledged {
    return acknowledgement != null;
  }

  CustomerDeleteReceipt started() {
    _validate();

    if (dispatching || acknowledged) {
      throw StateError('INVALID_CUSTOMER_DELETE_RECEIPT_STAGE');
    }

    return _copy(dispatching: true);
  }

  CustomerDeleteReceipt confirmed(models.CustomersDeleteOutput result) {
    _validate();

    if (!dispatching || acknowledged) {
      throw StateError('INVALID_CUSTOMER_DELETE_RECEIPT_STAGE');
    }

    if (!result.success) {
      throw const FormatException('INVALID_CUSTOMER_DELETE_ACK');
    }

    return _copy(dispatching: false, acknowledgement: result);
  }

  CustomerDeleteReceipt _copy({
    required bool dispatching,
    models.CustomersDeleteOutput? acknowledgement,
  }) {
    return CustomerDeleteReceipt(
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

  factory CustomerDeleteReceipt.decode(String encoded) {
    _checkSize(encoded);

    final data = readRpcObject(
      deserializeWire(jsonMap(jsonDecode(encoded))),
      _fields,
    );

    readRpcLiteral(data['version'], 2);
    readRpcLiteral(data['operation'], 'delete');

    if (data.length != _fields.length || !_fields.every(data.containsKey)) {
      throw const FormatException('INVALID_CUSTOMER_DELETE_RECEIPT');
    }

    final receipt = CustomerDeleteReceipt(
      scope: readRpcString(data['scope']),
      nonce: readRpcString(data['nonce']),
      createdAt: readRpcDate(data['createdAt']),
      input: models.CustomersDeleteInput.fromWire(data['input']),
      baseline: models.Customer.fromWire(data['baseline']),
      dispatching: readRpcBoolean(data['dispatching']),
      acknowledgement: readRpcNullable(
        data['acknowledgement'],
        models.CustomersDeleteOutput.fromWire,
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
      throw const FormatException('INVALID_CUSTOMER_DELETE_RECEIPT');
    }

    if ((dispatching && acknowledged) || acknowledgement?.success == false) {
      throw const FormatException('INVALID_CUSTOMER_DELETE_RECEIPT_STAGE');
    }
  }
}

models.Customer freezeCustomerDeleteBaseline(models.Customer customer) {
  final snapshot = models.Customer.fromWire(customer.toWire());

  return models.Customer(
    id: snapshot.id,
    salutation: snapshot.salutation,
    name: snapshot.name,
    address: snapshot.address,
    phoneNumbers: List.unmodifiable(snapshot.phoneNumbers),
    emailAddresses: List.unmodifiable(snapshot.emailAddresses),
    createdByUserId: snapshot.createdByUserId,
    createdAt: snapshot.createdAt,
    modifiedAt: snapshot.modifiedAt,
  );
}

bool sameCustomerDeleteBaseline(models.Customer first, models.Customer second) {
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
    throw const FormatException('CUSTOMER_DELETE_RECEIPT_TOO_LARGE');
  }
}

abstract interface class CustomerDeleteReceiptStore {
  Future<CustomerDeleteReceipt?> read(String scope);

  Future<void> write(CustomerDeleteReceipt receipt);

  Future<void> clear(String scope);
}
