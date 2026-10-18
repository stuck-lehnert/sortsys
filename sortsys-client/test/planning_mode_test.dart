import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/features/planning/planning_mode_controller.dart';
import 'package:sortsys_client/features/planning/planning_state.dart';

void main() {
  test('late stored mode cannot overwrite a current user selection', () async {
    final stored = Completer<String?>();
    final written = <String>[];
    final controller = PlanningModeController(
      read: () {
        return stored.future;
      },
      write: (value) async {
        written.add(value);
      },
    );
    addTearDown(controller.dispose);

    final restoring = controller.restore();
    await controller.select(PlanningRowMode.user);
    stored.complete('project');
    await restoring;

    expect(controller.mode, PlanningRowMode.user);
    expect(written, ['user']);
    expect(controller.error, isNull);
  });

  test(
    'mode writes never overlap and obsolete queued selections are skipped',
    () async {
      final release = Completer<void>();
      final written = <String>[];
      var active = 0;
      var maximumActive = 0;
      final controller = PlanningModeController(
        read: () async {
          return null;
        },
        write: (value) async {
          active++;
          if (active > maximumActive) {
            maximumActive = active;
          }

          written.add(value);
          if (written.length == 1) {
            await release.future;
          }

          active--;
        },
      );
      addTearDown(controller.dispose);

      final first = controller.select(PlanningRowMode.user);
      await Future<void>.delayed(Duration.zero);
      final superseded = controller.select(PlanningRowMode.user);
      final last = controller.select(PlanningRowMode.project);

      expect(written, ['user']);
      release.complete();
      await Future.wait([first, superseded, last]);

      expect(written, ['user', 'project']);
      expect(maximumActive, 1);
      expect(controller.mode, PlanningRowMode.project);
    },
  );

  test(
    'persistence failure stays visible and a successful selection clears it',
    () async {
      final failure = StateError('Preference storage unavailable');
      final written = <String>[];
      final controller = PlanningModeController(
        read: () async {
          return 'project';
        },
        write: (value) async {
          written.add(value);

          if (value == 'user') {
            throw failure;
          }
        },
      );
      addTearDown(controller.dispose);

      await controller.select(PlanningRowMode.user);

      expect(controller.error, same(failure));
      expect(controller.mode, PlanningRowMode.user);
      await controller.select(PlanningRowMode.project);

      expect(written, ['user', 'project']);
      expect(controller.error, isNull);
    },
  );

  test(
    'disposed mode controller ignores late restore and new writes',
    () async {
      final stored = Completer<String?>();
      var notifications = 0;
      var writes = 0;
      final controller = PlanningModeController(
        read: () {
          return stored.future;
        },
        write: (value) async {
          writes++;
        },
      );
      controller.addListener(() {
        notifications++;
      });

      final restoring = controller.restore();
      controller.dispose();
      stored.complete('user');
      await restoring;
      await controller.select(PlanningRowMode.user);

      expect(notifications, 0);
      expect(writes, 0);
      expect(controller.mode, PlanningRowMode.project);
    },
  );

  test(
    'stored mode uses exact canonical values and defaults unknown text to project',
    () async {
      final controller = PlanningModeController(
        read: () async {
          return 'USER';
        },
        write: (value) async {
          throw StateError('Restore must not write');
        },
      );
      addTearDown(controller.dispose);

      await controller.restore();

      expect(controller.mode, PlanningRowMode.project);
      expect(controller.error, isNull);
    },
  );
}
