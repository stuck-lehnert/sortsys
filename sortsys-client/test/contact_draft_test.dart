import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/api/model.dart';
import 'package:sortsys_client/features/contacts/contact_draft.dart';

void main() {
  test('contact query splits first token and joins remaining names', () {
    final empty = ContactDraft.fromQuery(' \t ');
    final single = ContactDraft.fromQuery('  Ada  ');
    final multiple = ContactDraft.fromQuery('  Ada\tAugusta  Lovelace\n ');

    expect(empty.firstName, '');
    expect(empty.lastName, '');
    expect(single.firstName, 'Ada');
    expect(single.lastName, '');
    expect(multiple.firstName, 'Ada');
    expect(multiple.lastName, 'Augusta Lovelace');
  });

  test('contact requires either name and applies exact UTF8 byte limit', () {
    final empty = ContactDraft(firstName: ' ', lastName: '\t');
    final boundary = List.filled(63, 'ä').join() + 'x';
    final oversized = List.filled(64, 'ä').join();

    expect(empty.validate(), {
      'firstName': ContactDraftIssue.nameRequired,
      'lastName': ContactDraftIssue.nameRequired,
    });
    expect(empty.createInput, throwsFormatException);
    expect(ContactDraft(firstName: boundary).validate(), isEmpty);
    expect(ContactDraft(lastName: boundary).validate(), isEmpty);
    expect(ContactDraft(firstName: oversized).validate(), {
      'firstName': ContactDraftIssue.tooLong,
    });
    expect(ContactDraft(lastName: oversized).validate(), {
      'lastName': ContactDraftIssue.tooLong,
    });
    expect(ContactDraft(lastName: 'Only').createInput().firstName.value, isNull);
  });

  test('contact retains raw text and submits all six canonical fields', () {
    final draft = ContactDraft(
      salutation: '  Dr  ',
      firstName: ' ',
      lastName: '  Person  ',
    );
    final input = draft.createInput();

    expect(draft.salutation, '  Dr  ');
    expect(draft.firstName, ' ');
    expect(draft.lastName, '  Person  ');
    expect(input.toWire().keys.toSet(), {
      'salutation', 'firstName', 'lastName', 'address',
      'phoneNumbers', 'emailAddresses',
    });
    expect(input.salutation.value, 'Dr');
    expect(input.firstName.hasValue, isTrue);
    expect(input.firstName.value, isNull);
    expect(input.lastName.value, 'Person');
    expect(input.address.hasValue, isTrue);
    expect(input.address.value, isNull);
    expect(input.phoneNumbers.value, isEmpty);
    expect(input.emailAddresses.value, isEmpty);

    final longSalutation = List.filled(300, 'ä').join();
    expect(ContactDraft(
      firstName: 'Person', salutation: longSalutation,
    ).createInput().salutation.value, longSalutation);
  });

  test('contact optional address requires street and city without guessed caps', () {
    final invalid = ContactDraft(
      firstName: 'Person',
      address: const models.ProjectAddress(streetAddress: ' ', city: ''),
    );
    final address = models.ProjectAddress(
      streetAddress: '  Street 1  ', city: '  City  ',
      zip: const RpcOptional.value(' '),
      country: const RpcOptional.value(' AT '),
    );
    final draft = ContactDraft(firstName: 'Person', address: address);
    final input = draft.createInput();

    expect(invalid.validate(), {
      'streetAddress': ContactDraftIssue.required,
      'city': ContactDraftIssue.required,
    });
    expect(invalid.createInput, throwsFormatException);
    expect(draft.address?.streetAddress, '  Street 1  ');
    expect(input.address.value?.streetAddress, 'Street 1');
    expect(input.address.value?.city, 'City');
    expect(input.address.value?.zip.hasValue, isTrue);
    expect(input.address.value?.zip.value, isNull);
    expect(input.address.value?.country.value, 'AT');
  });

  test('contact channels copy raw entries and filter blanks in original order', () {
    final phones = <ContactChannelDraft>[
      const ContactChannelDraft(name: ' Main ', value: ' +43 123 '),
      const ContactChannelDraft(name: 'discard', value: ' '),
      const ContactChannelDraft(name: ' ', value: ' +43 456 '),
    ];
    final emails = <ContactChannelDraft>[
      const ContactChannelDraft(name: ' Work ', value: ' a@example.test '),
      const ContactChannelDraft(value: ' '),
    ];
    final draft = ContactDraft(
      firstName: 'Person', phoneNumbers: phones, emailAddresses: emails,
    );

    phones.clear();
    emails.clear();
    final input = draft.createInput();

    expect(draft.phoneNumbers.first.value, ' +43 123 ');
    expect(input.phoneNumbers.value.map((phone) => phone.number), [
      '+43 123', '+43 456',
    ]);
    expect(input.phoneNumbers.value.first.name.value, 'Main');
    expect(input.phoneNumbers.value.last.name.value, isNull);
    expect(input.emailAddresses.value.single.name.value, 'Work');
    expect(input.emailAddresses.value.single.email, 'a@example.test');
    expect(() => draft.phoneNumbers.clear(), throwsUnsupportedError);
    expect(() => input.phoneNumbers.value.clear(), throwsUnsupportedError);
    expect(() => input.emailAddresses.value.clear(), throwsUnsupportedError);
  });

  test('contact edit snapshots source collections and pins target and kind', () {
    final phones = <models.CustomerPhoneNumbersItem>[
      const models.CustomerPhoneNumbersItem(number: '+43 123'),
    ];
    final contact = models.Contact(
      id: 'contact', firstName: 'Before',
      phoneNumbers: phones, emailAddresses: [],
      createdAt: DateTime.utc(2024), modifiedAt: DateTime.utc(2024, 2),
    );
    final draft = ContactDraft.fromContact(contact);

    phones.clear();
    final input = draft.updateInput();

    expect(draft.contactId, 'contact');
    expect(input.id, 'contact');
    expect(input.data.firstName.value, 'Before');
    expect(input.data.lastName.value, isNull);
    expect(input.data.phoneNumbers.value.single.number, '+43 123');
    expect(draft.createInput, throwsFormatException);
    expect(ContactDraft(firstName: 'Person').updateInput, throwsFormatException);
    expect(ContactDraft(
      contactId: '', firstName: 'Person',
    ).updateInput, throwsFormatException);
  });
}
