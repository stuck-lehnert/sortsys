import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/api/model.dart';
import 'package:sortsys_client/api/wire.dart';
import 'package:sortsys_client/features/planning/planning_draft.dart';
import 'package:sortsys_client/features/planning/project_block_write_input.dart';

final _calendarDay = DateTime.utc(2026, 10, 12);

void main() {
  test('local selected days and UTC calendar baseline are a genuine no-op', () {
    final draft = _draft();
    final baseline = _baseline();
    final offset = DateTime(2026, 10, 12).timeZoneOffset;

    debugPrint('Block civil test local offset: $offset');

    expect(draft.updateInput(baseline), isNull);
    expect(projectBlockWriteInput(draft, baseline), isNull);
  });

  test(
    'changed inclusive dates become UTC midnight through real wire roundtrip',
    () {
      final draft = _draft(
        projectId: 'other-project',
        from: DateTime(2026, 10, 13, 16),
        to: DateTime(2026, 10, 14, 3),
        reason: '  Maintenance  ',
        note: '   ',
      );
      final baseline = _baseline();
      final original = draft.updateInput(baseline)!;
      final input = projectBlockWriteInput(draft, baseline)!;

      final decoded = models.ProjectsUnavailabilityUpdateInput.fromWire(
        deserializeWire(serializeWire(input.toWire())),
      );

      expect(readRpcDate(original.data.from.value), DateTime(2026, 10, 13));
      expect(readRpcDate(original.data.to.value), DateTime(2026, 10, 14));
      expect(decoded.id, baseline.id);
      expect(decoded.data.projectId.value, 'other-project');
      expect(readRpcDate(decoded.data.from.value), DateTime.utc(2026, 10, 13));
      expect(readRpcDate(decoded.data.to.value), DateTime.utc(2026, 10, 14));
      expect(decoded.data.reason.value, 'Maintenance');
      expect(decoded.data.note.hasValue, isTrue);
      expect(decoded.data.note.value, isNull);
    },
  );

  test(
    'reason edit omits unchanged project/dates and explicitly clears note',
    () {
      final input = projectBlockWriteInput(
        _draft(reason: ' Maintenance ', note: ''),
        _baseline(),
      )!;

      expect(input.data.projectId.isAbsent, isTrue);
      expect(input.data.from.isAbsent, isTrue);
      expect(input.data.to.isAbsent, isTrue);
      expect(input.data.note.hasValue, isTrue);
      expect(input.data.note.value, isNull);
      expect(deserializeWire(serializeWire(input.toWire())), {
        'id': 'block',
        'data': <String, Object?>{'reason': 'Maintenance', 'note': null},
      });
    },
  );

  test('server reason/note UTF8 limits reject without truncating input', () {
    final reason = List.filled(63, 'ä').join();
    final note = List.filled(63, '🙂').join();
    final draft = _draft(reason: ' $reason ', note: ' $note ');
    final input = projectBlockWriteInput(draft, _baseline())!;

    expect(input.data.reason.value, reason);
    expect(input.data.note.value, note);
    expect(draft.reason, ' $reason ');
    expect(draft.note, ' $note ');

    for (final invalid in [
      _draft(reason: List.filled(64, 'ä').join()),
      _draft(note: List.filled(64, '🙂').join()),
    ]) {
      expect(() {
        projectBlockWriteInput(invalid, _baseline());
      }, throwsFormatException);
    }
  });
}

ProjectBlockDraft _draft({
  String projectId = 'project',
  DateTime? from,
  DateTime? to,
  String reason = ' Closed ',
  String note = 'Keep note',
}) {
  return ProjectBlockDraft(
    projectId: projectId,
    from: from ?? DateTime(2026, 10, 12, 7),
    to: to ?? DateTime(2026, 10, 12, 16),
    reason: reason,
    note: note,
  );
}

models.ProjectsUnavailabilityListResultItem _baseline() {
  return models.ProjectsUnavailabilityListResultItem(
    id: 'block',
    projectId: 'project',
    from: _calendarDay,
    to: _calendarDay,
    reason: 'Closed',
    note: 'Keep note',
    createdAt: _calendarDay,
    modifiedAt: _calendarDay,
  );
}
