import 'dart:convert';

import '../../api/generated/models.g.dart' as models;
import '../../api/model.dart';

enum ContactDraftIssue { nameRequired, required, tooLong }

final class ContactChannelDraft {
  const ContactChannelDraft({this.name = '', this.value = ''});

  final String name;
  final String value;
}

final class ContactDraft {
  ContactDraft({
    this.contactId,
    this.salutation = '',
    this.firstName = '',
    this.lastName = '',
    this.address,
    List<ContactChannelDraft> phoneNumbers = const [],
    List<ContactChannelDraft> emailAddresses = const [],
  }) : phoneNumbers = List.unmodifiable(phoneNumbers),
       emailAddresses = List.unmodifiable(emailAddresses);

  final String? contactId;
  final String salutation;
  final String firstName;
  final String lastName;
  final models.ProjectAddress? address;
  final List<ContactChannelDraft> phoneNumbers;
  final List<ContactChannelDraft> emailAddresses;

  factory ContactDraft.fromQuery(String query) {
    final trimmed = query.trim();

    if (trimmed.isEmpty) {
      return ContactDraft();
    }

    final parts = trimmed.split(RegExp(r'\s+'));

    return ContactDraft(
      firstName: parts.first,
      lastName: parts.skip(1).join(' '),
    );
  }

  factory ContactDraft.fromContact(models.Contact contact) {
    return ContactDraft(
      contactId: contact.id,
      salutation: contact.salutation ?? '',
      firstName: contact.firstName ?? '',
      lastName: contact.lastName ?? '',
      address: contact.address,
      phoneNumbers: [
        for (final phone in contact.phoneNumbers)
          ContactChannelDraft(
            name: phone.name.valueOrNull ?? '',
            value: phone.number,
          ),
      ],
      emailAddresses: [
        for (final email in contact.emailAddresses)
          ContactChannelDraft(
            name: email.name.valueOrNull ?? '',
            value: email.email,
          ),
      ],
    );
  }

  Map<String, ContactDraftIssue> validate() {
    final issues = <String, ContactDraftIssue>{};
    final first = firstName.trim();
    final last = lastName.trim();

    if (first.isEmpty && last.isEmpty) {
      issues['firstName'] = ContactDraftIssue.nameRequired;
      issues['lastName'] = ContactDraftIssue.nameRequired;
    }

    for (final entry in {'firstName': first, 'lastName': last}.entries) {
      if (utf8.encode(entry.value).length > 127) {
        issues[entry.key] = ContactDraftIssue.tooLong;
      }
    }

    final location = address;

    if (location != null) {
      if (location.streetAddress.trim().isEmpty) {
        issues['streetAddress'] = ContactDraftIssue.required;
      }

      if (location.city.trim().isEmpty) {
        issues['city'] = ContactDraftIssue.required;
      }
    }

    return Map.unmodifiable(issues);
  }

  models.ContactsCreateInput createInput() {
    if (contactId != null) {
      throw const FormatException('CONTACT_CREATE_HAS_TARGET');
    }

    return _input();
  }

  models.ContactsUpdateInput updateInput() {
    final id = contactId;

    if (id == null || id.isEmpty) {
      throw const FormatException('CONTACT_UPDATE_REQUIRES_TARGET');
    }

    return models.ContactsUpdateInput(id: id, data: _input());
  }

  models.ContactsCreateInput _input() {
    if (validate().isNotEmpty) {
      throw const FormatException('INVALID_CONTACT_DRAFT');
    }

    return models.ContactsCreateInput(
      salutation: RpcOptional.value(_nullable(salutation)),
      firstName: RpcOptional.value(_nullable(firstName)),
      lastName: RpcOptional.value(_nullable(lastName)),
      address: RpcOptional.value(_address()),
      phoneNumbers: RpcOptional.value(List.unmodifiable([
        for (final phone in phoneNumbers)
          if (phone.value.trim().isNotEmpty)
            models.CustomerPhoneNumbersItem(
              name: RpcOptional.value(_nullable(phone.name)),
              number: phone.value.trim(),
            ),
      ])),
      emailAddresses: RpcOptional.value(List.unmodifiable([
        // The Webapp uses a text field; email syntax is server-validated.
        for (final email in emailAddresses)
          if (email.value.trim().isNotEmpty)
            models.CustomerEmailAddressesItem(
              name: RpcOptional.value(_nullable(email.name)),
              email: email.value.trim(),
            ),
      ])),
    );
  }

  models.ProjectAddress? _address() {
    final location = address;

    if (location == null) {
      return null;
    }

    return models.ProjectAddress(
      streetAddress: location.streetAddress.trim(),
      city: location.city.trim(),
      zip: RpcOptional.value(_nullable(location.zip.valueOrNull)),
      country: RpcOptional.value(_nullable(location.country.valueOrNull)),
    );
  }
}

String? _nullable(String? value) {
  final trimmed = value?.trim();

  return trimmed == null || trimmed.isEmpty ? null : trimmed;
}
