import 'dart:convert';

import '../../api/generated/models.g.dart' as models;
import '../../api/model.dart';

String? customerNullableText(String? value) {
  final trimmed = value?.trim();

  return trimmed == null || trimmed.isEmpty ? null : trimmed;
}

final class CustomerDraft {
  CustomerDraft({
    required String name,
    String? salutation,
    models.ProjectAddress? address,
    List<models.CustomerPhoneNumbersItem> phoneNumbers = const [],
    List<models.CustomerEmailAddressesItem> emailAddresses = const [],
    List<String>? contactIds,
  }) : name = name.trim(),
       salutation = customerNullableText(salutation),
       address = address == null
           ? null
           : models.ProjectAddress(
               streetAddress: address.streetAddress.trim(),
               city: address.city.trim(),
               zip: RpcOptional.value(
                 customerNullableText(address.zip.valueOrNull),
               ),
               country: RpcOptional.value(
                 customerNullableText(address.country.valueOrNull),
               ),
             ),
       phoneNumbers = List.unmodifiable([
         for (final phone in phoneNumbers)
           if (phone.number.trim().isNotEmpty)
             models.CustomerPhoneNumbersItem(
               name: RpcOptional.value(
                 customerNullableText(phone.name.valueOrNull),
               ),
               number: phone.number.trim(),
             ),
       ]),
       emailAddresses = List.unmodifiable([
         for (final email in emailAddresses)
           if (email.email.trim().isNotEmpty)
             models.CustomerEmailAddressesItem(
               name: RpcOptional.value(
                 customerNullableText(email.name.valueOrNull),
               ),
               email: email.email.trim(),
             ),
       ]),
       contactIds = contactIds == null
           ? null
           : List.unmodifiable(contactIds.toSet());

  final String name;
  final String? salutation;
  final models.ProjectAddress? address;
  final List<models.CustomerPhoneNumbersItem> phoneNumbers;
  final List<models.CustomerEmailAddressesItem> emailAddresses;
  final List<String>? contactIds;

  void validate() {
    if (name.isEmpty || utf8.encode(name).length > 127) {
      throw const FormatException('INVALID_CUSTOMER_NAME');
    }

    if (address != null &&
        (address!.streetAddress.isEmpty || address!.city.isEmpty)) {
      throw const FormatException('INVALID_CUSTOMER_ADDRESS');
    }

    if (contactIds?.any((id) => id.isEmpty) == true) {
      throw const FormatException('INVALID_CUSTOMER_CONTACT_ID');
    }
  }

  models.CustomersCreateInput createInput() {
    validate();

    return models.CustomersCreateInput(
      name: name,
      salutation: RpcOptional.value(salutation),
      address: RpcOptional.value(address),
      phoneNumbers: RpcOptional.value(phoneNumbers),
      emailAddresses: RpcOptional.value(emailAddresses),
    );
  }

  models.CustomersUpdateInput updateInput(models.Customer baseline) {
    final target = customerTargetFields(createInput());
    final previous = customerFields(baseline);
    final changed = <String, Object?>{};

    for (final entry in target.entries) {
      if (jsonEncode(entry.value) != jsonEncode(previous[entry.key])) {
        changed[entry.key] = entry.value;
      }
    }

    return models.CustomersUpdateInput(
      id: baseline.id,
      data: models.CustomersUpdateRequestData.fromWire(changed),
    );
  }
}

Map<String, Object?> _addressFields(models.ProjectAddress? address) {
  return {
    'streetAddress': address?.streetAddress,
    'city': address?.city,
    'zip': address?.zip.valueOrNull,
    'country': address?.country.valueOrNull,
  };
}

Map<String, Object?> _fields({
  required String name,
  required String? salutation,
  required models.ProjectAddress? address,
  required List<models.CustomerPhoneNumbersItem> phones,
  required List<models.CustomerEmailAddressesItem> emails,
}) {
  return {
    'name': name,
    'salutation': salutation,
    'address': address == null ? null : _addressFields(address),
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

Map<String, Object?> customerFields(models.Customer customer) {
  return _fields(
    name: customer.name,
    salutation: customer.salutation,
    address: customer.address,
    phones: customer.phoneNumbers,
    emails: customer.emailAddresses,
  );
}

Map<String, Object?> customerTargetFields(models.CustomersCreateInput input) {
  return _fields(
    name: input.name,
    salutation: input.salutation.valueOrNull,
    address: input.address.valueOrNull,
    phones: input.phoneNumbers.valueOrNull ?? const [],
    emails: input.emailAddresses.valueOrNull ?? const [],
  );
}

String customerBaselineKey(models.Customer customer) {
  return jsonEncode([
    customer.id,
    customer.modifiedAt.toUtc().toIso8601String(),
    customerFields(customer),
  ]);
}

bool customerMatchesTarget(
  models.Customer customer,
  models.CustomersCreateInput input,
) {
  return jsonEncode(customerFields(customer)) ==
      jsonEncode(customerTargetFields(input));
}

bool customerContactIdsEqual(Iterable<String> first, Iterable<String> second) {
  final left = first.toSet();
  final right = second.toSet();

  return left.length == right.length && left.containsAll(right);
}
