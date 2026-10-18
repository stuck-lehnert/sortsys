import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/api/model.dart';
import 'package:sortsys_client/features/planning/absence_editor.dart';
import 'package:sortsys_client/features/planning/absence_form_fields.dart';
import 'package:sortsys_client/features/planning/absence_receipt.dart';
import 'package:sortsys_client/features/planning/absence_write_coordinator.dart';
import 'package:sortsys_client/features/planning/planning_data.dart';
import 'package:sortsys_client/features/planning/planning_draft.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

final _day = DateTime(2026, 10, 12);

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

  testWidgets('Save dispatches once verifies ID and returns actual approval', (
    tester,
  ) async {
    final fixture = _Fixture();

    try {
      await _open(tester, fixture);
      await tester.tap(_button('Save'));
      await tester.pumpAndSettle();

      expect(fixture.creates, 1);
      expect(fixture.reads, 1);
      expect(fixture.encoded, isNull);
      expect(fixture.result?.id, 'created');
      expect(
        fixture.result?.status,
        models.UsersVacationsListResultItemStatus.approved,
      );
      expect(find.byType(AbsenceEditorDialog), findsNothing);
      expect(tester.takeException(), isNull);
    } finally {
      await tester.pumpWidget(const SizedBox.shrink());
      fixture.dispose();
    }
  });

  testWidgets('unknown creation exposes no save verification or discard', (
    tester,
  ) async {
    final fixture = _Fixture();
    fixture.failAfterCreate = true;

    try {
      await _open(tester, fixture);
      await tester.tap(_button('Save'));
      await tester.pumpAndSettle();

      expect(fixture.creates, 1);
      expect(fixture.reads, 0);
      expect(fixture.record, isNotNull);
      expect(_button('Save'), findsNothing);
      expect(_button('Verify operation'), findsNothing);
      expect(_button('Discard unsent request'), findsNothing);
      expect(find.textContaining('no acknowledged ID'), findsOneWidget);
      expect(tester.takeException(), isNull);
    } finally {
      await tester.pumpWidget(const SizedBox.shrink());
      fixture.dispose();
    }
  });

  testWidgets('320px scale2 unsent discard never submits or reopens form', (
    tester,
  ) async {
    final fixture = _Fixture();
    final input = absenceWriteInput(
      AbsenceDraft(
        userId: 'actor',
        from: _day,
        to: _day,
        type: models.UsersVacationsListResultItemType.vacation,
      ),
    );
    fixture.encoded = AbsenceWriteReceipt(
      scope: 'scope',
      nonce: '0123456789abcdef0123456789abcdef',
      createdAt: _day,
      input: input,
    ).encode();

    try {
      await _open(tester, fixture, width: 320, scale: 2);

      expect(find.byType(AbsenceFormFields), findsNothing);
      expect(_button('Save'), findsNothing);

      await tester.tap(_button('Discard unsent request'));
      await tester.pumpAndSettle();

      expect(fixture.creates, 0);
      expect(fixture.reads, 0);
      expect(fixture.encoded, isNull);
      expect(find.textContaining('was not submitted'), findsOneWidget);
      expect(find.byType(AbsenceFormFields), findsNothing);
      expect(_button('Discard unsent request'), findsNothing);
      expect(_button('Save'), findsNothing);
      expect(tester.takeException(), isNull);
    } finally {
      await tester.pumpWidget(const SizedBox.shrink());
      fixture.dispose();
    }
  });

  testWidgets('live scope loss removes form and save and releases listener', (
    tester,
  ) async {
    final fixture = _Fixture();

    try {
      await _open(tester, fixture);

      expect(find.byType(AbsenceFormFields), findsOneWidget);

      fixture.current.value = false;
      await tester.pumpAndSettle();

      expect(find.byType(AbsenceFormFields), findsNothing);
      expect(_button('Save'), findsNothing);
      expect(
        find.textContaining('session or permission changed'),
        findsOneWidget,
      );
      expect(fixture.creates, 0);

      await tester.tap(_button('Close'));
      await tester.pumpAndSettle();

      expect(fixture.current.isObserved, isFalse);
      expect(tester.takeException(), isNull);
    } finally {
      await tester.pumpWidget(const SizedBox.shrink());
      fixture.dispose();
    }
  });

  testWidgets('320px scale2 busy save disables close and refuses route pop', (
    tester,
  ) async {
    final fixture = _Fixture();
    final gate = Completer<void>();
    fixture.gate = gate;

    try {
      await _open(tester, fixture, width: 320, scale: 2);
      await tester.tap(_button('Save'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));

      expect(fixture.creates, 1);
      expect(tester.widget<SsButton>(_button('Close')).onPressed, isNull);

      await fixture.navigator.currentState!.maybePop();
      await tester.pump();

      expect(find.byType(AbsenceEditorDialog), findsOneWidget);
      expect(tester.takeException(), isNull);

      gate.complete();
      await tester.pumpAndSettle();

      expect(fixture.creates, 1);
      expect(fixture.result?.id, 'created');
      expect(fixture.encoded, isNull);
    } finally {
      if (!gate.isCompleted) {
        gate.complete();
      }

      await tester.pumpAndSettle();
      await tester.pumpWidget(const SizedBox.shrink());
      fixture.dispose();
    }
  });
}

