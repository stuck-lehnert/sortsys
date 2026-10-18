import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/features/planning/planning_data.dart';
import 'package:sortsys_client/features/planning/planning_draft.dart';
import 'package:sortsys_client/features/planning/project_block_editor.dart';
import 'package:sortsys_client/features/planning/project_block_form_fields.dart';
import 'package:sortsys_client/features/planning/project_block_receipt.dart';
import 'package:sortsys_client/features/planning/project_block_write_coordinator.dart';
import 'package:sortsys_client/features/planning/project_block_write_input.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

final _day = DateTime.utc(2026, 10, 12);
final _project = models.Project(
  id: 'project',
  title: 'Workshop',
  createdAt: _day,
  modifiedAt: _day,
);
const _nonce = '0123456789abcdef0123456789abcdef';
const _otherNonce = 'abcdef0123456789abcdef0123456789';

void main() {
  setUpAll(() async {
    final fonts = FontLoader('packages/sortsys_ui/Ubuntu');

    for (final weight in ['Regular', 'Medium', 'Bold']) {
      fonts.addFont(
        rootBundle.load(
          'packages/sortsys_ui/assets/fonts/ubuntu/Ubuntu-$weight.ttf',
        ),
      );
    }

    await fonts.load();
  });

  testWidgets(
    'Save makes one real coordinated update and returns verified row',
    (tester) async {
      _viewport(tester);
      final fixture = _Fixture();

      try {
        await _open(tester, fixture);
        await tester.enterText(_field('Reason'), '  Maintenance  ');
        await tester.enterText(_field('Comment'), '   ');
        await tester.tap(find.text('Save'));
        await tester.pumpAndSettle();

        expect(fixture.result!.outcome, ProjectBlockWriteOutcome.verified);
        expect(fixture.result!.record!.reason, 'Maintenance');
        expect(fixture.result!.record!.note, isNull);
        expect(fixture.access.updates, 1);
        expect(fixture.access.deletes, 0);
        expect(fixture.store.stages, [
          'false:false',
          'true:false',
          'false:true',
        ]);
        expect(fixture.store.pending, isNull);
        expect(fixture.disposals, 1);
        expect(tester.takeException(), isNull);
      } finally {
        await tester.pumpWidget(const SizedBox.shrink());
        fixture.signal.dispose();
      }
    },
  );

  testWidgets('delete role gates button and dirty invalid form is not saved', (
    tester,
  ) async {
    _viewport(tester);
    final fixture = _Fixture();

    try {
      await _open(tester, fixture, canDelete: false);
      expect(find.text('Delete block'), findsNothing);
      await tester.tap(find.text('Close'));
      await tester.pumpAndSettle();
      await _open(tester, fixture);
      await tester.enterText(_field('Reason'), '');
      await tester.ensureVisible(find.text('Delete block'));
      await tester.tap(find.text('Delete block'));
      await tester.pumpAndSettle();

      expect(fixture.result!.outcome, ProjectBlockWriteOutcome.deleted);
      expect(fixture.access.deletes, 1);
      expect(fixture.access.updates, 0);
      expect(fixture.access.deletedId, 'block');
      expect(fixture.store.pending, isNull);
      expect(tester.takeException(), isNull);
    } finally {
      await tester.pumpWidget(const SizedBox.shrink());
      fixture.signal.dispose();
    }
  });

  testWidgets('unknown deletion stays locked across close and reopen', (
    tester,
  ) async {
    _viewport(tester);
    final fixture = _Fixture();
    fixture.access.loseDeleteAck = true;

    try {
      await _open(tester, fixture);
      await tester.ensureVisible(find.text('Delete block'));
      await tester.tap(find.text('Delete block'));
      await tester.pumpAndSettle();
      expect(fixture.store.pending!.dispatching, isTrue);
      expect(fixture.access.row, isNull);
      _expectUnknownDelete();

      final reads = fixture.access.reads;
      await tester.tap(find.text('Close'));
      await tester.pumpAndSettle();
      await _open(tester, fixture);

      _expectUnknownDelete();
      expect(fixture.access.reads, reads);
      expect(fixture.access.deletes, 1);
      expect(fixture.result, isNull);
      expect(tester.takeException(), isNull);
    } finally {
      await tester.pumpWidget(const SizedBox.shrink());
      fixture.signal.dispose();
    }
  });

  testWidgets('320px scale2 prepared discard has no record read or mutation', (
    tester,
  ) async {
    _viewport(tester, width: 320, height: 480);
    final fixture = _Fixture();
    fixture.store.stored = _receipt().encode();

    try {
      await _open(tester, fixture, scale: 2);
      expect(find.byType(ProjectBlockFormFields), findsNothing);
      expect(find.text('Save'), findsNothing);
      await tester.ensureVisible(find.text('Discard unsent operation'));
      await tester.tap(find.text('Discard unsent operation'));
      await tester.pumpAndSettle();

      expect(fixture.result!.outcome, ProjectBlockWriteOutcome.discarded);
      expect(fixture.access.reads, 0);
      expect(fixture.access.updates + fixture.access.deletes, 0);
      expect(fixture.store.clears, 1);
      expect(fixture.store.pending, isNull);
      expect(tester.takeException(), isNull);
    } finally {
      await tester.pumpWidget(const SizedBox.shrink());
      fixture.signal.dispose();
    }
  });

  testWidgets('acknowledged deletion only finishes stored metadata', (
    tester,
  ) async {
    _viewport(tester);
    final fixture = _Fixture();
    fixture.store.stored = _receipt().started().confirmed().encode();
    fixture.access.row = null;

    try {
      await _open(tester, fixture);
      await tester.tap(find.text('Finish operation'));
      await tester.pumpAndSettle();

      expect(fixture.result!.outcome, ProjectBlockWriteOutcome.deleted);
      expect(fixture.access.reads, 0);
      expect(fixture.access.deletes, 0);
      expect(fixture.store.clears, 1);
      expect(fixture.store.pending, isNull);
      expect(tester.takeException(), isNull);
    } finally {
      await tester.pumpWidget(const SizedBox.shrink());
      fixture.signal.dispose();
    }
  });

  testWidgets(
    'known update verification reads ID without sending another update',
    (tester) async {
      _viewport(tester);
      final fixture = _Fixture();
      final receipt = _receipt(update: true).started();
      fixture.store.stored = receipt.encode();
      fixture.access.row = _row(reason: 'Maintenance', note: null);

      try {
        await _open(tester, fixture);
        expect(find.text('Requested update'), findsOneWidget);
        expect(find.text('Comment: Old note'), findsOneWidget);
        expect(find.text('Save'), findsNothing);
        await tester.tap(find.text('Verify operation'));
        await tester.pumpAndSettle();

        expect(fixture.result!.outcome, ProjectBlockWriteOutcome.verified);
        expect(fixture.access.reads, 1);
        expect(fixture.access.updates + fixture.access.deletes, 0);
        expect(fixture.store.pending, isNull);
        expect(tester.takeException(), isNull);
      } finally {
        await tester.pumpWidget(const SizedBox.shrink());
        fixture.signal.dispose();
      }
    },
  );

  testWidgets('replacement intent must be shown before nonce-bound discard', (
    tester,
  ) async {
    _viewport(tester);
    final fixture = _Fixture();
    fixture.store.stored = _receipt().encode();

    try {
      await _open(tester, fixture);
      fixture.store.stored = _receipt(
        nonce: _otherNonce,
        baseline: _row(reason: 'Other operation'),
      ).encode();
      await tester.tap(find.text('Discard unsent operation'));
      await tester.pumpAndSettle();

      expect(fixture.store.clears, 0);
      expect(fixture.result, isNull);
      expect(fixture.store.pending!.nonce, _otherNonce);
      expect(find.text('Other operation'), findsOneWidget);

      await tester.tap(find.text('Discard unsent operation'));
      await tester.pumpAndSettle();
      expect(fixture.result!.outcome, ProjectBlockWriteOutcome.discarded);
      expect(fixture.store.clears, 1);
      expect(fixture.access.updates + fixture.access.deletes, 0);
      expect(tester.takeException(), isNull);
    } finally {
      await tester.pumpWidget(const SizedBox.shrink());
      fixture.signal.dispose();
    }
  });

  testWidgets(
    'busy close/back and live scope loss preserve intent and listener cleanup',
    (tester) async {
      _viewport(tester);
      final fixture = _Fixture();
      final gate = Completer<void>();
      final started = Completer<void>();
      fixture.access.updateGate = gate;
      fixture.access.updateStarted = started;

      try {
        await _open(tester, fixture);
        expect(fixture.signal.isObserved, isTrue);
        await tester.enterText(_field('Reason'), 'Maintenance');
        await tester.tap(find.text('Save'));
        await tester.pump(const Duration(milliseconds: 20));
        expect(started.isCompleted, isTrue);
        expect(_button(tester, 'Close').onPressed, isNull);

        await Navigator.of(
          tester.element(find.byType(ProjectBlockEditorDialog)),
        ).maybePop();
        await tester.pump();
        expect(find.byType(ProjectBlockEditorDialog), findsOneWidget);

        fixture.access.active = false;
        fixture.signal.value++;
        await tester.pump();
        expect(find.byType(ProjectBlockFormFields), findsNothing);
        expect(find.text('Save'), findsNothing);
        expect(_button(tester, 'Close').onPressed, isNull);

        gate.complete();
        await tester.pumpAndSettle();
        expect(fixture.result, isNull);
        expect(fixture.store.pending!.dispatching, isTrue);
        expect(fixture.access.updates, 1);
        await tester.tap(find.text('Close'));
        await tester.pumpAndSettle();
        expect(fixture.signal.isObserved, isFalse);
        expect(fixture.disposals, 1);
        expect(tester.takeException(), isNull);
      } finally {
        if (!gate.isCompleted) {
          gate.complete();
        }

        await tester.pumpAndSettle();
        await tester.pumpWidget(const SizedBox.shrink());
        fixture.signal.dispose();
      }
    },
  );
}

