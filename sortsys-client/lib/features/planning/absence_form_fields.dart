import 'package:flutter/material.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

import '../../api/generated/models.g.dart' as models;
import '../../domain/planning.dart';
import '../../ui/text.dart';
import 'planning_data.dart';
import 'planning_draft.dart';

final class AbsenceFormValues {
  AbsenceFormValues({
    required this.currentUserId,
    required this.canManage,
    required DateTime initialDay,
  }) : fromDay = startOfDay(initialDay.toLocal()),
       toDay = startOfDay(initialDay.toLocal());

  final String currentUserId;
  final bool canManage;
  DateTime? fromDay;
  DateTime? toDay;
  models.UsersVacationsListResultItemType type =
      models.UsersVacationsListResultItemType.vacation;
  List<models.User> users = const [];
  final label = TextEditingController();
  final note = TextEditingController();

  AbsenceDraft draft() {
    final first = fromDay;
    final last = toDay;

    if (first == null || last == null) {
      throw const FormatException('INVALID_PLANNING_DATE_RANGE');
    }

    var userId = currentUserId;

    if (canManage) {
      if (users.length != 1) {
        throw const FormatException('ABSENCE_USER_REQUIRED');
      }

      userId = users.single.id;
    }

    final value = AbsenceDraft(
      userId: userId,
      from: first,
      to: last,
      type: type,
      label: label.text,
      note: note.text,
    );

    value.validate();

    return value;
  }

  void dispose() {
    label.dispose();
    note.dispose();
  }
}

class AbsenceFormFields extends StatefulWidget {
  const AbsenceFormFields({
    super.key,
    required this.values,
    required this.data,
    required this.identity,
    required this.checkCurrent,
    this.enabled = true,
  });

  final AbsenceFormValues values;
  final PlanningData data;
  final Object identity;
  final VoidCallback checkCurrent;
  final bool enabled;

  @override
  State<AbsenceFormFields> createState() {
    return _AbsenceFormFieldsState();
  }
}

class _AbsenceFormFieldsState extends State<AbsenceFormFields> {
  List<models.User> _users(String query) {
    widget.checkCurrent();

    if (widget.values.users.isNotEmpty) {
      return const [];
    }

    final needle = query.trim().toLowerCase();

    return widget.data.users
        .where((user) {
          return planningUserName(user).toLowerCase().contains(needle);
        })
        .toList(growable: false);
  }

  String? _userError(List<models.User>? value) {
    if (value?.length != 1) {
      return text(
        context,
        'Benutzer muss ausgewählt sein.',
        'Select one user.',
      );
    }

    return null;
  }

  String? _labelError(String? value) {
    final label = (value ?? '').trim();

    if (label.isEmpty) {
      return text(
        context,
        'Bezeichnung ist erforderlich.',
        'A label is required.',
      );
    }

    if (label.length > 63) {
      return text(
        context,
        'Bezeichnung ist zu lang.',
        'The label is too long.',
      );
    }

    return null;
  }

  Widget _date(bool first) {
    final values = widget.values;

    return SsDateField(
      label: first ? text(context, 'Von', 'From') : text(context, 'Bis', 'To'),
      clearLabel: text(context, 'Datum leeren', 'Clear date'),
      hint: text(context, 'TT.MM.JJJJ', 'DD.MM.YYYY'),
      initialValue: first ? values.fromDay : values.toDay,
      enabled: widget.enabled,
      validator: (value) {
        if (value == null) {
          return text(context, 'Pflichtfeld', 'Required field');
        }

        final from = values.fromDay;
        final reversed =
            !first &&
            from != null &&
            startOfDay(value).isBefore(startOfDay(from));

        if (reversed) {
          return text(
            context,
            'Bis darf nicht vor Von liegen.',
            'End must be on or after start.',
          );
        }

        return null;
      },
      onChanged: (value) {
        if (!widget.enabled) {
          return;
        }

        setState(() {
          if (first) {
            values.fromDay = value;
          } else {
            values.toDay = value;
          }
        });
      },
    );
  }

  Widget _period() {
    final from = _date(true);
    final to = _date(false);

    return LayoutBuilder(
      builder: (context, constraints) {
        final scale = MediaQuery.textScalerOf(context).scale(14) / 14;
        final stacked = constraints.maxWidth < 440 || scale > 1.4;

        if (stacked) {
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [from, const SizedBox(height: 8), to],
          );
        }

        return Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(child: from),
            const SizedBox(width: 8),
            Expanded(child: to),
          ],
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    final values = widget.values;
    final other = values.type == models.UsersVacationsListResultItemType.other;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        SsSelectField<models.UsersVacationsListResultItemType>(
          label: text(context, 'Typ', 'Type'),
          value: values.type,
          options: [
            SsOption(
              value: models.UsersVacationsListResultItemType.vacation,
              label: text(context, 'Urlaub', 'Leave'),
            ),
            SsOption(
              value: models.UsersVacationsListResultItemType.other,
              label: text(context, 'Sonstige Abwesenheit', 'Other absence'),
            ),
          ],
          onChanged: widget.enabled
              ? (value) {
                  setState(() {
                    values.type = value;
                  });
                }
              : null,
        ),
        if (other) ...[
          const SizedBox(height: 12),
          SsTextField(
            label: text(context, 'Bezeichnung', 'Label'),
            hint: text(
              context,
              'z. B. ÜLO oder Schulung',
              'e.g. training or time off',
            ),
            controller: values.label,
            enabled: widget.enabled,
            validator: _labelError,
          ),
        ],
        if (values.canManage) ...[
          const SizedBox(height: 12),
          SsMultiAutocompleteField<models.User>(
            label: text(context, 'Benutzer', 'User'),
            queryIdentity: (
              widget.identity,
              values.currentUserId,
              'absence-user',
            ),
            initialValue: values.users,
            enabled: widget.enabled,
            displayString: planningUserName,
            optionKey: (user) {
              return user.id;
            },
            loadOptions: _users,
            validator: _userError,
            onChanged: (selected) {
              if (!widget.enabled) {
                return;
              }

              setState(() {
                values.users = List<models.User>.unmodifiable(selected);
              });
            },
            removeLabel: text(context, 'Entfernen', 'Remove'),
            loadingText: text(
              context,
              'Auswahl wird geladen',
              'Loading options',
            ),
            emptyText: text(context, 'Keine Treffer', 'No matches'),
            failureText: text(
              context,
              'Auswahl konnte nicht geladen werden.',
              'Options could not be loaded.',
            ),
            selectionRequiredText: text(
              context,
              'Wähle einen Eintrag aus der Liste.',
              'Choose an option from the list.',
            ),
          ),
        ],
        const SizedBox(height: 12),
        _period(),
        const SizedBox(height: 12),
        SsTextField(
          label: text(context, 'Kommentar', 'Comment'),
          controller: values.note,
          enabled: widget.enabled,
          keyboardType: TextInputType.multiline,
          textInputAction: TextInputAction.newline,
          minLines: 4,
          maxLines: 12,
        ),
      ],
    );
  }
}
