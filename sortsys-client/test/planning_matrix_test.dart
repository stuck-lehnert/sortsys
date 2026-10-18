import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/api/model.dart';
import 'package:sortsys_client/api/procedure.dart';
import 'package:sortsys_client/features/planning/planning_controller.dart';
import 'package:sortsys_client/features/planning/planning_data.dart';
import 'package:sortsys_client/features/planning/planning_repository.dart';
import 'package:sortsys_client/features/planning/planning_state.dart';
import 'package:sortsys_client/features/planning/planning_view.dart';

final _monday = DateTime(2026, 10, 12);

void main() {
  test('planning URL keeps protocol, unrelated duplicates and fragment', () {
    final state = PlanningState(
      Uri.parse('/deployments?day=2026-10-12&tag=a&tag=b#board'),
      today: DateTime(2026, 10, 1),
    );

    expect(state.view, PlanningView.week);
    expect(state.days.length, 5);
    expect(state.focusDay, _monday);
    expect(state.visibleEndExclusive, DateTime(2026, 10, 17));

    final changed = state.withWeekend(true);
    expect(changed.queryParameters['weekend'], 'yes');
    expect(changed.queryParametersAll['tag'], ['a', 'b']);
    expect(changed.fragment, 'board');
    expect(state.withEmptyRows(true).queryParameters['all'], 'yes');
    expect(state.withSearch(' Alice ').queryParameters['q'], ' Alice ');
    expect(state.withView(PlanningView.day).queryParameters['view'], 'day');
    expect(state.shifted(1).queryParameters['day'], '2026-10-19');

    final reset = PlanningState(changed, today: _monday).withWeekend(false);
    expect(reset.queryParameters.containsKey('weekend'), isFalse);
  });

  test('planning dates reject normalization and use ISO week-year', () {
    expect(parsePlanningDate('2026-02-29'), isNull);
    expect(parsePlanningDate('0099-01-01'), isNull);
    expect(parsePlanningDate('2026-13-01'), isNull);
    expect(parsePlanningDate('2028-02-29'), DateTime(2028, 2, 29));
    expect(combinePlanningDateAndTime('2026-10-12', '24:00'), isNull);
    expect(combinePlanningDateAndTime('2026-10-12', '07:60'), isNull);
    expect(
      combinePlanningDateAndTime('2026-10-12', '07:30'),
      DateTime(2026, 10, 12, 7, 30),
    );
    expect(planningIsoWeek(DateTime(2021, 1, 1)), (year: 2020, number: 53));
    expect(planningIsoWeek(DateTime(2024, 12, 30)), (year: 2025, number: 1));

    final state = PlanningState(
      Uri.parse('/deployments?day=invalid&view=day'),
      today: _monday,
    );
    expect(state.focusDay, _monday);
    expect(state.days.length, 1);
    expect(state.shifted(-1).queryParameters['day'], '2026-10-11');
  });

  test(
    'real planner inputs scope assignments and active colleague metadata',
    () async {
      final reader = _PlanningReader();
      final repository = _repository(reader);
      final range = planningViewRange(_monday, PlanningView.week);

      final result = await repository.load(range);

      expect(result.failures, isEmpty);
      expect(reader.calls.length, 5);
      final deployment = reader.input('projects.deployments.list');
      expect(deployment['userId'], 'self');
      expect(deployment['from'], _monday);
      expect(deployment['to'], DateTime(2026, 10, 19));
      expect(deployment.containsKey('since'), isFalse);
      final users = reader.input('users.list');
      expect(users['includeArchived'], false);
      expect(users['deactivated'], false);
      final absences = reader.input('users.vacations.list');
      expect(absences['includeDenied'], false);
      expect(absences['to'], DateTime(2026, 10, 18));
      expect(absences.containsKey('userId'), isFalse);
      expect(
        reader.input('projects.unavailability.list')['to'],
        DateTime(2026, 10, 18),
      );
    },
  );

  test(
    'restricted response filters others and retains same-scope failures',
    () async {
      final reader = _PlanningReader();
      reader.responses['projects.deployments.list'] = [
        _deployment('mine').toWire(),
        _deployment('other', userId: 'someone-else').toWire(),
      ];
      final repository = _repository(reader);
      final range = planningViewRange(_monday, PlanningView.week);

      final first = await repository.load(range);

      final ids = first.data.deployments.map((row) {
        return row.id;
      });
      expect(ids, ['mine']);
      reader.failures['projects.deployments.list'] = StateError('Unavailable');

      final partial = await repository.load(range, previous: first.data);

      expect(partial.failures.keys, [PlanningSource.deployments]);
      expect(partial.data.deployments.single.id, 'mine');
      final foreign = PlanningData(
        identity: 'another-account',
        deployments: [_deployment('foreign')],
      );
      final isolated = await repository.load(range, previous: foreign);

      expect(isolated.data.deployments, isEmpty);
    },
  );

  test('full snapshots remove deleted and moved assignments', () async {
    final reader = _PlanningReader();
    reader.responses['projects.deployments.list'] = [
      _deployment('old').toWire(),
    ];
    final repository = _repository(reader, all: true);
    final range = planningViewRange(_monday, PlanningView.week);
    final first = await repository.load(range);

    reader.responses['projects.deployments.list'] = [];
    final second = await repository.load(range, previous: first.data);

    expect(first.data.deployments.length, 1);
    expect(second.data.deployments, isEmpty);
    expect(
      reader.input('projects.deployments.list').containsKey('userId'),
      isFalse,
    );
    expect(reader.input('users.list')['includeArchived'], true);
  });

  test('account change rejects all in-flight source completions', () async {
    final reader = _PlanningReader();
    final blocked = Completer<void>();
    reader.blocked['projects.deployments.list'] = blocked;
    var current = true;
    final repository = _repository(
      reader,
      isCurrent: () {
        return current;
      },
    );
    final range = planningViewRange(_monday, PlanningView.week);
    final pending = repository.load(range);
    final assertion = expectLater(pending, throwsStateError);

    current = false;
    blocked.complete();

    await assertion;
  });

  test(
    'matrix distinguishes hidden weekend occupancy and full-week search',
    () {
      final saturday = DateTime(2026, 10, 17);
      final data = PlanningData(
        identity: 'scope',
        deployments: [
          _deployment(
            'weekend',
            from: saturday.add(const Duration(hours: 7)),
            to: saturday.add(const Duration(hours: 16)),
          ),
        ],
      );

      expect(_view(data).rows, isEmpty);
      expect(_view(data, query: 'weekend=yes').rows.single.id, 'project');
      expect(_view(data, query: 'all=yes&q=Alice').rows.single.id, 'project');
      expect(_view(data, query: 'all=yes&q=NoMatch').rows, isEmpty);
    },
  );

  test(
    'matrix clips days, marks inclusive blocks/absences and keeps own scope',
    () {
      final from = DateTime(2026, 10, 11, 12);
      final to = DateTime(2026, 10, 14, 12);
      final absence = models.UsersVacationsListResultItem(
        id: 'absence',
        userId: 'self',
        from: _monday,
        to: _monday,
        type: models.UsersVacationsListResultItemType.vacation,
        status: models.UsersVacationsListResultItemStatus.approved,
        createdAt: _monday,
        modifiedAt: _monday,
        canApprove: false,
        canDeny: false,
        canDelete: false,
        vacationUsage: const [],
      );
      final block = models.ProjectsUnavailabilityListResultItem(
        id: 'block',
        projectId: 'project',
        from: _monday,
        to: _monday,
        reason: 'Closed',
        createdAt: _monday,
        modifiedAt: _monday,
      );
      final data = PlanningData(
        identity: 'scope',
        deployments: [
          _deployment('mine', from: from, to: to),
          _deployment('other', userId: 'other'),
        ],
        absences: [absence],
        blocks: [block],
      );
      final view = _view(data);
      final end = DateTime(2026, 10, 13);

      final cell = view.cell('project', _monday, end);

      expect(cell.deployments.length, 1);
      final segment = cell.deployments.single;
      expect(segment.hasWarning, isTrue);
      expect(segment.absences.single.id, 'absence');
      expect(segment.blocks.single.id, 'block');
      expect(planningSegmentTime(segment, _monday, end), '00:00-23:59');
      expect(view.absenceRows.single.id, 'self');
      expect(
        view.cell('self', _monday, end, absenceOnly: true).deployments,
        isEmpty,
      );
      expect(planningPeriodOverlaps(_monday, _monday, _monday, end), isTrue);
      expect(
        planningPeriodOverlaps(end, _monday, _monday, DateTime(2026, 10, 14)),
        isFalse,
      );
    },
  );

  test('matrix colors follow base32 IDs and JS UTF16 fallback hash', () {
    expect(planningColorHue('10'), 32);
    expect(planningColorHue(' V '), 31);
    expect(planningColorHue(''), 0);
    expect(planningColorHue('z'), 122);
  });

  testWidgets('three-second polling is nonoverlapping and stops on dispose', (
    tester,
  ) async {
    final reader = _PlanningReader();
    final controller = PlanningController(
      repository: _repository(reader),
      range: planningViewRange(_monday, PlanningView.week),
    );

    await controller.refresh();
    expect(reader.calls.length, 5);
    await tester.pump(const Duration(seconds: 2));
    expect(reader.calls.length, 5);
    await tester.pump(const Duration(seconds: 1));
    expect(reader.calls.length, 10);

    controller.dispose();
    await tester.pump(const Duration(seconds: 6));
    expect(reader.calls.length, 10);
  });

  testWidgets(
    'old range result cannot replace new range or revive after dispose',
    (tester) async {
      final reader = _PlanningReader();
      final blocked = Completer<void>();
      reader.blocked['projects.deployments.list'] = blocked;
      final controller = PlanningController(
        repository: _repository(reader),
        range: planningViewRange(_monday, PlanningView.week),
      );
      final pending = controller.refresh();

      controller.setRange(
        planningViewRange(DateTime(2026, 10, 19), PlanningView.week),
      );
      expect(controller.data, isNull);
      expect(reader.calls.length, 5);
      controller.dispose();
      blocked.complete();

      await pending;
      await tester.pump(const Duration(seconds: 6));
      expect(reader.calls.length, 5);
      expect(controller.data, isNull);
    },
  );
}

