import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/features/planning/planning_view.dart';

void main() {
  test('planning defaults to the Webapp civil week', () {
    final range = planningViewRange(
      DateTime(2026, 10, 14, 16, 30),
      defaultPlanningView,
    );

    expect(defaultPlanningView, PlanningView.week);
    expect(range.from, DateTime(2026, 10, 12));
    expect(range.toExclusive, DateTime(2026, 10, 19));
  });

  test('day planning uses exclusive local civil-day boundaries', () {
    final range = planningViewRange(
      DateTime(2026, 10, 25, 15),
      PlanningView.day,
    );

    expect(range.from, DateTime(2026, 10, 25));
    expect(range.toExclusive, DateTime(2026, 10, 26));
  });

  test('planning without global permission sends only the current user', () {
    final range = planningViewRange(DateTime(2026, 10, 14), PlanningView.week);
    final input = planningListInput(
      range,
      userId: 'current-user',
      canViewAll: false,
    );

    expect(input.toWire(), {
      'from': range.from,
      'to': range.toExclusive,
      'userId': 'current-user',
    });
  });

  test(
    'global planning omits user filter rather than send undefined or null',
    () {
      final range = planningViewRange(DateTime(2026, 10, 14), PlanningView.day);
      final input = planningListInput(
        range,
        userId: 'current-user',
        canViewAll: true,
      );

      expect(input.toWire(), {'from': range.from, 'to': range.toExclusive});
    },

  );
}
