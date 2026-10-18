import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/features/planning/absence_action_draft.dart';

final _day = DateTime.utc(2026, 10, 12);
const _approved = models.UsersVacationsListResultItemStatus.approved;
const _denied = models.UsersVacationsListResultItemStatus.denied;

void main() {
  test('actions produce exact generated payloads without unrelated fields', () {
    final baseline = _row();
    const approval = AbsenceActionDraft.approve();
    const denial = AbsenceActionDraft.deny('  Not available \n');
    const deletion = AbsenceActionDraft.delete();

    expect(approval.approveInput(baseline).toWire(), {'id': 'absence'});
    expect(denial.denyInput(baseline).toWire(), {
      'id': 'absence',
      'reason': 'Not available',
    });
    expect(deletion.deleteInput(baseline).toWire(), {'id': 'absence'});
    expect(denial.denialReason, '  Not available \n');
    expect(approval.kind, AbsenceActionKind.approve);
    expect(denial.kind, AbsenceActionKind.deny);
    expect(deletion.kind, AbsenceActionKind.delete);
  });

  test('fresh server capabilities and requested status govern each action', () {
    const approval = AbsenceActionDraft.approve();
    const denial = AbsenceActionDraft.deny('Not available');
    const deletion = AbsenceActionDraft.delete();

    expect(
      () => approval.approveInput(_row(canApprove: false)),
      throwsStateError,
    );
    expect(() => denial.denyInput(_row(canDeny: false)), throwsStateError);
    expect(
      () => deletion.deleteInput(_row(canDelete: false)),
      throwsStateError,
    );
    expect(
      () => approval.approveInput(_row(status: _approved)),
      throwsStateError,
    );
    expect(() => denial.denyInput(_row(status: _denied)), throwsStateError);
    expect(deletion.deleteInput(_row(status: _approved)).id, 'absence');
    expect(() => approval.approveInput(_row(id: '')), throwsFormatException);
    expect(
      () => deletion.deleteInput(_row(userId: '   ')),
      throwsFormatException,
    );
  });

  test('denial validates trimmed UTF8 bytes without changing the raw text', () {
    final maximum = '${List.filled(127, 'é').join()}a';
    final raw = ' \n$maximum\t ';
    final overflow = List.filled(128, 'é').join();
    final valid = AbsenceActionDraft.deny(raw);
    final invalid = AbsenceActionDraft.deny(overflow);

    expect(utf8.encode(maximum).length, absenceDenialReasonMaximumBytes);
    expect(valid.denyInput(_row()).reason, maximum);
    expect(valid.denialReason, raw);
    expect(() => invalid.denyInput(_row()), throwsFormatException);
    expect(invalid.denialReason, overflow);
    expect(
      () => const AbsenceActionDraft.deny(' \n\t ').denyInput(_row()),
      throwsFormatException,
    );
  });

  test('a draft cannot construct a different action payload', () {
    const approval = AbsenceActionDraft.approve();
    const denial = AbsenceActionDraft.deny('Not available');
    const deletion = AbsenceActionDraft.delete();
    final baseline = _row();

    expect(() => approval.denyInput(baseline), throwsStateError);
    expect(() => approval.deleteInput(baseline), throwsStateError);
    expect(() => denial.approveInput(baseline), throwsStateError);
    expect(() => denial.deleteInput(baseline), throwsStateError);
    expect(() => deletion.approveInput(baseline), throwsStateError);
    expect(() => deletion.denyInput(baseline), throwsStateError);
  });

  test('missing or exceeded allowance remains a warning, not a new policy', () {
    final baseline = _row(
      usage: const [
        models.UsersVacationsListResultItemVacationUsageItem(
          year: 2026,
          allowanceDays: null,
          approvedDays: 20,
          requestedDays: 3,
          remainingAfterApproval: null,
        ),
        models.UsersVacationsListResultItemVacationUsageItem(
          year: 2027,
          allowanceDays: 0,
          approvedDays: 1,
          requestedDays: 3,
          remainingAfterApproval: -4,
        ),
      ],
    );

    expect(const AbsenceActionDraft.approve().approveInput(baseline).toWire(), {
      'id': 'absence',
    });
  });

  test(
    'decision verification requires the known target and captured actor',
    () {
      final baseline = _row();
      final approved = _row(
        status: _approved,
        decided: true,
        canApprove: false,
        canDeny: false,
        canDelete: false,
        from: DateTime(2026, 10, 12),
        to: DateTime(2026, 10, 13),
      );
      final denied = _row(
        status: _denied,
        decided: true,
        denialReason: 'Not available',
      );

      expect(
        absenceDecisionMatchesTarget(
          draft: const AbsenceActionDraft.approve(),
          baseline: baseline,
          actorUserId: 'actor',
          actual: approved,
        ),
        isTrue,
      );
      expect(
        absenceDecisionMatchesTarget(
          draft: const AbsenceActionDraft.deny('  Not available '),
          baseline: baseline,
          actorUserId: 'actor',
          actual: denied,
        ),
        isTrue,
      );
      expect(
        absenceDecisionMatchesTarget(
          draft: const AbsenceActionDraft.approve(),
          baseline: baseline,
          actorUserId: 'another actor',
          actual: approved,
        ),
        isFalse,
      );
    },
  );

  test('matching content cannot replace ID, request or decision metadata', () {
    final baseline = _row();
    final mismatches = <models.UsersVacationsListResultItem?>[
      null,
      _row(status: _approved, decided: true, id: 'another absence'),
      _row(status: _approved, decided: true, userId: 'another user'),
      _row(status: _approved, decided: true, from: DateTime.utc(2026, 10, 11)),
      _row(status: _approved, decided: true, to: DateTime.utc(2026, 10, 14)),
      _row(status: _approved, decided: true, note: 'Changed comment'),
      _row(status: _approved, decided: true, label: 'Changed label'),
      _row(status: _approved, decided: true, requester: 'another requester'),
      _row(
        status: _approved,
        decided: true,
        createdAt: _day.add(const Duration(seconds: 1)),
      ),
      _row(status: _approved, decided: true, denialReason: 'Old denial'),
      _row(status: _approved, decided: true, actor: 'another actor'),
      _row(status: _approved, decided: true, includeDecisionTime: false),
      _row(status: _denied, decided: true),
      _row(status: _approved),
    ];

    for (final actual in mismatches) {
      expect(
        absenceDecisionMatchesTarget(
          draft: const AbsenceActionDraft.approve(),
          baseline: baseline,
          actorUserId: 'actor',
          actual: actual,
        ),
        isFalse,
      );
    }

    expect(
      absenceDecisionMatchesTarget(
        draft: const AbsenceActionDraft.deny('Not available'),
        baseline: baseline,
        actorUserId: 'actor',
        actual: _row(status: _denied, decided: true, denialReason: 'Other'),
      ),
      isFalse,
    );
  });

  test('missing rows never verify deletion and an empty actor is rejected', () {
    final baseline = _row();

    for (final actual in [null, baseline]) {
      expect(
        () => absenceDecisionMatchesTarget(
          draft: const AbsenceActionDraft.delete(),
          baseline: baseline,
          actorUserId: 'actor',
          actual: actual,
        ),
        throwsFormatException,
      );
    }

    expect(
      () => absenceDecisionMatchesTarget(
        draft: const AbsenceActionDraft.approve(),
        baseline: baseline,
        actorUserId: ' ',
        actual: _row(status: _approved, decided: true),
      ),
      throwsFormatException,
    );
  });
}

