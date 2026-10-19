import 'package:flutter/widgets.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

import '../../api/generated/models.g.dart' as models;
import '../../api/model.dart';
import '../../ui/text.dart';
import 'contact_draft.dart';

final class ContactChannelValues {
  ContactChannelValues({
    required this.email,
    String name = '',
    String value = '',
  }) : name = TextEditingController(text: name),
       value = TextEditingController(text: value);

  final bool email;
  final TextEditingController name;
  final TextEditingController value;
  final FocusNode nameFocus = FocusNode();

  void dispose() {
    name.dispose();
    value.dispose();
    nameFocus.dispose();
  }
}

final class ContactFormValues {
  ContactFormValues(ContactDraft seed)
    : contactId = seed.contactId,
      salutation = TextEditingController(text: seed.salutation),
      firstName = TextEditingController(text: seed.firstName),
      lastName = TextEditingController(text: seed.lastName),
      street = TextEditingController(text: seed.address?.streetAddress),
      zip = TextEditingController(text: seed.address?.zip.valueOrNull),
      city = TextEditingController(text: seed.address?.city),
      country = TextEditingController(text: seed.address?.country.valueOrNull),
      useAddress = seed.address != null,
      channels = [
        for (final phone in seed.phoneNumbers)
          ContactChannelValues(
            email: false,
            name: phone.name,
            value: phone.value,
          ),
        for (final email in seed.emailAddresses)
          ContactChannelValues(
            email: true,
            name: email.name,
            value: email.value,
          ),
      ];

  final String? contactId;
  final TextEditingController salutation;
  final TextEditingController firstName;
  final TextEditingController lastName;
  final TextEditingController street;
  final TextEditingController zip;
  final TextEditingController city;
  final TextEditingController country;
  final List<ContactChannelValues> channels;
  final List<ContactChannelValues> _removed = [];
  bool useAddress;

  ContactDraft draft() {
    return ContactDraft(
      contactId: contactId,
      salutation: salutation.text,
      firstName: firstName.text,
      lastName: lastName.text,
      address: !useAddress
          ? null
          : models.ProjectAddress(
              streetAddress: street.text,
              city: city.text,
              zip: RpcOptional.value(zip.text),
              country: RpcOptional.value(country.text),
            ),
      phoneNumbers: [
        for (final channel in channels)
          if (!channel.email)
            ContactChannelDraft(
              name: channel.name.text,
              value: channel.value.text,
            ),
      ],
      emailAddresses: [
        for (final channel in channels)
          if (channel.email)
            ContactChannelDraft(
              name: channel.name.text,
              value: channel.value.text,
            ),
      ],
    );
  }

  void removeChannel(ContactChannelValues channel) {
    if (!channels.remove(channel)) {
      return;
    }

    // Keep removed controllers alive until their fields have unmounted.
    _removed.add(channel);
  }

  void dispose() {
    salutation.dispose();
    firstName.dispose();
    lastName.dispose();
    street.dispose();
    zip.dispose();
    city.dispose();
    country.dispose();

    for (final channel in [...channels, ..._removed]) {
      channel.dispose();
    }
  }
}

class ContactFormFields extends StatefulWidget {
  const ContactFormFields({
    super.key,
    required this.values,
    this.enabled = true,
  });

  final ContactFormValues values;
  final bool enabled;

  @override
  State<ContactFormFields> createState() {
    return _ContactFormFieldsState();
  }
}

class _ContactFormFieldsState extends State<ContactFormFields> {
  String? _required(String? value) {
    if (value?.trim().isNotEmpty != true) {
      return text(context, 'Pflichtfeld', 'Required field');
    }

    return null;
  }

  String? _nameIssue(String field) {
    final issue = widget.values.draft().validate()[field];

    if (issue == ContactDraftIssue.nameRequired) {
      return text(
        context,
        'Vorname oder Nachname ist erforderlich',
        'First name or last name is required',
      );
    }

    if (issue == ContactDraftIssue.tooLong) {
      return text(
        context,
        'Höchstens 127 UTF-8-Bytes.',
        'Maximum 127 UTF-8 bytes.',
      );
    }

    return null;
  }