Finder _field(String label) {
  return find.byWidgetPredicate((widget) {
    return widget is SsTextField && widget.label == label;
  });
}

SsButton _button(WidgetTester tester, String label) {
  return tester.widget<SsButton>(find.widgetWithText(SsButton, label));
}

void _expectUnknownDelete() {
  expect(find.byType(ProjectBlockFormFields), findsNothing);
  expect(find.text('Save'), findsNothing);
  expect(find.text('Delete block'), findsNothing);
  expect(find.text('Verify operation'), findsNothing);
  expect(find.text('Finish operation'), findsNothing);
  expect(find.text('Discard unsent operation'), findsNothing);
}

Future<void> _open(
  WidgetTester tester,
  _Fixture fixture, {
  bool canDelete = true,
  double scale = 1,
}) async {
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
              onPressed: () async {
                fixture
                    .result = await showGeneralDialog<ProjectBlockWriteResult>(
                  context: context,
                  barrierDismissible: false,
                  pageBuilder: (routeContext, animation, secondaryAnimation) {
                    return ProjectBlockEditorDialog(
                      coordinator: fixture.coordinator,
                      data: PlanningData(
                        identity: 'scope',
                        projects: [_project],
                      ),
                      baseline: _row(),
                      canDelete: canDelete,
                      scopeChanges: fixture.signal,
                      onDispose: () {
                        fixture.disposals++;
                      },
                    );
                  },
                );
              },
              child: const Text('Open'),
            );
          },
        ),
      ),
    ),
  );
  await tester.tap(find.text('Open'));
  await tester.pumpAndSettle();
}

