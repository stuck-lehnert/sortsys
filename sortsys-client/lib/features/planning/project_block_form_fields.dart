import 'dart:convert';

import 'package:flutter/services.dart' show TextInputAction;
import 'package:flutter/widgets.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

import '../../api/generated/models.g.dart' as models;
import '../../domain/planning.dart';
import '../../ui/text.dart';
import 'planning_data.dart';
import 'planning_draft.dart';
import 'project_block_write_input.dart';

final class ProjectBlockFormValues {
  ProjectBlockFormValues({
    required DateTime from,
    required DateTime to,
    this.project,
    String reason = '',
    String? note,
  }) : fromDay = startOfDay(from),
       toDay = startOfDay(to),
       reason = TextEditingController(text: reason),
       note = TextEditingController(text: note ?? '');

  DateTime? fromDay;
  DateTime? toDay;
  models.Project? project;
  final TextEditingController reason;
  final TextEditingController note;

  ProjectBlockDraft draft() {
    final first = fromDay;
    final last = toDay;
    final selected = project;

    if (first == null || last == null) {
      throw const FormatException('INVALID_PLANNING_DATE_RANGE');
    }

    if (selected == null) {
      throw const FormatException('BLOCK_PROJECT_AND_REASON_REQUIRED');
    }

    final value = ProjectBlockDraft(
      projectId: selected.id,
      from: first,
      to: last,
      reason: reason.text,
      note: note.text,
    );

    validateProjectBlockWriteDraft(value);

    return value;
  }

  void dispose() {
    reason.dispose();
    note.dispose();
  }
}

class ProjectBlockFormFields extends StatefulWidget {
  const ProjectBlockFormFields({
    super.key,
    required this.values,
    required this.data,
    required this.identity,
    required this.checkCurrent,
    this.enabled = true,
  });

  final ProjectBlockFormValues values;
  final PlanningData data;
  final Object identity;
  final VoidCallback checkCurrent;
  final bool enabled;

  @override
  State<ProjectBlockFormFields> createState() {
    return _ProjectBlockFormFieldsState();
  }
}

class _ProjectBlockFormFieldsState extends State<ProjectBlockFormFields> {
  List<models.Project> _projects(String query) {
    widget.checkCurrent();

    final needle = query.trim().toLowerCase();
    final options = widget.data.projects.where((project) {
      return project.title.toLowerCase().contains(needle);
    });
    final result = List<models.Project>.unmodifiable(options);

    widget.checkCurrent();

    return result;
  }

  void _projectChanged(models.Project? selected) {
    if (!widget.enabled) {
      return;
    }

    setState(() {
      widget.values.project = selected;
    });
  }

  String? _reasonError(String? value) {
    final reason = (value ?? '').trim();

    if (reason.isEmpty) {
      return text(context, 'Pflichtfeld', 'Required field');
    }

    if (utf8.encode(reason).length > projectBlockReasonMaximumBytes) {
      return text(context, 'Grund ist zu lang.', 'Reason is too long.');
    }

    return null;
  }

  String? _noteError(String? value) {
    final note = (value ?? '').trim();

    if (utf8.encode(note).length > projectBlockNoteMaximumBytes) {
      return text(context, 'Kommentar ist zu lang.', 'Comment is too long.');
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

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        SsAutocompleteField<models.Project>(
          label: text(context, 'Projekt', 'Project'),
          queryIdentity: (widget.identity, 'project-block-project'),
          initialValue: values.project,
          enabled: widget.enabled,
          displayString: (project) {
            return project.title;
          },
          loadOptions: _projects,
          onChanged: _projectChanged,
          validator: (project) {
            if (project == null) {
              return text(context, 'Pflichtfeld', 'Required field');
            }

            return null;
          },
          loadingText: text(context, 'Auswahl wird geladen', 'Loading options'),
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
        const SizedBox(height: 12),
        _period(),
        const SizedBox(height: 12),
        SsTextField(
          label: text(context, 'Grund', 'Reason'),
          controller: values.reason,
          enabled: widget.enabled,
          textInputAction: TextInputAction.next,
          validator: _reasonError,
        ),
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
      ],
    );
  }
}