models.Deployment _deployment(
  String id, {
  String userId = 'self',
  DateTime? from,
  DateTime? to,
}) {
  return models.Deployment(
    id: id,
    projectId: 'project',
    userId: userId,
    from: from ?? DateTime(2026, 10, 12, 7),
    to: to ?? DateTime(2026, 10, 12, 16),
    createdAt: _monday,
    modifiedAt: _monday,
  );
}

PlanningRepository _repository(
  _PlanningReader reader, {
  bool all = false,
  bool Function()? isCurrent,
}) {
  return PlanningRepository(
    identity: 'scope',
    currentUserId: 'self',
    canViewAll: all,
    canViewUsers: all,
    read: reader.read,
    isCurrent: isCurrent ?? _current,
  );
}

bool _current() {
  return true;
}

PlanningViewData _view(PlanningData data, {String query = ''}) {
  final state = PlanningState(Uri.parse('/deployments?$query'), today: _monday);

  return PlanningViewData(
    data: data,
    state: state,
    rowMode: PlanningRowMode.project,
    currentUserId: 'self',
    currentUserName: 'Alice',
    canViewAll: false,
    unknownProject: 'Unknown project',
    unknownUser: 'Unknown user',
  );
}

final class _PlanningReader {
  final calls = <(String, Object?)>[];
  final responses = <String, Object?>{};
  final failures = <String, Object>{};
  final blocked = <String, Completer<void>>{};

  Future<O> read<I, O>(RpcQuery<I, O> query, I input) async {
    if (input is! RpcValue) {
      throw StateError('Expected generated planning request');
    }

    calls.add((query.path, input.toWire()));
    final wait = blocked[query.path];

    if (wait != null) {
      await wait.future;
    }

    final failure = failures[query.path];

    if (failure != null) {
      throw failure;
    }

    final wire = responses[query.path] ?? <Object?>[];

    return query.decodeOutput(wire);
  }

  Map<String, Object?> input(String path) {
    final value = calls.lastWhere((call) {
      return call.$1 == path;
    }).$2;

    if (value case final Map<String, Object?> result) {
      return result;
    }

    throw StateError('Expected planning object request');
  }
}
