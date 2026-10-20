import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/api/model.dart';
import 'package:sortsys_client/features/customers/customer_delete_receipt.dart';

void main() {
  test(
    'customer delete receipt round trips every durable stage and full snapshot',
    () {
      final prepared = _receipt();
      final dispatching = prepared.started();
      final acknowledged = dispatching.confirmed(
        const models.CustomersDeleteOutput(success: true),
      );

      for (final receipt in [prepared, dispatching, acknowledged]) {
        final encoded = receipt.encode();
        final decoded = CustomerDeleteReceipt.decode(encoded);
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
        expect(annotations, containsPair('createdAt', ['Date']));
        expect(annotations, containsPair('baseline.createdAt', ['Date']));
        expect(annotations, containsPair('baseline.modifiedAt', ['Date']));
        expect(
          sameCustomerDeleteBaseline(decoded.baseline, _customer()),
          isTrue,
        );
        expect(decoded.input.id, 'customer');
        expect(decoded.scope, 'origin|tenant|actor');
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
    'customer delete receipt freezes mutable channels and raw optional values',
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
      final baseline = _customer(phones: phones, emails: emails);
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
    'customer delete codec rejects missing extra malformed and foreign intent fields',
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
          CustomerDeleteReceipt.decode(jsonEncode(envelope));
        }, throwsFormatException);
      }

      expect(() {
        CustomerDeleteReceipt.decode('{bad');
      }, throwsFormatException);
    },
  );

  test(
    'customer delete stages require dispatch before a genuine acknowledgement',
    () {
      final prepared = _receipt();
      final dispatching = prepared.started();
      final acknowledged = dispatching.confirmed(
        const models.CustomersDeleteOutput(success: true),
      );

      expect(() {
        prepared.confirmed(const models.CustomersDeleteOutput(success: true));
      }, throwsStateError);
      expect(() {
        dispatching.started();
      }, throwsStateError);
      expect(() {
        dispatching.confirmed(
          const models.CustomersDeleteOutput(success: false),
        );
      }, throwsFormatException);
      expect(() {
        acknowledged.started();
      }, throwsStateError);
      expect(() {
        acknowledged.confirmed(
          const models.CustomersDeleteOutput(success: true),
        );
      }, throwsStateError);
    },
  );

  test('customer delete receipt rejects untagged and pre100 journal dates', () {
    final envelope = jsonDecode(_receipt().encode()) as Map<String, dynamic>;
    (envelope['meta'] as Map<String, dynamic>)['values'] = <String, dynamic>{};

    expect(() {
      CustomerDeleteReceipt.decode(jsonEncode(envelope));
    }, throwsFormatException);
    expect(() {
      _receipt(createdAt: DateTime.utc(99)).encode();
    }, throwsFormatException);
    expect(() {
      _receipt(baseline: _customer(createdAt: DateTime.utc(99))).encode();
    }, throwsFormatException);
  });

  test(
    'customer delete receipt enforces UTF8 payload size before persistence',
    () {
      final small = _receipt(
        baseline: _customer(name: List.filled(1000, 'ä').join()),
      );
      final oversized = _receipt(
        baseline: _customer(name: List.filled(70000, 'ä').join()),
      );

      expect(
        CustomerDeleteReceipt.decode(small.encode()).baseline.name.length,
        1000,
      );
      expect(() {
        oversized.encode();
      }, throwsFormatException);
      expect(() {
        CustomerDeleteReceipt.decode(List.filled(131073, 'x').join());
      }, throwsFormatException);
    },
  );

  test('customer delete baseline owns record fields and channel ordering', () {
    final baseline = _customer();
    final original = baseline.toWire();

    for (final change in <void Function(Map<String, dynamic>)>[
      (data) {
        data['id'] = 'other';
      },
      (data) {
        data['name'] = 'Other';
      },
      (data) {
        data['salutation'] = 'Other';
      },
      (data) {
        data['createdByUserId'] = 'other';
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
        sameCustomerDeleteBaseline(baseline, models.Customer.fromWire(changed)),
        isFalse,
      );
    }

    final first = _customer(
      phones: const [
        models.CustomerPhoneNumbersItem(number: 'first'),
        models.CustomerPhoneNumbersItem(number: 'second'),
      ],
    );
    final reversed = _customer(phones: first.phoneNumbers.reversed.toList());

    expect(sameCustomerDeleteBaseline(first, reversed), isFalse);
    expect(
      sameCustomerDeleteBaseline(
        baseline,
        freezeCustomerDeleteBaseline(baseline),
      ),
      isTrue,
    );
  });
}

CustomerDeleteReceipt _receipt({
  models.Customer? baseline,
  DateTime? createdAt,
}) {
  return CustomerDeleteReceipt(
    scope: 'origin|tenant|actor',
    nonce: '0123456789abcdef0123456789abcdef',
    createdAt: createdAt ?? DateTime.utc(2024, 3),
    input: const models.CustomersDeleteInput(id: 'customer'),
    baseline: baseline ?? _customer(),
  );
}

models.Customer _customer({
  String name = ' Raw customer ',
  List<models.CustomerPhoneNumbersItem> phones = const [],
  List<models.CustomerEmailAddressesItem> emails = const [],
  DateTime? createdAt,
}) {
  return models.Customer(
    id: 'customer',
    salutation: ' Raw salutation ',
    name: name,
    phoneNumbers: phones,
    emailAddresses: emails,
    createdByUserId: 'creator',
    createdAt: createdAt ?? DateTime.utc(2024),
    modifiedAt: DateTime.utc(2024, 2),
  );
}
