import 'dart:convert';

import 'package:flutter/widgets.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

import '../../api/generated/models.g.dart' as models;
import '../../api/model.dart';
import '../../ui/text.dart';
import 'customer_draft.dart';
import 'customer_write.dart';

final class CustomerChannelValues {
  CustomerChannelValues({
    required this.email,
    String? name,
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

final class CustomerFormValues {
  CustomerFormValues(CustomerEditorSeed seed)
    : salutation = TextEditingController(text: seed.customer?.salutation),
      name = TextEditingController(text: seed.customer?.name),
      street = TextEditingController(
        text: seed.customer?.address?.streetAddress,
      ),
      zip = TextEditingController(text: seed.customer?.address?.zip.valueOrNull),
      city = TextEditingController(text: seed.customer?.address?.city),
      country = TextEditingController(
        text: seed.customer?.address?.country.valueOrNull,
      ),
      useAddress = seed.customer?.address != null,
      contacts = seed.contacts == null ? null : List.of(seed.contacts!),
      channels = [
        for (final phone in seed.customer?.phoneNumbers ??
            const <models.CustomerPhoneNumbersItem>[])
          CustomerChannelValues(
            email: false,
            name: phone.name.valueOrNull,
            value: phone.number,
          ),
        for (final email in seed.customer?.emailAddresses ??
            const <models.CustomerEmailAddressesItem>[])
          CustomerChannelValues(
            email: true,
            name: email.name.valueOrNull,
            value: email.email,
          ),
      ];

  final TextEditingController salutation;
  final TextEditingController name;
  final TextEditingController street;
  final TextEditingController zip;
  final TextEditingController city;
  final TextEditingController country;
  final List<CustomerChannelValues> channels;
  final List<CustomerChannelValues> _removed = [];
  bool useAddress;
  List<models.Contact>? contacts;

  void removeChannel(CustomerChannelValues channel) {
    channels.remove(channel);
    // Keep controllers alive until removed fields have unmounted.
    _removed.add(channel);
  }

  CustomerDraft draft() {
    return CustomerDraft(
      name: name.text,
      salutation: salutation.text,
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
            models.CustomerPhoneNumbersItem(
              name: RpcOptional.value(channel.name.text),
              number: channel.value.text,
            ),
      ],
      emailAddresses: [
        for (final channel in channels)
          if (channel.email)
            models.CustomerEmailAddressesItem(
              name: RpcOptional.value(channel.name.text),
              email: channel.value.text,
            ),
      ],
      contactIds: contacts?.map((contact) {
        return contact.id;
      }).toList(),
    );
  }

  void dispose() {
    salutation.dispose();
    name.dispose();
    street.dispose();
    zip.dispose();
    city.dispose();
    country.dispose();

    for (final channel in [...channels, ..._removed]) {
      channel.dispose();
    }
  }
}

class CustomerFormFields extends StatefulWidget {
  const CustomerFormFields({
    super.key,
    required this.values,
    required this.queryIdentity,
    required this.loadContacts,
    this.enabled = true,
  });

  final CustomerFormValues values;
  final Object queryIdentity;
  final Future<List<models.Contact>> Function(String query) loadContacts;
  final bool enabled;

  @override
  State<CustomerFormFields> createState() {
    return _CustomerFormFieldsState();
  }
}

class _CustomerFormFieldsState extends State<CustomerFormFields> {
  String? _required(String? value) {
    if (value?.trim().isNotEmpty != true) {
      return text(context, 'Pflichtfeld', 'Required field');
    }

    return null;
  }

  String? _nameValidator(String? value) {
    final required = _required(value);

    if (required != null) {
      return required;
    }

    if (utf8.encode(value!.trim()).length > 127) {
      return text(
        context,
        'Der Name darf höchstens 127 UTF-8-Bytes enthalten.',
        'The name must not exceed 127 UTF-8 bytes.',
      );
    }

    return null;
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

  void _addChannel(bool email) {
    final channel = CustomerChannelValues(email: email);

    setState(() {
      widget.values.channels.add(channel);
    });
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && widget.values.channels.contains(channel)) {
        channel.nameFocus.requestFocus();
      }
    });
  }

  Widget _channel(CustomerChannelValues channel) {
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
          label: text(context, 'Name', 'Name'),
          controller: values.name,
          enabled: enabled,
          validator: _nameValidator,
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
            'Straße & Hausnummer', 'Street and number', values.street,
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
        _divider(),
        if (values.contacts != null)
          SsMultiAutocompleteField<models.Contact>(
            label: text(context, 'Ansprechpartner', 'Contacts'),
            initialValue: values.contacts!,
            enabled: enabled,
            queryIdentity: widget.queryIdentity,
            loadOptions: widget.loadContacts,
            displayString: (contact) {
              return [contact.salutation, contact.firstName, contact.lastName]
                  .whereType<String>()
                  .where((part) {
                    return part.isNotEmpty;
                  })
                  .join(' ');
            },
            optionKey: (contact) {
              return contact.id;
            },
            onChanged: (contacts) {
              values.contacts = List.of(contacts);
            },
          ),
      ],
    );
  }
}
