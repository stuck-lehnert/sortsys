import 'dart:ui' show PointerDeviceKind;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

void main() {
  testWidgets('operational tags use canonical blue mixes and geometry', (
    tester,
  ) async {
    for (final colors in [SsColors.light, SsColors.dark]) {
      await _pump(tester, colors: colors);
      final decoration = _decoration(tester);
      final border = decoration.border! as Border;
      final style = tester.widget<DefaultTextStyle>(
        find.descendant(
          of: find.byKey(const ValueKey('operational')),
          matching: find.byType(DefaultTextStyle),
        ),
      ).style;
      final padding = tester.widget<Padding>(
        find.descendant(
          of: find.byKey(const ValueKey('operational')),
          matching: find.byType(Padding),
        ),
      );

      expect(decoration.color, Color.lerp(colors.surface, colors.accent, 0.30));
      expect(border.top.color, Color.lerp(colors.border, colors.accent, 0.78));
      expect(border.top.width, 1);
      expect(decoration.borderRadius, isNull);
      expect(style.color, Color.lerp(colors.text, colors.strongAccent, 0.86));
      expect(style.fontSize, 12.48);
      expect(style.height, 1);
      expect(
        padding.padding,
        const EdgeInsets.symmetric(horizontal: 10.28, vertical: 6.76),
      );
      expect(tester.takeException(), isNull);
    }
  });

  testWidgets('operational actions hover and activate by keyboard', (
    tester,
  ) async {
    final highlightStrategy = FocusManager.instance.highlightStrategy;
    FocusManager.instance.highlightStrategy =
        FocusHighlightStrategy.alwaysTraditional;
    addTearDown(() {
      FocusManager.instance.highlightStrategy = highlightStrategy;
    });

    var calls = 0;
    final focus = FocusNode();
    addTearDown(focus.dispose);
    await _pump(tester, focusNode: focus, onPressed: () {
      calls++;
    });
    final pointer = await tester.createGesture(kind: PointerDeviceKind.mouse);
    await pointer.addPointer(location: const Offset(1, 1));
    addTearDown(pointer.removePointer);
    await pointer.moveTo(tester.getCenter(find.text('Filter')));
    await tester.pumpAndSettle();

    expect(
      _decoration(tester).color,
      Color.lerp(SsColors.light.surface, SsColors.light.backgroundAccent, 0.56),
    );
    expect(calls, 0);
    focus.requestFocus();
    await tester.pumpAndSettle();
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.sendKeyEvent(LogicalKeyboardKey.space);
    await tester.pumpAndSettle();

    expect(calls, 2);
    await _pump(tester, focusNode: focus, enabled: false, onPressed: () {
      calls++;
    });
    final pressable = tester.widget<SsPressable>(find.byType(SsPressable));

    expect(pressable.onPressed, isNull);
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();

    expect(calls, 2);
    expect(tester.takeException(), isNull);
  });

  testWidgets('noninteractive operational tags wrap without button behavior', (
    tester,
  ) async {
    await _pump(
      tester,
      label: 'Werkzeuge nach Marke und Kategorie filtern',
      width: 280,
      scale: 2,
    );

    expect(find.byType(SsPressable), findsNothing);
    expect(
      tester.getSize(find.byKey(const ValueKey('operational'))).width,
      lessThanOrEqualTo(280),
    );
    expect(
      tester.getSize(find.byKey(const ValueKey('operational'))).height,
      greaterThan(40),
    );
    expect(tester.takeException(), isNull);
  });
}

BoxDecoration _decoration(WidgetTester tester) {
  return tester.widget<DecoratedBox>(
    find.descendant(
      of: find.byKey(const ValueKey('operational')),
      matching: find.byType(DecoratedBox),
    ),
  ).decoration as BoxDecoration;
}

Future<void> _pump(
  WidgetTester tester, {
  SsColors colors = SsColors.light,
  VoidCallback? onPressed,
  FocusNode? focusNode,
  bool enabled = true,
  String label = 'Filter',
  double width = 320,
  double scale = 1,
}) async {
  await tester.pumpWidget(
    MaterialApp(
      home: SsTheme(
        colors: colors,
        child: Scaffold(
          body: Align(
            alignment: Alignment.topLeft,
            child: MediaQuery(
              data: MediaQueryData(textScaler: TextScaler.linear(scale)),
              child: SizedBox(
                width: width,
                child: Align(
                  alignment: Alignment.topLeft,
                  child: SsOperationalTag(
                    key: const ValueKey('operational'),
                    onPressed: onPressed,
                    focusNode: focusNode,
                    enabled: enabled,
                    child: Text(label),
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