Finder _button(String label) {
  return find.widgetWithText(SsButton, label);
}

Future<void> _open(
  WidgetTester tester,
  _Fixture fixture, {
  double width = 640,
  double scale = 1,
}) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = Size(width, 1000);
  addTearDown(tester.view.resetDevicePixelRatio);
  addTearDown(tester.view.resetPhysicalSize);

  await tester.pumpWidget(
    MaterialApp(
      navigatorKey: fixture.navigator,
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
            return TextButton(
              onPressed: () async {
                fixture.result =
                    await showGeneralDialog<
                      models.UsersVacationsListResultItem
                    >(
                      context: context,
                      barrierDismissible: false,
                      pageBuilder: (context, animation, secondaryAnimation) {
                        return AbsenceEditorDialog(
                          coordinator: AbsenceWriteCoordinator(
                            access: fixture,
                            receipts: fixture,
                          ),
                          data: PlanningData(identity: 'scope'),
                          currentUserId: 'actor',
                          canManage: false,
                          day: _day,
                          scopeChanges: fixture.current,
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

final class _ScopeSignal extends ValueNotifier<bool> {
  _ScopeSignal() : super(true);

  bool get isObserved {
    return hasListeners;
  }
}

final class _Fixture implements AbsenceWriteAccess, AbsenceReceiptStore {
  final navigator = GlobalKey<NavigatorState>();
  final current = _ScopeSignal();
  String? encoded;
  models.UsersVacationsListResultItem? record;
  models.UsersVacationsListResultItem? result;
  Completer<void>? gate;
  bool failAfterCreate = false;
  int creates = 0;
  int reads = 0;

  void dispose() {
    current.dispose();
  }

  @override
  String get scope {
    return 'scope';
  }

  @override
  void checkCurrent() {
    if (!current.value) {
      throw StateError('SCOPE_CHANGED');
    }
  }

  @override
  void checkCreate(models.UsersVacationsCreateInput input) {
    checkCurrent();

    if (input.userId.valueOrNull != 'actor') {
      throw StateError('RECIPIENT_NOT_ALLOWED');
    }
  }

  @override
  Future<models.UsersVacationsCreateResult> createAbsence(
    models.UsersVacationsCreateInput input,
  ) async {
    checkCreate(input);

    creates++;
    final pending = gate;

    if (pending != null) {
      await pending.future;
    }

    record = models.UsersVacationsListResultItem(
      id: 'created',
      userId: 'actor',
      from: readRpcDate(input.from),
      to: readRpcDate(input.to),
      type: input.type.valueOrNull!,
      label: input.label.valueOrNull,
      note: input.note.valueOrNull,
      status: models.UsersVacationsListResultItemStatus.approved,
      canApprove: false,
      canDeny: false,
      canDelete: false,
      vacationUsage: const [],
      createdAt: _day,
      modifiedAt: _day,
    );

    if (failAfterCreate) {
      throw StateError('RESPONSE_LOST');
    }

    return const models.UsersVacationsCreateResult(
      id: 'created',
      status: models.UsersVacationsListResultItemStatus.approved,
    );
  }

  @override
  Future<models.UsersVacationsListResultItem?> getAbsence(
    String id,
    models.UsersVacationsCreateInput target,
  ) async {
    checkCurrent();

    reads++;
    final value = record;

    if (value == null ||
        value.id != id ||
        !absenceMatchesInput(value, target)) {
      return null;
    }

    return models.UsersVacationsListResultItem.fromWire(value.toWire());
  }

  @override
  Future<AbsenceWriteReceipt?> read(String scope) async {
    final value = encoded;

    if (value == null) {
      return null;
    }

    return AbsenceWriteReceipt.decode(value);
  }

  @override
  Future<void> write(AbsenceWriteReceipt receipt) async {
    encoded = receipt.encode();
  }

  @override
  Future<void> clear(String scope) async {
    encoded = null;
  }
}
