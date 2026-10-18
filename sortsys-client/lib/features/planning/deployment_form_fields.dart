import 'dart:convert';

import 'package:flutter/services.dart' show TextInputAction;
import 'package:flutter/widgets.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

import '../../api/generated/models.g.dart' as models;
import '../../domain/planning.dart';
import '../../ui/text.dart';
import 'planning_data.dart';
import 'planning_draft.dart';
import 'planning_state.dart';

final class DeploymentFormValues {
  DeploymentFormValues({
    required DateTime from,
    required DateTime to,
    Iterable<models.User> users = const [],
    this.project,
    String? note,
  }) : fromDay = startOfDay(from.toLocal()),
       toDay = startOfDay(to.toLocal()),
       fromTime = TextEditingController(text: planningTimeText(from.toLocal())),
       toTime = TextEditingController(text: planningTimeText(to.toLocal())),
       note = TextEditingController(text: note ?? ''),
       users = List<models.User>.unmodifiable(users);

  DateTime? fromDay;
  DateTime? toDay;
  final TextEditingController fromTime;
  final TextEditingController toTime;
  final TextEditingController note;
  List<models.User> users;
  models.Project? project;

  DeploymentDraft draft() {
    final firstDay = fromDay;
    final lastDay = toDay;

    if (firstDay == null || lastDay == null) {
      throw const FormatException('INVALID_DEPLOYMENT_PERIOD');
    }

    final from = combinePlanningDateAndTime(
      planningDateText(firstDay),
      fromTime.text,
    );
    final to = combinePlanningDateAndTime(
      planningDateText(lastDay),
      toTime.text,
    );

    if (from == null || to == null) {
      throw const FormatException('INVALID_DEPLOYMENT_PERIOD');
    }

    final value = DeploymentDraft(
      userIds: users.map((user) {
        return user.id;
      }),
      projectId: project?.id ?? '',
      from: from,
      to: to,
      note: note.text,
    );

    value.validate();

    return value;
  }

  void dispose() {
    fromTime.dispose();
    toTime.dispose();
    note.dispose();
  }
}

class DeploymentFormFields extends StatefulWidget {
  const DeploymentFormFields({
    super.key,
    required this.values,
    required this.data,
    required this.identity,
    required this.checkCurrent,
    this.editing = false,
    this.enabled = true,
  });

  final DeploymentFormValues values;
  final PlanningData data;
  final Object identity;
  final VoidCallback checkCurrent;
  final bool editing;
  final bool enabled;

  @override
  State<DeploymentFormFields> createState() {
    return _DeploymentFormFieldsState();
  }
}

class _DeploymentFormFieldsState extends State<DeploymentFormFields> {
  List<models.User> _userOptions(String query) {
    widget.checkCurrent();

    if (widget.editing && widget.values.users.isNotEmpty) {
      return const [];
    }

    final needle = query.trim().toLowerCase();
    final options = widget.data.users
        .where((user) {
          return planningUserName(user).toLowerCase().contains(needle);
        })
        .toList(growable: false);

    return options;
  }

  List<models.Project> _projectOptions(String query) {
    widget.checkCurrent();

    final needle = query.trim().toLowerCase();
    final options = widget.data.projects
        .where((project) {
          return project.title.toLowerCase().contains(needle);
        })
        .toList(growable: false);

    return options;
  }

  void _usersChanged(List<models.User> selected) {
    if (!widget.enabled) {
      return;
    }

    setState(() {
      widget.values.users = List<models.User>.unmodifiable(selected);
    });
  }

  void _projectChanged(models.Project? project) {
    if (!widget.enabled) {
      return;
    }

    setState(() {
      widget.values.project = project;
    });
  }

  String? _userError(List<models.User>? selected) {
    final count = selected?.length ?? 0;

    if (count == 0) {
      return text(context, 'Pflichtfeld', 'Required field');
    }

    if (widget.editing && count != 1) {
      return text(context, 'Wähle einen Mitarbeiter.', 'Choose one employee.');
    }

    return null;
  }

  String? _dateError(DateTime? value) {
    if (value == null) {
      return text(context, 'Pflichtfeld', 'Required field');
    }

    return null;
  }

  DateTime? _instant(DateTime? day, String value) {
    if (day == null) {
      return null;
    }

    return combinePlanningDateAndTime(planningDateText(day), value);
  }

  String? _timeError(bool start, String? value) {
    final values = widget.values;
    final day = start ? values.fromDay : values.toDay;
    final raw = value ?? '';

    if (raw.trim().isEmpty) {
      return text(context, 'Pflichtfeld', 'Required field');
    }

    if (day == null) {
      return null;
    }

    final instant = _instant(day, raw);

    if (instant == null) {
      return text(
        context,
        'Ungültige Uhrzeit (HH:mm).',
        'Invalid time (HH:mm).',
      );
    }

    if (!start) {
      final from = _instant(values.fromDay, values.fromTime.text);

      if (from != null && !from.isBefore(instant)) {
        return text(
          context,
          'Von muss vor Bis liegen.',
          'Start must be before end.',
        );
      }
    }

    return null;
  }

