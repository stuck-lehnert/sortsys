import 'dart:convert';

import '../../api/generated/models.g.dart' as models;
import '../../api/model.dart';
import 'planning_draft.dart';

const projectBlockReasonMaximumBytes = 127;
const projectBlockNoteMaximumBytes = 255;

void validateProjectBlockWriteDraft(ProjectBlockDraft draft) {
  draft.validate();

  final reasonBytes = utf8.encode(draft.reason.trim()).length;
  final noteBytes = utf8.encode(draft.note.trim()).length;

  if (reasonBytes > projectBlockReasonMaximumBytes) {
    throw const FormatException('BLOCK_REASON_TOO_LONG');
  }

  if (noteBytes > projectBlockNoteMaximumBytes) {
    throw const FormatException('BLOCK_NOTE_TOO_LONG');
  }
}

models.ProjectsUnavailabilityUpdateInput? projectBlockWriteInput(
  ProjectBlockDraft draft,
  models.ProjectsUnavailabilityListResultItem baseline,
) {
  validateProjectBlockWriteDraft(draft);

  final input = draft.updateInput(baseline);

  if (input == null) {
    return null;
  }

  final data = input.data;
  var fromField = data.from;
  var toField = data.to;

  // Retain absent/undefined/null states; normalize only selected date values.
  if (fromField.hasValue && fromField.valueOrNull != null) {
    fromField = RpcOptional.value(_utcCivilDay(draft.from));
  }

  if (toField.hasValue && toField.valueOrNull != null) {
    toField = RpcOptional.value(_utcCivilDay(draft.to));
  }

  final normalized = models.ProjectsUnavailabilityUpdateRequestData(
    projectId: data.projectId,
    from: fromField,
    to: toField,
    reason: data.reason,
    note: data.note,
  );

  return models.ProjectsUnavailabilityUpdateInput(
    id: input.id,
    data: normalized,
  );
}

DateTime _utcCivilDay(DateTime value) {
  return DateTime.utc(value.year, value.month, value.day);
}
