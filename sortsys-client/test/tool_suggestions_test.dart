import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/features/tools/tool_suggestions.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

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

  test(
    'tool suggestions preserve raw order duplicates and all matches beyond twenty',
    () {
      final options = <String>[
        ' Drill ',
        'DRILL',
        ' Drill ',
        'Saw',
        for (var index = 0; index < 30; index++) 'Drill $index',
      ];

      final baseline = List<String>.of(options);

      final matches = matchToolSuggestions(options, '  dRiLl  ');

      expect(matches, [' Drill ', 'DRILL', ' Drill ', ...baseline.skip(4)]);
      expect(matches, hasLength(33));
      expect(options, baseline);
    },
  );

  test(
    'tool suggestion queries use all ECMAScript spaces but never trim NEL',
    () {
      final spaces = <int>[
        0x0009,
        0x000a,
        0x000b,
        0x000c,
        0x000d,
        0x0020,
        0x00a0,
        0x1680,
        0x2000,
        0x2001,
        0x2002,
        0x2003,
        0x2004,
        0x2005,
        0x2006,
        0x2007,
        0x2008,
        0x2009,
        0x200a,
        0x2028,
        0x2029,
        0x202f,
        0x205f,
        0x3000,
        0xfeff,
      ];

      for (final point in spaces) {
        final space = String.fromCharCode(point);

        expect(matchToolSuggestions(['Drill'], '${space}DRILL$space'), [
          'Drill',
        ]);
        expect(matchToolSuggestions(['Drill'], space), isEmpty);
      }

      expect(spaces, hasLength(25));
      expect(
        matchToolSuggestions([
          'Drill',
          '\u0085Drill\u0085',
        ], '\u0085DRILL\u0085'),
        ['\u0085Drill\u0085'],
      );
      expect(matchToolSuggestions(['Drill'], '\ufeff  \ufeff'), isEmpty);
      expect(matchToolSuggestions(['\ufeffDrill'], 'drill'), ['\ufeffDrill']);
      expect(matchToolSuggestions(['Drill', '\u0085Drill\u0085'], '\u0085'), [
        '\u0085Drill\u0085',
      ]);
    },
  );

  test(
    'tool suggestions retain JavaScript dotted I final sigma and supplementary case',
    () {
      final options = [
        'ΟΣ',
        'οσ',
        'ος',
        'İ',
        'i\u0307',
        'I',
        '\u{10400}',
        '\u{10428}',
      ];

      expect(matchToolSuggestions(options, 'ΟΣ'), ['ΟΣ', 'ος']);
      expect(matchToolSuggestions(options, 'i\u0307'), ['İ', 'i\u0307']);
      expect(matchToolSuggestions(options, '\u{10400}'), [
        '\u{10400}',
        '\u{10428}',
      ]);
      expect(matchToolSuggestions(['É', 'e\u0301', 'E'], 'é'), ['É']);
      expect(matchToolSuggestions(['É', 'e\u0301', 'E'], 'e\u0301'), [
        'e\u0301',
      ]);
    },
  );

  test(
    'tool suggestion matching preserves unfinished UTF16 without replacement aliases',
    () {
      final options = ['\u{1f600} Drill', '\ufffd Drill'];

      expect(matchToolSuggestions(options, '\ud83d'), ['\u{1f600} Drill']);
      expect(matchToolSuggestions(options, '\ude00'), ['\u{1f600} Drill']);
      expect(matchToolSuggestions(options, '\ufffd'), ['\ufffd Drill']);
    },
  );

  test(
    'tool suggestion results are detached immutable raw values with no empty-query choices',
    () {
      final options = [' Drill ', 'drill'];

      final matches = matchToolSuggestions(options, 'drill');
      final empty = matchToolSuggestions(options, '');

      options.clear();

      expect(matches, [' Drill ', 'drill']);
      expect(empty, isEmpty);
      expect(() {
        matches.add('other');
      }, throwsUnsupportedError);
      expect(() {
        empty.add('other');
      }, throwsUnsupportedError);
    },
  );

  testWidgets(
    'tool suggestion fields use pinned matching and retain free input',
    (tester) async {
      final controller = TextEditingController();
      final form = GlobalKey<FormState>();
      var loads = 0;
      _disposeAfterUnmount(tester, controller);

      await _pump(
        tester,
        controller,
        form,
        load: () async {
          loads++;

          return ['ΟΣ', 'οσ', 'ος'];
        },
      );

      await tester.enterText(find.byType(TextField), 'ΟΣ');
      await _finishSuggestions(tester);

      expect(_option('ΟΣ'), findsOneWidget);
      expect(_option('ος'), findsOneWidget);
      expect(_option('οσ'), findsNothing);
      expect(loads, 1);

      await tester.tap(_option('ος'));
      await tester.pumpAndSettle();

      expect(controller.text, 'ος');

      await tester.enterText(find.byType(TextField), 'new custom brand');
      await _finishSuggestions(tester);

      expect(controller.text, 'new custom brand');
      expect(form.currentState!.validate(), isTrue);
      expect(loads, 1);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'tool suggestion keyboard selection reaches options beyond twenty',
    (tester) async {
      final controller = TextEditingController();
      final form = GlobalKey<FormState>();
      _disposeAfterUnmount(tester, controller);

      await _pump(
        tester,
        controller,
        form,
        load: () async {
          return List.generate(30, (index) {
            return 'Drill $index';
          });
        },
      );

      await tester.enterText(find.byType(TextField), 'drill');
      await _finishSuggestions(tester);

      for (var index = 0; index < 25; index++) {
        await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
        await tester.pumpAndSettle();
      }

      final selected = tester
          .widgetList<SsButton>(find.byType(SsButton))
          .singleWhere((button) {
            return button.selected;
          });

      expect((selected.child as Text).data, 'Drill 25');
      expect(_option('Drill 25').hitTestable(), findsOneWidget);

      await tester.testTextInput.receiveAction(TextInputAction.done);
      await tester.pumpAndSettle();

      expect(controller.text, 'Drill 25');
      expect(form.currentState!.validate(), isTrue);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'tool suggestions reject stale owners held selections and late disposal',
    (tester) async {
      final controller = TextEditingController();
      final form = GlobalKey<FormState>();
      final old = Completer<List<String>>();
      final current = Completer<List<String>>();
      final removed = Completer<List<String>>();
      final changes = <String>[];
      var active = true;
      _disposeAfterUnmount(tester, controller);

      await _pump(
        tester,
        controller,
        form,
        identity: 'old',
        load: () {
          return old.future;
        },
        isCurrent: () {
          return active;
        },
        onChanged: changes.add,
      );

      await tester.enterText(find.byType(TextField), 'dr');
      await tester.pump(const Duration(milliseconds: 300));
      await _pump(
        tester,
        controller,
        form,
        identity: 'current',
        load: () {
          return current.future;
        },
        isCurrent: () {
          return active;
        },
        onChanged: changes.add,
      );
      await tester.enterText(find.byType(TextField), 'dri');
      await tester.pump(const Duration(milliseconds: 300));
      old.complete(['Private Drill']);
      await tester.pumpAndSettle();

      expect(_option('Private Drill'), findsNothing);

      current.complete(['Drill', 'Drill replacement']);
      await tester.pumpAndSettle();

      final held = tester.widget<SsButton>(_option('Drill')).onPressed!;
      final changeCount = changes.length;

      active = false;

      held();
      await tester.pumpAndSettle();

      expect(controller.text, 'dri');
      expect(changes, hasLength(changeCount));

      active = true;
      await _pump(
        tester,
        controller,
        form,
        identity: 'replacement',
        load: () {
          return removed.future;
        },
        isCurrent: () {
          return active;
        },
        onChanged: changes.add,
      );
      await tester.enterText(find.byType(TextField), 'dril');
      await tester.pump(const Duration(milliseconds: 300));
      held();
      await tester.pumpAndSettle();

      expect(controller.text, 'dril');
      expect(_option('Drill'), findsNothing);

      await tester.pumpWidget(const SizedBox.shrink());
      removed.complete(['Drill final']);
      held();
      await tester.pumpAndSettle();

      expect(controller.text, 'dril');
      expect(changes, isNot(contains('Drill')));
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'optional tool suggestions retain free text on failure and disable in narrow RTL themes',
    (tester) async {
      final controller = TextEditingController();
      final form = GlobalKey<FormState>();
      var blockedLoads = 0;
      _disposeAfterUnmount(tester, controller);

      for (final colors in [SsColors.light, SsColors.dark]) {
        await _pump(
          tester,
          controller,
          form,
          identity: (colors, 'failure'),
          width: 320,
          scale: 2,
          german: true,
          rtl: true,
          colors: colors,
          load: () async {
            throw StateError('OPTIONAL_TOOL_SUGGESTIONS_UNAVAILABLE');
          },
        );

        expect(find.text('Marke'), findsOneWidget);

        await tester.enterText(find.byType(TextField), 'Neue Marke');
        await _finishSuggestions(tester);

        expect(controller.text, 'Neue Marke');
        expect(form.currentState!.validate(), isTrue);

        final heldSubmit = tester
            .widget<SsTextField>(find.byType(SsTextField))
            .onSubmitted!;

        await _pump(
          tester,
          controller,
          form,
          identity: (colors, 'disabled'),
          enabled: false,
          width: 320,
          scale: 2,
          german: true,
          rtl: true,
          colors: colors,
          load: () async {
            blockedLoads++;

            return ['Private Drill'];
          },
        );
        heldSubmit('Drill');
        await tester.pumpAndSettle();

        expect(
          tester.widget<SsTextField>(find.byType(SsTextField)).enabled,
          isFalse,
        );
        expect(controller.text, 'Neue Marke');
        expect(blockedLoads, 0);

        await _pump(
          tester,
          controller,
          form,
          identity: (colors, 'inactive'),
          width: 320,
          scale: 2,
          german: true,
          rtl: true,
          colors: colors,
          isCurrent: () {
            return false;
          },
          load: () async {
            blockedLoads++;

            return ['Private Drill'];
          },
        );

        expect(
          tester.widget<SsTextField>(find.byType(SsTextField)).enabled,
          isFalse,
        );
        expect(controller.text, 'Neue Marke');
        expect(blockedLoads, 0);
        expect(tester.takeException(), isNull);
      }
    },
  );
}

Finder _option(String value) {
  return find.byWidgetPredicate((widget) {
    if (widget is! SsButton) {
      return false;
    }

    final child = widget.child;

    return child is Text && child.data == value;
  });
}

Future<void> _finishSuggestions(WidgetTester tester) async {
  await tester.pump(const Duration(milliseconds: 300));
  await tester.pumpAndSettle();
}

void _disposeAfterUnmount(
  WidgetTester tester,
  TextEditingController controller,
) {
  addTearDown(() async {
    await tester.pumpWidget(const SizedBox.shrink());
    controller.dispose();
  });
}

Future<void> _pump(
  WidgetTester tester,
  TextEditingController controller,
  GlobalKey<FormState> form, {
  required Future<List<String>> Function() load,
  Object identity = 'tool-form',
  bool enabled = true,
  bool Function()? isCurrent,
  ValueChanged<String>? onChanged,
  double width = 800,
  double scale = 1,
  bool german = false,
  bool rtl = false,
  SsColors colors = SsColors.light,
}) async {
  tester.view.physicalSize = Size(width, 800);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);

  await tester.pumpWidget(
    MaterialApp(
      locale: Locale(german ? 'de' : 'en'),
      supportedLocales: const [Locale('en'), Locale('de')],
      localizationsDelegates: GlobalMaterialLocalizations.delegates,
      home: SsTheme(
        colors: colors,
        child: MediaQuery(
          data: MediaQueryData(
            size: Size(width, 800),
            textScaler: TextScaler.linear(scale),
          ),
          child: Directionality(
            textDirection: rtl ? TextDirection.rtl : TextDirection.ltr,
            child: Scaffold(
              body: SingleChildScrollView(
                padding: const EdgeInsets.all(16),
                child: Form(
                  key: form,
                  child: SsSuggestionField(
                    label: german ? 'Marke' : 'Brand',
                    controller: controller,
                    queryIdentity: identity,
                    loadSuggestions: load,
                    matchSuggestions: matchToolSuggestions,
                    isCurrent: isCurrent,
                    enabled: enabled,
                    onChanged: onChanged,
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}