void _viewport(
  WidgetTester tester, {
  double width = 640,
  double height = 1000,
}) {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = Size(width, height);
  addTearDown(tester.view.resetDevicePixelRatio);
  addTearDown(tester.view.resetPhysicalSize);
}

models.ProjectsUnavailabilityListResultItem _row({
  String reason = 'Closed',
  String? note = 'Old note',
}) {
  return models.ProjectsUnavailabilityListResultItem(
    id: 'block',
    projectId: 'project',
    from: _day,
    to: _day,
    reason: reason,
    note: note,
    createdAt: _day,
    modifiedAt: _day,
  );
}

ProjectBlockReceipt _receipt({
  String nonce = _nonce,
  bool update = false,
  models.ProjectsUnavailabilityListResultItem? baseline,
}) {
  final original = baseline ?? _row();
  final draft = ProjectBlockDraft(
    projectId: 'project',
    from: _day,
    to: _day,
    reason: 'Maintenance',
    note: '',
  );

  return ProjectBlockReceipt(
    scope: 'scope',
    nonce: nonce,
    createdAt: _day,
    baseline: original,
    kind: update ? ProjectBlockWriteKind.update : ProjectBlockWriteKind.delete,
    input: update ? projectBlockWriteInput(draft, original) : null,
  );
}