models.UsersVacationsListResultItem _row({
  String id = 'absence',
  String userId = 'employee',
  models.UsersVacationsListResultItemStatus status =
      models.UsersVacationsListResultItemStatus.requested,
  bool canApprove = true,
  bool canDeny = true,
  bool canDelete = true,
  bool decided = false,
  bool includeDecisionTime = true,
  String actor = 'actor',
  String? note = 'Comment',
  String? label,
  String? denialReason,
  String? requester = 'requester',
  DateTime? from,
  DateTime? to,
  DateTime? createdAt,
  List<models.UsersVacationsListResultItemVacationUsageItem> usage = const [],
}) {
  return models.UsersVacationsListResultItem(
    id: id,
    userId: userId,
    from: from ?? _day,
    to: to ?? DateTime.utc(2026, 10, 13),
    type: models.UsersVacationsListResultItemType.vacation,
    label: label,
    status: status,
    note: note,
    denialReason: denialReason,
    requestedByUserId: requester,
    decidedByUserId: decided ? actor : null,
    decidedAt: decided && includeDecisionTime
        ? _day.add(const Duration(hours: 1))
        : null,
    createdAt: createdAt ?? _day,
    modifiedAt: _day,
    canApprove: canApprove,
    canDeny: canDeny,
    canDelete: canDelete,
    vacationUsage: usage,
  );
}
