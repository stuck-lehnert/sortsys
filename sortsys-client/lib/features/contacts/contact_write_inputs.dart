import 'dart:convert';

import '../../api/generated/models.g.dart' as models;
import '../../api/model.dart';
import 'contact_draft.dart';

models.ContactsCreateInput copyContactWriteInput(
  models.ContactsCreateInput input,
) {
  if (!input.salutation.hasValue ||
      !input.firstName.hasValue ||
      !input.lastName.hasValue ||
      !input.address.hasValue ||
      !input.phoneNumbers.hasValue ||
      !input.emailAddresses.hasValue) {
    throw const FormatException('INCOMPLETE_CONTACT_WRITE_INPUT');
  }

  final address = input.address.value;
  final phones = input.phoneNumbers.value;
  final emails = input.emailAddresses.value;

  if ((address != null &&
          (!address.zip.hasValue || !address.country.hasValue)) ||
      phones.any((phone) => !phone.name.hasValue) ||
      emails.any((email) => !email.name.hasValue)) {
    throw const FormatException('INCOMPLETE_CONTACT_WRITE_INPUT');
  }

  final draft = ContactDraft(
    salutation: input.salutation.value ?? '',
    firstName: input.firstName.value ?? '',
    lastName: input.lastName.value ?? '',
    address: address,
    phoneNumbers: [
      for (final phone in phones)
        ContactChannelDraft(name: phone.name.value ?? '', value: phone.number),
    ],
    emailAddresses: [
      for (final email in emails)
        ContactChannelDraft(name: email.name.value ?? '', value: email.email),
    ],
  );
  final canonical = draft.createInput();

  // Preserve the submitted wire intent rather than silently normalizing recovery.
  if (jsonEncode(encodeRpcValue(input)) !=
      jsonEncode(encodeRpcValue(canonical))) {
    throw const FormatException('NONCANONICAL_CONTACT_WRITE_INPUT');
  }

  return canonical;
}
