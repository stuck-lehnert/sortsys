import 'package:flutter/widgets.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

import '../../api/generated/models.g.dart' as api_models;
import '../../ui/text.dart';
import 'project_draft.dart';
import 'session_project_access.dart';

final class ProjectFormValues {
  ProjectFormValues(ProjectDraft draft)
    : title = TextEditingController(text: draft.title),
      street = TextEditingController(text: draft.streetAddress),
      city = TextEditingController(text: draft.city),
      zip = TextEditingController(text: draft.zip),
      country = TextEditingController(text: draft.country),
      useAddress = draft.useAddress,
      customerId = draft.customerId,
      leaderId = draft.projectLeaderId,
      orderReceivedAt = draft.orderReceivedAt;

  final TextEditingController title;
  final TextEditingController street;
  final TextEditingController city;
  final TextEditingController zip;
  final TextEditingController country;
  bool useAddress;
  String? customerId;
  String? leaderId;
  DateTime? orderReceivedAt;

  ProjectDraft draft() {
    return ProjectDraft(
      title: title.text,
      useAddress: useAddress,
      streetAddress: street.text,
      city: city.text,
      zip: zip.text,
      country: country.text,
      customerId: customerId,
      projectLeaderId: leaderId,
      orderReceivedAt: orderReceivedAt,
    );
  }

  void dispose() {
    title.dispose();
    street.dispose();
    city.dispose();
    zip.dispose();
    country.dispose();
  }

}

class ProjectFormFields extends StatefulWidget {
  const ProjectFormFields({
    super.key,
    required this.values,
    required this.access,
    this.customer,
    this.leader,
    this.enabled = true,
  });

  final ProjectFormValues values;
  final SessionProjectAccess access;
  final api_models.Customer? customer;
  final api_models.User? leader;
  final bool enabled;

  @override
  State<ProjectFormFields> createState() {
    return _ProjectFormFieldsState();
  }

}

class _ProjectFormFieldsState extends State<ProjectFormFields> {
  String? _required(String? value) {
    if (value == null || value.trim().isEmpty) {
      return text(context, 'Pflichtfeld', 'Required field');
    }

    return null;
  }

  Widget _helper(String de, String en) {
    return Padding(
      padding: const EdgeInsets.only(top: 6),
      child: Text(text(context, de, en), style: SsTheme.of(context).label),
    );
  }

  Widget _divider() {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 20),
      child: Container(height: 1, color: SsTheme.of(context).border),
    );
  }

  @override
  Widget build(BuildContext context) {
    final values = widget.values;
    final enabled = widget.enabled;
    final info = widget.access.session.info;
    final canViewCustomers = info?.can('view:customers') == true;
    final canViewUsers = info?.can('view:users') == true;
    final identity = widget.access.session.binding;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        SsTextField(
          label: text(context, 'Titel', 'Title'),
          controller: values.title,
          enabled: enabled,
          autofocus: true,
          validator: _required,
        ),
        _helper(
          'Verwende einen klaren Projektnamen, damit das Projekt in Listen schnell gefunden wird.',
          'Use a clear project name so the project is easy to find in lists.',
        ),
        const SizedBox(height: 20),
        SsDateField(
          label: text(context, 'Auftrag erhalten am', 'Order received on'),
          clearLabel: text(context, 'Datum leeren', 'Clear date'),
          hint: text(context, 'TT.MM.JJJJ', 'DD.MM.YYYY'),
          initialValue: values.orderReceivedAt,
          enabled: enabled,
          onChanged: (value) {
            values.orderReceivedAt = value;
          },

        ),
        _helper(
          'Wann wurde der Auftrag bestätigt bzw. erhalten?',
          'When was the order confirmed or received?',
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
          SsTextField(
            label: text(context, 'Straße & Hausnummer', 'Street and number'),
            controller: values.street,
            enabled: enabled,
            validator: _required,
          ),
          const SizedBox(height: 12),
          LayoutBuilder(
            builder: (context, constraints) {
              final fields = [
                SsTextField(
                  label: text(context, 'Postleitzahl', 'Postal code'),
                  controller: values.zip,
                  enabled: enabled,
                ),
                SsTextField(
                  label: text(context, 'Stadt', 'City'),
                  controller: values.city,
                  enabled: enabled,
                  validator: _required,
                ),
              ];
              final scale = MediaQuery.textScalerOf(context).scale(14) / 14;

              if (constraints.maxWidth < 400 || scale > 1.4) {
                return Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [fields[0], const SizedBox(height: 12), fields[1]],
                );
              }

              return Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(child: fields[0]),
                  const SizedBox(width: 12),
                  Expanded(flex: 2, child: fields[1]),
                ],
              );
            },

          ),
          const SizedBox(height: 12),
          SsTextField(
            label: text(context, 'Land/Staat', 'Country/state'),
            controller: values.country,
            enabled: enabled,
          ),
        ],
        _divider(),
        SsAutocompleteField<api_models.Customer>(
          label: text(context, 'Kunde', 'Customer'),
          queryIdentity: (identity, 'customers'),
          initialValue: widget.customer,
          enabled: enabled && canViewCustomers,
          loadOptions: widget.access.customers,
          displayString: (customer) {
            return customer.name;
          },

          selectionRequiredText: text(
            context,
            'Bitte einen Kunden aus der Liste auswählen.',
            'Choose a customer from the list.',
          ),
          onChanged: (customer) {
            values.customerId = customer?.id;
          },

        ),
        _helper(
          canViewCustomers
              ? 'Kunde für Zuordnung in Auswertungen und Exporten.'
              : 'Keine Berechtigung',
          canViewCustomers
              ? 'Customer used for reports and exports.'
              : 'No permission',
        ),
        const SizedBox(height: 20),
        SsAutocompleteField<api_models.User>(
          label: text(
            context,
            'Verantwortlicher Projektleiter',
            'Responsible project leader',
          ),
          queryIdentity: (identity, 'project-leaders'),
          initialValue: widget.leader,
          enabled: enabled && canViewUsers,
          loadOptions: widget.access.leaders,
          displayString: (user) {
            return [
              user.firstName,
              user.lastName,
            ].whereType<String>().join(' ');
          },

          selectionRequiredText: text(
            context,
            'Bitte einen Benutzer aus der Liste auswählen.',
            'Choose a user from the list.',
          ),
          onChanged: (user) {
            values.leaderId = user?.id;
          },

        ),
        _helper(
          canViewUsers
              ? 'Wer verantwortet das Projekt übergreifend?'
              : 'Keine Berechtigung',
          canViewUsers
              ? 'Who has overall responsibility for the project?'
              : 'No permission',
        ),
      ],
    );
  }

}
