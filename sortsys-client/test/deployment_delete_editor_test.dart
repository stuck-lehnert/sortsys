import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/features/planning/deployment_delete_coordinator.dart';
import 'package:sortsys_client/features/planning/deployment_delete_receipt.dart';
import 'package:sortsys_client/features/planning/deployment_editor.dart';
import 'package:sortsys_client/features/planning/deployment_form_fields.dart';
import 'package:sortsys_client/features/planning/deployment_receipt.dart';
import 'package:sortsys_client/features/planning/deployment_write_coordinator.dart';
import 'package:sortsys_client/features/planning/planning_data.dart';
import 'package:sortsys_client/features/planning/planning_state.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

final _day = DateTime.utc(2026, 10, 12);
final _user = models.User(
  id: 'user',
  firstName: 'Ada',
  lastName: 'Lovelace',
  username: 'ada',
  contractType: models.UserContractType.values.first,
  createdAt: _day,
  modifiedAt: _day,
);
final _project = models.Project(
  id: 'project',
  title: 'Workshop',
  createdAt: _day,
  modifiedAt: _day,
);

void main() {
  setUpAll(() async {
    final loader = FontLoader('packages/sortsys_ui/Ubuntu');

    for (final weight in ['Regular', 'Medium', 'Bold']) {
      loader.addFont(
        rootBundle.load(
          'packages/sortsys_ui/assets/fonts/ubuntu/Ubuntu-$weight.ttf',
        ),
      );
    }

    await loader.load();
  });

  testWidgets(
    'delete role gates the real button and dirty draft is not saved',
    (tester) async {
      final fixture = _Fixture();
      fixture.canDelete = false;

      await _mount(tester, fixture);
      await _open(tester);

      expect(find.text('Delete assignment'), findsNothing);
      expect(find.text('Save'), findsOneWidget);

      await tester.tap(find.text('Close'));
      await tester.pumpAndSettle();
      fixture.canDelete = true;

      await _open(tester);

      final fields = tester.widget<DeploymentFormFields>(
        find.byType(DeploymentFormFields),
      );
      final time = find.byWidgetPredicate((widget) {
        return widget is SsTextField &&
            widget.controller == fields.values.fromTime;
      });

      await tester.ensureVisible(time);
      await tester.enterText(time, '25:00');
      await _beginDelete(tester);
      await tester.pumpAndSettle();

      expect(fixture.deletes, 1);
      expect(fixture.writes, 0);
      expect(fixture.record, isNull);
      expect(fixture.deletions.encoded, isNull);
      expect(find.byType(DeploymentEditorDialog), findsNothing);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'lost delete acknowledgement stays blocked after close and reopen',
    (tester) async {
      final fixture = _Fixture();
      fixture.failAfterDelete = true;

      await _mount(tester, fixture);
      await _open(tester);
      await _beginDelete(tester);
      await tester.pumpAndSettle();

      expect(fixture.record, isNull);
      expect(fixture.deletes, 1);
      expect(fixture.reads, 2);
      expect(
        find.textContaining('The deletion has no acknowledgement.'),
        findsOneWidget,
      );
      expect(find.text('Assignment deployment'), findsOneWidget);
      _expectUnknownBlocked();

      await tester.tap(find.text('Close'));
      await tester.pumpAndSettle();
      await _open(tester);

      _expectUnknownBlocked();
      expect(fixture.deletes, 1);
      expect(fixture.reads, 2);
      expect(fixture.deletions.encoded, isNotNull);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    '320px scale2 prepared discard closes without deleting or reopening form',
    (tester) async {
      final fixture = _Fixture();
      fixture.deletions.encoded = _receipt().encode();

      await _mount(tester, fixture, width: 320, scale: 2);
      await _open(tester);

      expect(find.byType(DeploymentFormFields), findsNothing);
      expect(find.text('Save'), findsNothing);
      expect(find.text('Delete assignment'), findsNothing);

      await tester.ensureVisible(find.text('Discard unsent operation'));
      await tester.tap(find.text('Discard unsent operation'));
      await tester.pumpAndSettle();

      expect(fixture.deletes, 0);
      expect(fixture.reads, 0);
      expect(fixture.record, isNotNull);
      expect(fixture.deletions.encoded, isNull);
      expect(find.byType(DeploymentEditorDialog), findsNothing);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'acknowledged cleanup has a finish action with no read or delete replay',
    (tester) async {
      final fixture = _Fixture();
      fixture.record = null;
      fixture.deletions.encoded = _receipt().started().confirmed().encode();

      await _mount(tester, fixture);
      await _open(tester);

      expect(
        find.textContaining('The API acknowledged deletion.'),
        findsOneWidget,
      );
      expect(find.text('Save'), findsNothing);
      expect(find.text('Delete assignment'), findsNothing);

      await tester.tap(find.text('Finish operation'));
      await tester.pumpAndSettle();

      expect(fixture.reads, 0);
      expect(fixture.deletes, 0);
      expect(fixture.deletions.encoded, isNull);
      expect(find.byType(DeploymentEditorDialog), findsNothing);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    '320px scale2 busy delete blocks back and scope loss removes the form',
    (tester) async {
      final fixture = _Fixture();
      final gate = Completer<void>();
      fixture.gate = gate;

      try {
        await _mount(tester, fixture, width: 320, scale: 2);
        await _open(tester);
        await _beginDelete(tester);

        final close = tester.widget<SsButton>(
          find.widgetWithText(SsButton, 'Close'),
        );

        expect(close.onPressed, isNull);
        expect(fixture.deletes, 1);

        await tester.binding.handlePopRoute();
        await tester.pump();

        expect(find.byType(DeploymentEditorDialog), findsOneWidget);
        fixture.signal.value = false;

        await tester.pump();

        expect(find.byType(DeploymentFormFields), findsNothing);
        expect(find.text('Delete assignment'), findsNothing);

        gate.complete();

        await tester.pumpAndSettle();

        expect(
          find.text('The session or permission changed. Close this window.'),
          findsOneWidget,
        );
        expect(fixture.deletions.encoded, isNotNull);
        expect(fixture.deletes, 1);

        await tester.tap(find.text('Close'));
        await tester.pumpAndSettle();

        expect(fixture.signal.isObserved, isFalse);
        expect(tester.takeException(), isNull);
      } finally {
        // A failed assertion must not leave the actor write lock held.
        if (!gate.isCompleted) {
          gate.complete();
        }

        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump();
      }
    },
  );

  testWidgets(
    'replacement intent is shown and must be reviewed before nonce-bound discard',
    (tester) async {
      final fixture = _Fixture();
      fixture.deletions.encoded = _receipt().encode();

      await _mount(tester, fixture);
      await _open(tester);

      final replacement = _receipt(
        nonce: 'ffffffffffffffffffffffffffffffff',
        id: 'replacement',
      ).encode();
      fixture.deletions.encoded = replacement;

      await tester.tap(find.text('Discard unsent operation'));
      await tester.pumpAndSettle();

      expect(fixture.deletions.encoded, replacement);
      expect(find.text('Assignment replacement'), findsOneWidget);
      expect(fixture.deletes, 0);
      expect(fixture.reads, 0);

      await tester.tap(find.text('Discard unsent operation'));
      await tester.pumpAndSettle();

      expect(fixture.deletions.encoded, isNull);
      expect(fixture.deletes, 0);
      expect(find.byType(DeploymentEditorDialog), findsNothing);
      expect(tester.takeException(), isNull);
    },
  );
}

void _expectUnknownBlocked() {
  for (final label in [
    'Save',
    'Delete assignment',
    'Verify operation',
    'Finish operation',
    'Discard unsent operation',
  ]) {
    expect(find.text(label), findsNothing);
  }
}

models.Deployment _baseline({String id = 'deployment'}) {
  return models.Deployment(
    id: id,
    userId: _user.id,
    projectId: _project.id,
    from: _day.add(const Duration(hours: 7)),
    to: _day.add(const Duration(hours: 16)),
    createdAt: _day,
    modifiedAt: _day,
  );
}

DeploymentDeleteReceipt _receipt({
  String nonce = '0123456789abcdef0123456789abcdef',
  String id = 'deployment',
}) {
  return DeploymentDeleteReceipt(
    scope: 'scope',
    nonce: nonce,
    createdAt: _day,
    baseline: _baseline(id: id),
  );
}

Future<void> _mount(
  WidgetTester tester,
  _Fixture fixture, {
  double width = 640,
  double scale = 1,
}) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = Size(width, 1000);
  addTearDown(tester.view.resetDevicePixelRatio);
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(fixture.signal.dispose);

  await tester.pumpWidget(
    MaterialApp(
      locale: const Locale('en'),
      supportedLocales: const [Locale('de'), Locale('en')],
      localizationsDelegates: GlobalMaterialLocalizations.delegates,
      builder: (context, navigator) {
        return SsTheme(
          colors: SsColors.light,
          child: MediaQuery(
            data: MediaQuery.of(
              context,
            ).copyWith(textScaler: TextScaler.linear(scale)),
            child: navigator ?? const SizedBox.shrink(),
          ),
        );
      },
      home: Scaffold(
        body: Builder(
          builder: (context) {
            return SsButton(
              onPressed: () {
                unawaited(
                  showGeneralDialog<DeploymentWriteResult>(
                    context: context,
                    pageBuilder: (context, animation, secondaryAnimation) {
                      return fixture.dialog();
                    },
                  ),
                );
              },
              child: const Text('Open'),
            );
          },
        ),
      ),
    ),
  );
}

Future<void> _open(WidgetTester tester) async {
  await tester.tap(find.text('Open'));
  await tester.pumpAndSettle();
}

Future<void> _beginDelete(WidgetTester tester) async {
  await tester.ensureVisible(find.text('Delete assignment'));
  await tester.tap(find.text('Delete assignment'));
  await tester.pump();
}

final class _ScopeSignal extends ValueNotifier<bool> {
  _ScopeSignal() : super(true);

  bool get isObserved {
    return hasListeners;
  }
}

final class _Fixture {
  _Fixture() {
    deletion = DeploymentDeleteCoordinator(
      access: _DeleteAccess(this),
      receipts: deletions,
      pendingWrites: rawWrites,
    );
    writer = DeploymentWriteCoordinator(
      access: _WriteAccess(this),
      receipts: DeletionGuardedDeploymentReceipts(
        writes: rawWrites,
        deletions: deletions,
      ),
    );
  }

  final signal = _ScopeSignal();
  final deletions = _DeleteStore();
  final rawWrites = _WriteStore();
  late final DeploymentDeleteCoordinator deletion;
  late final DeploymentWriteCoordinator writer;
  models.Deployment? record = _baseline();
  Completer<void>? gate;
  bool canDelete = true;
  bool failAfterDelete = false;
  int reads = 0;
  int deletes = 0;
  int writes = 0;

  void checkCurrent() {
    if (!signal.value) {
      throw StateError('SCOPE_CHANGED');
    }
  }

  models.Deployment? snapshot(String id, DateTime from, DateTime to) {
    checkCurrent();

    reads++;
    final current = record;

    if (current == null ||
        current.id != id ||
        !current.from.isBefore(to) ||
        !current.to.isAfter(from)) {
      return null;
    }

    return models.Deployment.fromWire(current.toWire());
  }

  Widget dialog() {
    final view = PlanningViewData(
      data: PlanningData(
        identity: 'scope',
        users: [_user],
        projects: [_project],
      ),
      state: PlanningState(Uri(path: '/deployments'), today: _day),
      rowMode: PlanningRowMode.project,
      currentUserId: _user.id,
      currentUserName: 'Ada Lovelace',
      canViewAll: true,
      unknownProject: 'Unknown project',
      unknownUser: 'Unknown user',
    );

    return DeploymentEditorDialog(
      coordinator: writer,
      deleteCoordinator: deletion,
      canDelete: canDelete,
      deployment: _baseline(),
      view: view,
      loadUser: (id) async {
        throw StateError('UNEXPECTED_USER_LOOKUP');
      },
      loadProject: (id) async {
        throw StateError('UNEXPECTED_PROJECT_LOOKUP');
      },
      scopeChanges: signal,
    );
  }
}

final class _WriteStore implements DeploymentReceiptStore {
  @override
  Future<DeploymentWriteReceipt?> read(String scope) async {
    return null;
  }

  @override
  Future<void> write(DeploymentWriteReceipt receipt) async {
    throw StateError('UNEXPECTED_WRITE_JOURNAL_MUTATION');
  }

  @override
  Future<void> clear(String scope) async {
    throw StateError('UNEXPECTED_WRITE_JOURNAL_CLEAR');
  }
}

final class _DeleteStore implements DeploymentDeleteStore {
  String? encoded;

  @override
  Future<DeploymentDeleteReceipt?> read(String scope) async {
    final value = encoded;

    if (value == null) {
      return null;
    }

    return DeploymentDeleteReceipt.decode(value);
  }

  @override
  Future<void> write(DeploymentDeleteReceipt receipt) async {
    encoded = receipt.encode();
  }

  @override
  Future<void> clear(String scope) async {
    encoded = null;
  }
}

final class _WriteAccess implements DeploymentWriteAccess {
  const _WriteAccess(this.fixture);

  final _Fixture fixture;

  @override
  String get scope {
    return 'scope';
  }

  @override
  void checkCurrent() {
    fixture.checkCurrent();
  }

  @override
  Future<models.Deployment?> getDeployment(
    String id, {
    required DateTime from,
    required DateTime to,
  }) async {
    return fixture.snapshot(id, from, to);
  }

  @override
  Future<String> createDeployment(
    models.ProjectsDeploymentsCreateInput input,
  ) async {
    fixture.writes++;

    throw StateError('UNEXPECTED_CREATE');
  }

  @override
  Future<void> updateDeployment(
    models.ProjectsDeploymentsUpdateInput input,
  ) async {
    fixture.writes++;

    throw StateError('UNEXPECTED_UPDATE');
  }
}

final class _DeleteAccess implements DeploymentDeleteAccess {
  const _DeleteAccess(this.fixture);

  final _Fixture fixture;

  @override
  String get scope {
    return 'scope';
  }

  @override
  void checkCurrent() {
    fixture.checkCurrent();
  }

  @override
  void checkDelete() {
    checkCurrent();

    if (!fixture.canDelete) {
      throw StateError('DELETE_NOT_ALLOWED');
    }
  }

  @override
  Future<models.Deployment?> getDeployment(models.Deployment baseline) async {
    checkDelete();

    return fixture.snapshot(baseline.id, baseline.from, baseline.to);
  }

  @override
  Future<void> deleteDeployment(String id) async {
    checkDelete();

    fixture.deletes++;
    final gate = fixture.gate;

    if (gate != null) {
      await gate.future;
    }

    fixture.record = null;

    if (fixture.failAfterDelete) {
      throw StateError('RESPONSE_LOST');
    }
  }
}
