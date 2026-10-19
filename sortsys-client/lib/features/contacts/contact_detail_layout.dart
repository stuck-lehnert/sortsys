import 'package:flutter/widgets.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

import '../../api/generated/models.g.dart' as models;
import '../../ui/entity_external_link.dart';
import '../../ui/text.dart';
import '../customers/customer_list_state.dart';
import '../projects/project_related_sections.dart';

String contactName(models.Contact contact) {
  final fullName = [contact.firstName, contact.lastName]
      .whereType<String>()
      .where((part) {
        return part.isNotEmpty;
      })
      .join(' ');
  final salutation = contact.salutation;

  if (salutation != null && salutation.isNotEmpty) {
    return '$salutation $fullName';
  }

  return fullName;
}

class ContactDetailLayout extends StatelessWidget {
  const ContactDetailLayout({
    super.key,
    required this.contact,
    required this.child,
  });

  final models.Contact contact;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final address = contact.address;
    final title = contactName(contact);
    final hasChannels = contact.emailAddresses.isNotEmpty ||
        contact.phoneNumbers.isNotEmpty;
    final content = ListView(
      padding: EdgeInsets.zero,
      children: [
        SsPageHeader(title: title),
        SsAttributeList(
          children: [
            if (contact.salutation?.isNotEmpty == true)
              SsAttribute(
                label: text(context, 'Anrede', 'Salutation'),
                child: Text(contact.salutation!),
              ),
            SsAttribute(
              label: text(context, 'Vorname', 'First name'),
              child: Text(contact.firstName ?? ''),
            ),
            if (contact.lastName?.isNotEmpty == true)
              SsAttribute(
                label: text(context, 'Nachname', 'Last name'),
                child: Text(contact.lastName!),
              ),
            if (address != null)
              SsAttribute(
                label: text(context, 'Anschrift', 'Address'),
                child: EntityExternalLink(
                  uri: projectAddressUrl(address),
                  label: customerAddress(address),
                ),
              ),
          ],
        ),
        if (hasChannels) ...[
          const SizedBox(height: 8.8),
          ContactChannelAttributes(
            emailAddresses: contact.emailAddresses,
            phoneNumbers: contact.phoneNumbers,
          ),
        ],
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 12),
          child: Container(height: 1, color: SsTheme.of(context).border),
        ),
        child,
      ],
    );

    if (title.isEmpty) {
      return content;
    }

    return Title(
      title: title,
      color: SsTheme.of(context).surface,
      child: content,
    );
  }
}

class ContactChannelAttributes extends StatelessWidget {
  const ContactChannelAttributes({
    super.key,
    required this.emailAddresses,
    required this.phoneNumbers,
    this.localizedFallbacks = true,
  });

  final List<models.CustomerEmailAddressesItem> emailAddresses;
  final List<models.CustomerPhoneNumbersItem> phoneNumbers;
  final bool localizedFallbacks;

  @override
  Widget build(BuildContext context) {
    return SsAttributeList(
      children: contactChannelFields(
        context,
        emailAddresses: emailAddresses,
        phoneNumbers: phoneNumbers,
        localizedFallbacks: localizedFallbacks,
      ),
    );
  }
}

List<Widget> contactChannelFields(
  BuildContext context, {
  required List<models.CustomerEmailAddressesItem> emailAddresses,
  required List<models.CustomerPhoneNumbersItem> phoneNumbers,
  bool localizedFallbacks = true,
}) {
  return [
    for (final (index, email) in emailAddresses.indexed)
      SsAttribute(
        label: email.name.valueOrNull ??
            (localizedFallbacks
                ? text(context, 'E-Mail ${index + 1}', 'Email ${index + 1}')
                : 'E-Mail ${index + 1}'),
        child: EntityExternalLink(
          uri: Uri(scheme: 'mailto', path: email.email),
          label: email.email,
        ),
      ),
    for (final (index, phone) in phoneNumbers.indexed)
      SsAttribute(
        label: phone.name.valueOrNull ??
            (localizedFallbacks
                ? text(context, 'Telefon ${index + 1}', 'Phone ${index + 1}')
                : 'Telefon ${index + 1}'),
        child: EntityExternalLink(
          uri: Uri(scheme: 'tel', path: phone.number),
          label: phone.number,
        ),
      ),
  ];
}
