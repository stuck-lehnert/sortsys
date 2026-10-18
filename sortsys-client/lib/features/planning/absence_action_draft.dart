import 'dart:convert';

import '../../api/generated/models.g.dart' as models;

enum AbsenceActionKind { approve, deny, delete }

const absenceDenialReasonMaximumBytes = 255;

final class AbsenceActionDraft {
  const AbsenceActionDraft.approve()
    : kind = AbsenceActionKind.approve,
      denialReason = '';

  const AbsenceActionDraft.deny(this.denialReason)
    : kind = AbsenceActionKind.deny;

  const AbsenceActionDraft.delete()
    : kind = AbsenceActionKind.delete,
      denialReason = '';

  final AbsenceActionKind kind;
  final String denialReason;

  String get normalizedDenialReason {
    return denialReason.trim();
  }

  void validate() {
    if (kind != AbsenceActionKind.deny) {
      return;
    }

    final reason = normalizedDenialReason;

    if (reason.isEmpty) {
      throw const FormatException('ABSENCE_DENIAL_REASON_REQUIRED');
    }

    if (utf8.encode(reason).length > absenceDenialReasonMaximumBytes) {
      throw const FormatException('ABSENCE_DENIAL_REASON_TOO_LONG');
    }
  }

  /// Callers must refresh this scoped server snapshot under their write lock.
  void validateFor(models.UsersVacationsListResultItem baseline) {
    validate();

    if (baseline.id.trim().isEmpty || baseline.userId.trim().isEmpty) {
      throw const FormatException('INVALID_ABSENCE_ACTION_BASELINE');
    }

    final requested =
        baseline.status == models.UsersVacationsListResultItemStatus.requested;
    final permitted = switch (kind) {
      AbsenceActionKind.approve => requested && baseline.canApprove,
      AbsenceActionKind.deny => requested && baseline.canDeny,
      AbsenceActionKind.delete => baseline.canDelete,
    };

    if (!permitted) {
      throw StateError('ABSENCE_ACTION_NOT_ALLOWED');
    }
  }

  models.UsersVacationsApproveInput approveInput(
    models.UsersVacationsListResultItem baseline,
  ) {
    _requireKind(AbsenceActionKind.approve);
    validateFor(baseline);

    return models.UsersVacationsApproveInput(id: baseline.id);
  }

  models.UsersVacationsDenyInput denyInput(
    models.UsersVacationsListResultItem baseline,
  ) {
    _requireKind(AbsenceActionKind.deny);
    validateFor(baseline);

    return models.UsersVacationsDenyInput(
      id: baseline.id,
      reason: normalizedDenialReason,
    );
  }

  models.UsersVacationsDeleteInput deleteInput(
    models.UsersVacationsListResultItem baseline,
  ) {
    _requireKind(AbsenceActionKind.delete);
    validateFor(baseline);

    return models.UsersVacationsDeleteInput(id: baseline.id);
  }

  void _requireKind(AbsenceActionKind expected) {
    if (kind != expected) {
      throw StateError('ABSENCE_ACTION_KIND_MISMATCH');
    }
  }
}

/// Verifies a known decision target, not submission or deletion.
bool absenceDecisionMatchesTarget({
  required AbsenceActionDraft draft,
  required models.UsersVacationsListResultItem baseline,
  required String actorUserId,
  required models.UsersVacationsListResultItem? actual,
}) {
  if (draft.kind == AbsenceActionKind.delete) {
    throw const FormatException('ABSENCE_DECISION_REQUIRED');
  }

  draft.validateFor(baseline);

  if (actorUserId.trim().isEmpty) {
    throw const FormatException('ABSENCE_ACTOR_REQUIRED');
  }

  if (actual == null) {
    return false;
  }

  final approving = draft.kind == AbsenceActionKind.approve;
  final targetStatus = approving
      ? models.UsersVacationsListResultItemStatus.approved
      : models.UsersVacationsListResultItemStatus.denied;
  final targetReason = approving ? null : draft.normalizedDenialReason;

  return actual.id == baseline.id &&
      actual.userId == baseline.userId &&
      _sameCivilDay(actual.from, baseline.from) &&
      _sameCivilDay(actual.to, baseline.to) &&
      actual.type == baseline.type &&
      actual.label == baseline.label &&
      actual.note == baseline.note &&
      actual.requestedByUserId == baseline.requestedByUserId &&
      actual.createdAt.isAtSameMomentAs(baseline.createdAt) &&
      actual.status == targetStatus &&
      actual.denialReason == targetReason &&
      actual.decidedByUserId == actorUserId &&
      actual.decidedAt != null;
}

bool _sameCivilDay(DateTime left, DateTime right) {
  return left.year == right.year &&
      left.month == right.month &&
      left.day == right.day;
}