final class _Signal extends ValueNotifier<int> {
  _Signal() : super(0);

  bool get isObserved {
    return hasListeners;
  }
}

final class _Fixture {
  _Fixture() {
    coordinator = ProjectBlockWriteCoordinator(access: access, receipts: store);
  }

  final access = _Access();
  final store = _Store();
  final signal = _Signal();
  late final ProjectBlockWriteCoordinator coordinator;
  ProjectBlockWriteResult? result;
  int disposals = 0;
}

final class _Store implements ProjectBlockReceiptStore {
  String? stored;
  int clears = 0;
  final stages = <String>[];

  ProjectBlockReceipt? get pending {
    final encoded = stored;

    if (encoded == null) {
      return null;
    }

    return ProjectBlockReceipt.decode(encoded);
  }

  @override
  Future<ProjectBlockReceipt?> read(String scope) async {
    return pending;
  }

  @override
  Future<void> write(ProjectBlockReceipt receipt) async {
    stored = receipt.encode();
    stages.add('${receipt.dispatching}:${receipt.acknowledged}');
  }

  @override
  Future<void> clear(String scope) async {
    clears++;
    stored = null;
  }
}

final class _Access implements ProjectBlockWriteAccess {
  models.ProjectsUnavailabilityListResultItem? row = _row();
  bool active = true;
  bool loseDeleteAck = false;
  int reads = 0;
  int updates = 0;
  int deletes = 0;
  String? deletedId;
  Completer<void>? updateGate;
  Completer<void>? updateStarted;

  @override
  String get scope {
    return 'scope';
  }

  @override
  void checkCurrent() {
    if (!active) {
      throw StateError('TEST_BLOCK_SCOPE_CLOSED');
    }
  }

  @override
  void checkUpdate() {
    checkCurrent();
  }

  @override
  void checkDelete() {
    checkCurrent();
  }

  @override
  Future<models.ProjectsUnavailabilityListResultItem?> getBlock({
    required String id,
    required DateTime from,
    required DateTime to,
  }) async {
    checkCurrent();
    reads++;
    final actual = row;

    if (actual == null ||
        actual.id != id ||
        actual.to.isBefore(from) ||
        actual.from.isAfter(to)) {
      return null;
    }

    return actual;
  }

  @override
  Future<void> updateBlock(
    models.ProjectsUnavailabilityUpdateInput input,
  ) async {
    checkUpdate();
    updates++;
    updateStarted?.complete();
    final gate = updateGate;

    if (gate != null) {
      await gate.future;
    }

    final original = row!;
    final target = projectBlockTargetDraft(original, input);
    row = models.ProjectsUnavailabilityListResultItem(
      id: original.id,
      projectId: target.projectId,
      from: target.from,
      to: target.to,
      reason: target.reason,
      note: target.note.isEmpty ? null : target.note,
      createdAt: original.createdAt,
      modifiedAt: original.modifiedAt.add(const Duration(hours: 1)),
    );
  }

  @override
  Future<void> deleteBlock(String id) async {
    checkDelete();
    deletes++;
    deletedId = id;
    row = null;

    if (loseDeleteAck) {
      throw StateError('TEST_BLOCK_DELETE_ACK_LOST');
    }
  }
}
