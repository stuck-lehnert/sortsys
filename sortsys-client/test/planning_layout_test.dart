import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as api_models;
import 'package:sortsys_client/domain/models.dart';
import 'package:sortsys_client/domain/planning.dart';
import 'package:sortsys_client/features/planning/assignment_tile.dart';
import 'package:sortsys_client/state/session_controller.dart';

Deployment assignment(String id, DateTime from, DateTime to) {
  return Deployment.fromWire({
    'id': id,
    'projectId': 'project-$id',
    'userId': 'employee',
    'from': from,
    'to': to,
    'note': 'Assignment note',
    'createdAt': from.toUtc(),
    'modifiedAt': from.toUtc(),
  });
}

void main() {
  group('Calendar refactor behavior', () {
    test('clips overnight intervals and excludes the exclusive day end', () {
      final day = DateTime(2026, 3, 2);
      final overnight = assignment(
        'overnight',
        DateTime(2026, 3, 1, 23),
        DateTime(2026, 3, 2, 1),
      );
      final ending = assignment('ending', DateTime(2026, 3, 1, 22), day);
      final layout = layoutDay([overnight, ending], day);

      expect(layout.events.length, 1);
      expect(layout.events.single.item.id, 'overnight');
      expect(layout.events.single.start, 0);
      expect(layout.events.single.end, 60);
    });

    test(
      'retains civil-day boundaries instead of adding fixed 24-hour spans',
      () {
        final day = DateTime(2026, 3, 29);
        final layout = layoutDay([], day);
        final next = DateTime(2026, 3, 30);

        expect(layout.from, startOfDay(day));
        expect(layout.to, next);
        expect(layout.minutes, next.difference(startOfDay(day)).inSeconds / 60);
        expect(layout.ticks.last, (layout.minutes, next));
      },
    );

    test('assigns distinct lanes only within visually overlapping groups', () {
      final day = DateTime(2026, 3, 2);
      final early = assignment(
        'early',
        DateTime(2026, 3, 2, 8),
        DateTime(2026, 3, 2, 10),
      );
      final overlap = assignment(
        'overlap',
        DateTime(2026, 3, 2, 9),
        DateTime(2026, 3, 2, 11),
      );
      final later = assignment(
        'later',
        DateTime(2026, 3, 2, 12),
        DateTime(2026, 3, 2, 13),
      );
      final layout = layoutDay([later, overlap, early, early], day);

      expect(layout.events.length, 3);
      expect(layout.events[0].laneCount, 2);
      expect(layout.events[1].laneCount, 2);
      expect(layout.events[0].lane, isNot(layout.events[1].lane));
      expect(layout.events[2].laneCount, 1);
    });

    testWidgets('list cards avoid flex in an unbounded vertical viewport', (
      tester,
    ) async {
      final session = SessionController();
      final created = DateTime.utc(2026, 3, 2);
      session.info = SessionInfo(
        api_models.SessionInfo(
          user: api_models.SessionInfoUser(
            id: 'employee',
            username: 'employee',
            firstName: 'Employee',
            contractType: api_models.UserContractType.values.first,
            locale: api_models.AssistantLocale.en,
          ),
          tenant: const api_models.SessionInfoTenant(
            objectStorageEnabled: false,
          ),
          session: api_models.SessionInfoSession(
            id: 'session',
            createdAt: created,
            expiresAt: created.add(const Duration(days: 1)),
          ),
          roles: const [],
        ),
      );
      final item = assignment(
        'list',
        DateTime(2026, 3, 2, 8),
        DateTime(2026, 3, 2, 9),
      );

      await tester.pumpWidget(
        ChangeNotifierProvider.value(
          value: session,
          child: MaterialApp(
            locale: const Locale('en'),
            supportedLocales: const [Locale('en')],
            localizationsDelegates: GlobalMaterialLocalizations.delegates,
            home: Scaffold(body: ListView(children: [AssignmentTile(item)])),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(tester.takeException(), isNull);
      expect(find.text('project-list'), findsOneWidget);
      expect(find.text('Assignment note'), findsOneWidget);

      await tester.pumpWidget(const SizedBox.shrink());
      session.dispose();
    });
  });
}
