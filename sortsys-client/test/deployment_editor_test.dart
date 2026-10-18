import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/api/model.dart';
import 'package:sortsys_client/features/planning/deployment_editor.dart';
import 'package:sortsys_client/features/planning/deployment_form_fields.dart';
import 'package:sortsys_client/features/planning/deployment_receipt.dart';
import 'package:sortsys_client/features/planning/deployment_write_coordinator.dart';
import 'package:sortsys_client/features/planning/planning_board.dart';
import 'package:sortsys_client/features/planning/planning_data.dart';
import 'package:sortsys_client/features/planning/planning_state.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

final _day = DateTime(2026, 10, 12);
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
    'real fields validate times and retain typed normalized payload',
    (tester) async {
      _viewport(tester);
      final values = _values();
      final form = GlobalKey<FormState>();

      try {
        await tester.pumpWidget(_host(_fields(values, form)));
        await tester.pumpAndSettle();

        expect(form.currentState!.validate(), isTrue);
        final input = values.draft().createInputs().single;

        expect(input.userId, _user.id);
        expect(input.projectId, _project.id);
        expect(readRpcDate(input.from), DateTime(2026, 10, 12, 7));
        expect(readRpcDate(input.to), DateTime(2026, 10, 12, 16));
        expect(input.note.valueOrNull, 'Load material');

        final time = find.byWidgetPredicate((widget) {
          return widget is SsTextField && widget.controller == values.fromTime;
        });

        await tester.enterText(time, '25:00');
        expect(form.currentState!.validate(), isFalse);
        await tester.pump();

        expect(find.text('Invalid time (HH:mm).'), findsOneWidget);
        expect(tester.takeException(), isNull);
      } finally {
        await tester.pumpWidget(const SizedBox.shrink());
        values.dispose();
      }
    },
  );

  testWidgets(
    'comment validation matches UTF8 bytes without truncating input',
    (tester) async {
      _viewport(tester);
      final values = _values();
      final form = GlobalKey<FormState>();

      try {
        await tester.pumpWidget(_host(_fields(values, form)));
        await tester.pumpAndSettle();
        values.note.text = List.filled(63, '🙂').join();

        expect(form.currentState!.validate(), isTrue);
        final tooLong = '  ${List.filled(64, '🙂').join()}  ';
        values.note.text = tooLong;

        expect(form.currentState!.validate(), isFalse);
        await tester.pump();

        expect(find.text('Comment is too long.'), findsOneWidget);
        expect(values.note.text, tooLong);
        expect(tester.takeException(), isNull);
      } finally {
        await tester.pumpWidget(const SizedBox.shrink());
        values.dispose();
      }
    },
  );

  testWidgets('320px enlarged edit fields retain one-user selection rule', (
    tester,
  ) async {
    _viewport(tester, width: 320);
    final values = _values();
    final form = GlobalKey<FormState>();

    try {
      await tester.pumpWidget(
        _host(_fields(values, form, editing: true), scale: 2),
      );
      await tester.pumpAndSettle();

      final multi = tester.widget<SsMultiAutocompleteField<models.User>>(
        find.byType(SsMultiAutocompleteField<models.User>),
      );
      expect(await multi.loadOptions(''), isEmpty);
      expect(form.currentState!.validate(), isTrue);
      expect(values.draft().userIds, [_user.id]);
      expect(tester.takeException(), isNull);
    } finally {
      await tester.pumpWidget(const SizedBox.shrink());
      values.dispose();
    }
  });

  testWidgets('unknown creation has no save or misleading verify action', (
    tester,
  ) async {
    _viewport(tester);
    final values = _values();
    final receipt = DeploymentWriteReceipt(
      scope: 'scope',
      nonce: '0123456789abcdef0123456789abcdef',
      createdAt: _day,
      targets: values.draft().createInputs(),
    ).started();
    values.dispose();
    final store = _Store()..encoded = receipt.encode();
    final access = _Access();
    final before = store.encoded;

    await tester.pumpWidget(_host(_dialog(access, store)));
    await tester.pumpAndSettle();

    expect(
      find.textContaining('A creation has no acknowledged ID.'),
      findsOneWidget,
    );
    expect(find.text('Save'), findsNothing);
    expect(find.text('Verify operation'), findsNothing);
    expect(store.encoded, before);
    expect(access.writes, 0);
    expect(access.reads, 0);
    expect(tester.takeException(), isNull);

    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('actual save button returns only acknowledged readback result', (
    tester,
  ) async {
    _viewport(tester);
    final access = _Access();
    final store = _Store();
    DeploymentWriteResult? result;

    Future<void> open(BuildContext context) async {
      result = await showDialog<DeploymentWriteResult>(
        context: context,
        builder: (context) {
          return _dialog(access, store);
        },
      );
    }

    await tester.pumpWidget(
      _host(
        Builder(
          builder: (context) {
            return SsButton(
              onPressed: () {
                unawaited(open(context));
              },
              child: const Text('Open'),
            );
          },
        ),
      ),
    );
    await tester.tap(find.text('Open'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Save'));
    await tester.pumpAndSettle();

    expect(result?.ids, ['saved-1']);
    expect(result?.complete, isTrue);
    expect(access.writes, 1);
    expect(access.reads, 1);
    expect(store.encoded, isNull);
    expect(find.byType(DeploymentEditorDialog), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('live scope loss disables save and removes active form', (
    tester,
  ) async {
    _viewport(tester);
    final access = _Access();
    final signal = ValueNotifier(0);
    addTearDown(signal.dispose);

    await tester.pumpWidget(_host(_dialog(access, _Store(), changes: signal)));
    await tester.pumpAndSettle();

    expect(find.byType(DeploymentFormFields), findsOneWidget);
    access.current = false;
    signal.value++;
    await tester.pump();

    expect(find.byType(DeploymentFormFields), findsNothing);
    expect(
      find.text('The session or permission changed. Close this window.'),
      findsOneWidget,
    );
    final save = tester.widget<SsButton>(find.widgetWithText(SsButton, 'Save'));
    expect(save.onPressed, isNull);
    expect(access.writes, 0);
    expect(tester.takeException(), isNull);

    await tester.pumpWidget(const SizedBox.shrink());
  });
}

DeploymentFormValues _values() {
  return DeploymentFormValues(
    from: DateTime(2026, 10, 12, 7),
    to: DateTime(2026, 10, 12, 16),
    users: [_user],
    project: _project,
    note: '  Load material  ',
  );
}

PlanningViewData _view() {
  return PlanningViewData(
    data: PlanningData(identity: 'scope', users: [_user], projects: [_project]),
    state: PlanningState(Uri(path: '/deployments'), today: _day),
    rowMode: PlanningRowMode.project,
    currentUserId: _user.id,
    currentUserName: 'Ada Lovelace',
    canViewAll: true,
    unknownProject: 'Unknown project',
    unknownUser: 'Unknown user',
  );
}

Widget _fields(
  DeploymentFormValues values,
  GlobalKey<FormState> form, {
  bool editing = false,
}) {
  return SingleChildScrollView(
    child: Form(
      key: form,
      child: DeploymentFormFields(
        values: values,
        data: _view().data,
        identity: 'scope',
        checkCurrent: () {},
        editing: editing,
      ),
    ),
  );
}

Widget _dialog(_Access access, _Store store, {Listenable? changes}) {
  return DeploymentEditorDialog(
    coordinator: DeploymentWriteCoordinator(access: access, receipts: store),
    view: _view(),
    preset: PlanningPreset(day: _day, userId: _user.id, projectId: _project.id),
    loadUser: (id) async {
      throw StateError('UNEXPECTED_LOOKUP');
    },
    loadProject: (id) async {
      throw StateError('UNEXPECTED_LOOKUP');
    },
    scopeChanges: changes,
    onDispose: () {
      access.current = false;
    },
  );
}

Widget _host(Widget child, {double scale = 1}) {
  return MaterialApp(
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
    home: Scaffold(body: child),
  );
}

void _viewport(WidgetTester tester, {double width = 640}) {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = Size(width, 1000);
  addTearDown(tester.view.resetDevicePixelRatio);
  addTearDown(tester.view.resetPhysicalSize);
}

final class _Store implements DeploymentReceiptStore {
  String? encoded;

  @override
  Future<DeploymentWriteReceipt?> read(String scope) async {
    final value = encoded;

    if (value == null) {
      return null;
    }

    return DeploymentWriteReceipt.decode(value);
  }

  @override
  Future<void> write(DeploymentWriteReceipt receipt) async {
    encoded = receipt.encode();
  }

  @override
  Future<void> clear(String scope) async {
    encoded = null;
  }
}

final class _Access implements DeploymentWriteAccess {
  final records = <String, models.Deployment>{};
  bool current = true;
  int reads = 0;
  int writes = 0;

  @override
  String get scope => 'scope';

  @override
  void checkCurrent() {
    if (!current) {
      throw StateError('SCOPE_CHANGED');
    }
  }

  @override
  Future<models.Deployment?> getDeployment(
    String id, {
    required DateTime from,
    required DateTime to,
  }) async {
    checkCurrent();
    reads++;
    final record = records[id];

    if (record == null ||
        !record.to.isAfter(from) ||
        !record.from.isBefore(to)) {
      return null;
    }

    return models.Deployment.fromWire(record.toWire());
  }

  @override
  Future<String> createDeployment(
    models.ProjectsDeploymentsCreateInput input,
  ) async {
    checkCurrent();
    writes++;
    final id = 'saved-$writes';
    records[id] = models.Deployment(
      id: id,
      projectId: input.projectId,
      userId: input.userId,
      from: readRpcDate(input.from),
      to: readRpcDate(input.to),
      note: input.note.valueOrNull,
      createdAt: _day,
      modifiedAt: _day,
    );

    return id;
  }

  @override
  Future<void> updateDeployment(
    models.ProjectsDeploymentsUpdateInput input,
  ) async {
    checkCurrent();
    writes++;

    throw StateError('UNEXPECTED_UPDATE');
  }
}