  Widget _input(
    String de,
    String en,
    TextEditingController controller, {
    bool required = false,
  }) {
    return SsTextField(
      label: text(context, de, en),
      controller: controller,
      enabled: widget.enabled,
      validator: required ? _required : null,
    );
  }

  Widget _divider() {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 20),
      child: Container(height: 1, color: SsTheme.of(context).border),
    );
  }

  Widget _pair(Widget first, Widget second) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final scale = MediaQuery.textScalerOf(context).scale(14) / 14;

        if (constraints.maxWidth < 400 || scale > 1.4) {
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [first, const SizedBox(height: 12), second],
          );
        }

        return Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(child: first),
            const SizedBox(width: 8),
            Expanded(child: second),
          ],
        );
      },
    );
  }

  void _addChannel(bool email) {
    final channel = ContactChannelValues(email: email);

    setState(() {
      widget.values.channels.add(channel);
    });

    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && widget.values.channels.contains(channel)) {
        channel.nameFocus.requestFocus();
      }
    });
  }

  Widget _channel(ContactChannelValues channel) {
    return Padding(
      key: ObjectKey(channel),
      padding: const EdgeInsets.only(bottom: 12),
      child: _pair(
        SsTextField(
          label: text(context, 'Bezeichnung', 'Label'),
          controller: channel.name,
          focusNode: channel.nameFocus,
          enabled: widget.enabled,
        ),
        SsTextField(
          label: channel.email
              ? text(context, 'E-Mail', 'Email')
              : text(context, 'Telefon', 'Phone'),
          controller: channel.value,
          keyboardType: channel.email
              ? TextInputType.emailAddress
              : TextInputType.phone,
          enabled: widget.enabled,
          validator: _required,
          suffix: SsIconButton(
            icon: 'trash-can',
            label: text(context, 'Eintrag entfernen', 'Remove entry'),
            onPressed: !widget.enabled
                ? null
                : () {
                    setState(() {
                      widget.values.removeChannel(channel);
                    });
                  },
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final values = widget.values;
    final enabled = widget.enabled;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _input('Anrede', 'Salutation', values.salutation),
        const SizedBox(height: 12),
        SsTextField(
          label: text(context, 'Vorname', 'First name'),
          controller: values.firstName,
          enabled: enabled,
          validator: (value) {
            return _nameIssue('firstName');
          },
        ),
        const SizedBox(height: 12),
        SsTextField(
          label: text(context, 'Nachname', 'Last name'),
          controller: values.lastName,
          enabled: enabled,
          validator: (value) {
            return _nameIssue('lastName');
          },
        ),
        _divider(),
        SsCheckbox(
          value: values.useAddress,
          label: text(context, 'Anschrift hinterlegen', 'Add address'),
          onChanged: !enabled
              ? null
              : (value) {
                  setState(() {
                    values.useAddress = value;
                  });
                },
        ),
        if (values.useAddress) ...[
          const SizedBox(height: 8),
          _input(
            'Straße & Hausnummer',
            'Street and number',
            values.street,
            required: true,
          ),
          const SizedBox(height: 12),
          _pair(
            _input('Postleitzahl', 'Postal code', values.zip),
            _input('Stadt', 'City', values.city, required: true),
          ),
          const SizedBox(height: 12),
          _input('Land/Staat', 'Country/state', values.country),
        ],
        _divider(),
        for (final channel in values.channels) _channel(channel),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            SsButton(
              kind: SsButtonKind.secondary,
              onPressed: !enabled
                  ? null
                  : () {
                      _addChannel(true);
                    },
              child: Text(text(context, 'E-Mail', 'Email')),
            ),
            SsButton(
              kind: SsButtonKind.secondary,
              onPressed: !enabled
                  ? null
                  : () {
                      _addChannel(false);
                    },
              child: Text(text(context, 'Telefon', 'Phone')),
            ),
          ],
        ),
      ],
    );
  }
}