  String? _noteError(String? value) {
    final normalized = (value ?? '').trim();
    final byteLength = utf8.encode(normalized).length;

    if (byteLength > 255) {
      return text(context, 'Kommentar ist zu lang.', 'Comment is too long.');
    }

    return null;
  }

  Widget _dateAndTime(bool start) {
    final values = widget.values;
    final day = start ? values.fromDay : values.toDay;
    final controller = start ? values.fromTime : values.toTime;
    final dateLabel = start
        ? text(context, 'Von (Datum)', 'From (date)')
        : text(context, 'Bis (Datum)', 'To (date)');
    final timeLabel = start
        ? text(context, 'Von (Uhrzeit)', 'From (time)')
        : text(context, 'Bis (Uhrzeit)', 'To (time)');
    final date = SsDateField(
      label: dateLabel,
      clearLabel: text(context, 'Datum leeren', 'Clear date'),
      hint: text(context, 'TT.MM.JJJJ', 'DD.MM.YYYY'),
      initialValue: day,
      enabled: widget.enabled,
      validator: _dateError,
      onChanged: (next) {
        if (!widget.enabled) {
          return;
        }

        setState(() {
          if (start) {
            values.fromDay = next;
          } else {
            values.toDay = next;
          }
        });
      },
    );
    final time = SsTextField(
      label: timeLabel,
      hint: 'HH:mm',
      controller: controller,
      enabled: widget.enabled,
      keyboardType: TextInputType.datetime,
      textInputAction: TextInputAction.next,
      autocorrect: false,
      enableSuggestions: false,
      validator: (value) {
        return _timeError(start, value);
      },
    );

    return LayoutBuilder(
      builder: (context, constraints) {
        final scale = MediaQuery.textScalerOf(context).scale(14) / 14;
        final stacked = constraints.maxWidth < 440 || scale > 1.4;

        if (stacked) {
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [date, const SizedBox(height: 8), time],
          );
        }

        return Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(child: date),
            const SizedBox(width: 8),
            Expanded(child: time),
          ],
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    final values = widget.values;
    final loading = text(context, 'Auswahl wird geladen', 'Loading options');
    final empty = text(context, 'Keine Treffer', 'No matches');
    final failure = text(
      context,
      'Auswahl konnte nicht geladen werden.',
      'Options could not be loaded.',
    );
    final selectionRequired = text(
      context,
      'Wähle einen Eintrag aus der Liste.',
      'Choose an option from the list.',
    );

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        SsMultiAutocompleteField<models.User>(
          label: widget.editing
              ? text(context, 'Mitarbeiter', 'Employee')
              : text(context, 'Mitarbeitende', 'Employees'),
          queryIdentity: (widget.identity, 'deployment-users', widget.editing),
          initialValue: values.users,
          enabled: widget.enabled,
          displayString: planningUserName,
          optionKey: (user) {
            return user.id;
          },
          loadOptions: _userOptions,
          onChanged: _usersChanged,
          validator: _userError,
          removeLabel: text(context, 'Entfernen', 'Remove'),
          loadingText: loading,
          emptyText: empty,
          failureText: failure,
          selectionRequiredText: selectionRequired,
        ),
        const SizedBox(height: 12),
        SsAutocompleteField<models.Project>(
          label: text(context, 'Projekt', 'Project'),
          queryIdentity: (widget.identity, 'deployment-project'),
          initialValue: values.project,
          enabled: widget.enabled,
          displayString: (project) {
            return project.title;
          },
          loadOptions: _projectOptions,
          onChanged: _projectChanged,
          validator: (project) {
            if (project == null) {
              return text(context, 'Pflichtfeld', 'Required field');
            }

            return null;
          },
          loadingText: loading,
          emptyText: empty,
          failureText: failure,
          selectionRequiredText: selectionRequired,
        ),
        const SizedBox(height: 12),
        _dateAndTime(true),
        const SizedBox(height: 12),
        _dateAndTime(false),
        const SizedBox(height: 12),
        SsTextField(
          label: text(context, 'Kommentar', 'Comment'),
          controller: values.note,
          enabled: widget.enabled,
          keyboardType: TextInputType.multiline,
          textInputAction: TextInputAction.newline,
          minLines: 4,
          maxLines: 12,
          validator: _noteError,
        ),
        const SizedBox(height: 4),
        Text(
          text(
            context,
            'Zusatzinfo zum Einsatz, z. B. Materialfahrt oder Baustellenwechsel.',
            'Additional assignment information, such as material transport or a site change.',
          ),
          style: SsTheme.of(context).label,
        ),
      ],
    );
  }
}
