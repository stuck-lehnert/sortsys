import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

void main() {
  setUpAll(() async {
    final fonts = FontLoader('packages/sortsys_ui/Ubuntu');

    for (final weight in ['Regular', 'Medium', 'Bold']) {
      fonts.addFont(rootBundle.load(
        'packages/sortsys_ui/assets/fonts/ubuntu/Ubuntu-$weight.ttf',
      ));
    }

    await fonts.load();
  });

  testWidgets(
    'entity picker hides creation for empty and normalized exact matches',
    (tester) async {
      final selected = <_Entity>[];
      var calls = 0;
      await _pump(
        tester,
        selected: selected,
        create: (query) async {
          calls++;

          return _created;
        },
      );
      await _query(tester, ' ');

      expect(find.textContaining('Create vendor:'), findsNothing);
      await _query(tester, ' cEmEnT ');

      expect(find.textContaining('Create vendor:'), findsNothing);
      await _query(tester, 'New');

      expect(find.text('Create vendor: New'), findsOneWidget);
      await tester.tap(find.text('Cement').last);
      await tester.pumpAndSettle();

      expect(selected.single, same(_existing));
      expect(calls, 0);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'entity picker keyboard creates once and selects only its returned record',
    (tester) async {
      final selected = <_Entity>[];
      final pending = Completer<_Entity?>();
      final queries = <String>[];
      await _pump(
        tester,
        selected: selected,
        create: (query) {
          queries.add(query);

          return pending.future;
        },
      );
      await _query(tester, ' New Vendor ');
      await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
      await tester.testTextInput.receiveAction(TextInputAction.done);
      await tester.pump();

      expect(queries, ['New Vendor']);
      expect(selected, isEmpty);
      expect(tester.widget<TextField>(find.byType(TextField)).enabled, isFalse);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);

      expect(queries, hasLength(1));
      pending.complete(_created);
      await tester.pumpAndSettle();

      expect(selected.single, same(_created));
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'entity picker restores cancelled or failed creation without selection',
    (tester) async {
      for (final fail in [false, true]) {
        final selected = <_Entity>[];
        await _pump(
          tester,
          identity: 'restore-$fail',
          selected: selected,
          create: (query) async {
            if (fail) {
              throw StateError('DIALOG_FAILED');
            }

            return null;
          },
        );
        await _query(tester, 'Vendor Draft');
        await tester.tap(find.text('Create vendor: Vendor Draft'));
        await tester.pumpAndSettle();

        expect(selected, isEmpty);
        expect(
          tester.widget<EditableText>(find.byType(EditableText)).controller.text,
          'Vendor Draft',
        );
        expect(find.text('Creation dialog failed.'), fail ? findsOneWidget : findsNothing);
        expect(tester.takeException(), isNull);
      }
    },
  );

  testWidgets(
    'entity picker ignores created records after owner change or disposal',
    (tester) async {
      for (final dispose in [false, true]) {
        final selected = <_Entity>[];
        final pending = Completer<_Entity?>();

        Future<_Entity?> create(String query) {
          return pending.future;
        }

        await _pump(tester, identity: 'first-$dispose', selected: selected, create: create);
        await _query(tester, 'New');
        await tester.tap(find.text('Create vendor: New'));
        await tester.pump();

        if (dispose) {
          await tester.pumpWidget(const SizedBox.shrink());
        } else {
          await _pump(tester, identity: 'other', selected: selected, create: create);
        }

        pending.complete(_created);
        await tester.pumpAndSettle();

        expect(selected, isEmpty);
        expect(tester.takeException(), isNull);
      }
    },
  );

  testWidgets(
    'entity picker rejects pending creation after disabling or capability loss',
    (tester) async {
      for (final disable in [false, true]) {
        final selected = <_Entity>[];
        final pending = Completer<_Entity?>();

        Future<_Entity?> create(String query) {
          return pending.future;
        }

        await _pump(tester, identity: 'guard-$disable', selected: selected, create: create);
        await _query(tester, 'New');
        await tester.tap(find.text('Create vendor: New'));
        await tester.pump();
        await _pump(
          tester,
          identity: 'guard-$disable',
          selected: selected,
          enabled: !disable,
          create: disable ? create : null,
        );
        pending.complete(_created);
        await tester.pumpAndSettle();

        expect(selected, isEmpty);
        expect(tester.takeException(), isNull);
      }
    },
  );

  testWidgets(
    'entity picker fits German doubled Ubuntu and preserves caller focus ownership',
    (tester) async {
      final focus = FocusNode();
      addTearDown(focus.dispose);
      final selected = <_Entity>[];
      await _pump(
        tester,
        selected: selected,
        focus: focus,
        german: true,
        width: 320,
        scale: 2,
        create: (query) async {
          return _created;
        },
      );
      focus.requestFocus();
      await _query(tester, 'Ein Händler');

      expect(find.text('Händler erstellen: Ein Händler'), findsOneWidget);
      await tester.tap(find.text('Händler erstellen: Ein Händler'));
      await tester.pumpAndSettle();

      expect(selected.single, same(_created));
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
      focus.addListener(_listener);
      focus.removeListener(_listener);
    },
  );
}

void _listener() {}

Future<void> _query(WidgetTester tester, String query) async {
  await tester.enterText(find.byType(TextField), query);
  await tester.pump(const Duration(milliseconds: 300));
  await tester.pumpAndSettle();
}

Future<void> _pump(
  WidgetTester tester, {
  required List<_Entity> selected,
  Future<_Entity?> Function(String)? create,
  Object identity = 'scope',
  bool enabled = true,
  bool german = false,
  FocusNode? focus,
  double width = 600,
  double scale = 1,
}) async {
  tester.view.physicalSize = Size(width, 800);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);

  await tester.pumpWidget(
    MaterialApp(
      home: SsTheme(
        colors: SsColors.light,
        child: MediaQuery(
          data: MediaQueryData(textScaler: TextScaler.linear(scale)),
          child: Scaffold(
            body: Padding(
              padding: const EdgeInsets.all(16),
              child: Form(
                child: SsEntityPicker<_Entity>(
                  label: german ? 'Händler' : 'Vendors',
                  queryIdentity: identity,
                  focusNode: focus,
                  enabled: enabled,
                  loadOptions: (query) async {
                    return [_existing];
                  },
                  displayString: (entity) {
                    return entity.name;
                  },
                  onSelected: selected.add,
                  onCreate: create,
                  createLabel: (query) {
                    return '${german ? 'Händler erstellen' : 'Create vendor'}: $query';
                  },
                  createFailureText: 'Creation dialog failed.',
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.pump();
}

const _existing = _Entity('existing', 'Cement');
const _created = _Entity('acknowledged-created-id', 'New Vendor');

final class _Entity {
  const _Entity(this.id, this.name);

  final String id;
  final String name;
}
