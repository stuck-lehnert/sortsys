import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/api/model.dart';
import 'package:sortsys_client/features/planning/planning_draft.dart';

final _day = DateTime(2026, 10, 12);
final _from = DateTime(2026, 10, 12, 7);
final _to = DateTime(2026, 10, 12, 16);

void main() {
  test(
    'multi-user assignment payloads preserve selection order and normalize note',
    () {
      final users = ['second', 'first'];
      final draft = DeploymentDraft(
        userIds: users,
        projectId: 'project',
        from: _from,
        to: _to,
        note: '  Material transfer  ',
      );
      users.clear();

      final inputs = draft.createInputs();

      expect(inputs.length, 2);
      expect(inputs[0].userId, 'second');
      expect(inputs[1].userId, 'first');
      expect(_wire(inputs[0]), {
        'projectId': 'project',
        'userId': 'second',
        'from': _from,
        'to': _to,
        'note': 'Material transfer',
      });
      expect(() {
        inputs.clear();
      }, throwsUnsupportedError);
    },
  );

  test(
    'assignment validation rejects empty selection, duplicate users and invalid time',
    () {
      for (final users in <List<String>>[
        [],
        [''],
        ['same', 'same'],
      ]) {
        expect(() {
          DeploymentDraft(
            userIds: users,
            projectId: 'project',
            from: _from,
            to: _to,
          ).createInputs();
        }, throwsFormatException);
      }

      expect(() {
        DeploymentDraft(
          userIds: ['self'],
          projectId: 'project',
          from: _to,
          to: _from,
        ).createInputs();
      }, throwsFormatException);
      expect(() {
        DeploymentDraft(
          userIds: ['self'],
          projectId: 'project',
          from: _from,
          to: _from,
        ).createInputs();
      }, throwsFormatException);
    },
  );

  test(
    'assignment edit omits unchanged fields and explicitly clears a note',
    () {
      final baseline = _deployment(note: 'Existing note');
      final draft = DeploymentDraft(
        userIds: ['self'],
        projectId: 'new-project',
        from: _from,
        to: _to,
        note: '  ',
      );

      final input = draft.updateInput(baseline);

      expect(input, isNotNull);
      expect(_wire(input!), {
        'id': 'deployment',
        'data': <String, Object?>{'projectId': 'new-project', 'note': null},
      });
      expect(
        DeploymentDraft(
          userIds: ['self'],
          projectId: 'project',
          from: _from,
          to: _to,
          note: 'Existing note',
        ).updateInput(baseline),
        isNull,
      );
      expect(() {
        DeploymentDraft(
          userIds: ['self', 'other'],
          projectId: 'project',
          from: _from,
          to: _to,
        ).updateInput(baseline);
      }, throwsFormatException);
    },
  );

  test(
    'absence permits an inclusive single civil day and discards hidden label',
    () {
      final input = AbsenceDraft(
        userId: 'self',
        from: _from,
        to: _to,
        type: models.UsersVacationsListResultItemType.vacation,
        label: 'Hidden previous label',
        note: '  ',
      ).createInput();

      expect(_wire(input), {
        'userId': 'self',
        'from': _day,
        'to': _day,
        'type': 'vacation',
        'label': null,
        'note': null,
      });
      final decoded = models.UsersVacationsCreateInput.fromWire(input.toWire());
      expect(decoded.from, _day);
      expect(decoded.label.valueOrNull, isNull);
    },
  );

  test('other absence requires trimmed nonempty label up to63 UTF16 units', () {
    final input = AbsenceDraft(
      userId: 'self',
      from: _day,
      to: _day,
      type: models.UsersVacationsListResultItemType.other,
      label: '  Training  ',
      note: '  On site  ',
    ).createInput();

    expect(_wire(input)['label'], 'Training');
    expect(_wire(input)['note'], 'On site');
    for (final label in ['', '   ', List.filled(64, 'x').join()]) {
      expect(() {
        AbsenceDraft(
          userId: 'self',
          from: _day,
          to: _day,
          type: models.UsersVacationsListResultItemType.other,
          label: label,
        ).createInput();
      }, throwsFormatException);
    }

    expect(() {
      AbsenceDraft(
        userId: 'self',
        from: _to,
        to: DateTime(2026, 10, 11),
        type: models.UsersVacationsListResultItemType.vacation,
      ).createInput();
    }, throwsFormatException);
  });

  test(
    'project block edit preserves inclusive dates and sends changed fields only',
    () {
      final baseline = models.ProjectsUnavailabilityListResultItem(
        id: 'block',
        projectId: 'project',
        from: _day,
        to: _day,
        reason: 'Closed',
        note: 'Existing note',
        createdAt: _day,
        modifiedAt: _day,
      );
      final unchanged = ProjectBlockDraft(
        projectId: 'project',
        from: _from,
        to: _to,
        reason: ' Closed ',
        note: 'Existing note',
      );

      expect(unchanged.updateInput(baseline), isNull);
      final changed = ProjectBlockDraft(
        projectId: 'project',
        from: _day,
        to: _day,
        reason: '  Maintenance  ',
      ).updateInput(baseline);

      expect(_wire(changed!), {
        'id': 'block',
        'data': <String, Object?>{'reason': 'Maintenance', 'note': null},
      });
      expect(() {
        ProjectBlockDraft(
          projectId: 'project',
          from: _day,
          to: _day,
          reason: ' ',
        ).updateInput(baseline);
      }, throwsFormatException);
    },
  );
}

models.Deployment _deployment({String? note}) {
  return models.Deployment(
    id: 'deployment',
    projectId: 'project',
    userId: 'self',
    from: _from,
    to: _to,
    note: note,
    createdAt: _day,
    modifiedAt: _day,
  );
}

Map<String, Object?> _wire(RpcValue value) {
  final encoded = value.toWire();

  if (encoded case final Map<String, Object?> result) {
    return result;
  }

  throw StateError('Expected generated planning object');
}
