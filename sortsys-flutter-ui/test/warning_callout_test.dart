import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

void main() {
  testWidgets('warning callout uses canonical light and dark warning mixes', (
    tester,
  ) async {
    for (final colors in [SsColors.light, SsColors.dark]) {
      await _pump(tester, colors: colors, kind: SsCalloutKind.warning);
      final warning = colors.brightness == Brightness.dark
          ? const Color(0xffe9b26e)
          : const Color(0xffc87415);
      final box = _box(tester);
      final border = box.border! as BorderDirectional;

      expect(colors.warning, warning);
      expect(box.color, Color.lerp(colors.surface, warning, 0.09));
      expect(border.start.color, Color.lerp(colors.border, warning, 0.55));
      expect(border.start.width, 4);
      expect(border.top.width, 1);
      expect(box.borderRadius, isNull);
      expect(find.byType(SsIcon), findsNothing);
      expect(tester.takeException(), isNull);
    }
  });

  testWidgets(
    'default info callout retains palette geometry and directional border',
    (tester) async {
      for (final direction in [TextDirection.ltr, TextDirection.rtl]) {
        await _pump(tester, direction: direction);
        final box = _box(tester);
        final border = box.border!.resolve(direction);
        final container = tester.widget<Container>(_container());
        final style = DefaultTextStyle.of(tester.element(find.text('Notice')))
            .style;

        expect(
          box.color,
          Color.lerp(SsColors.light.surface, SsColors.light.accent, 0.08),
        );
        expect(
          border.top.color,
          Color.lerp(SsColors.light.border, SsColors.light.accent, 0.4),
        );
        expect(
          direction == TextDirection.ltr
              ? border.left.width
              : border.right.width,
          4,
        );
        expect(
          container.padding,
          const EdgeInsets.symmetric(horizontal: 10.88, vertical: 9.6),
        );
        expect(style.fontSize, 14.08);
        expect(tester.takeException(), isNull);
      }
    },
  );
}

Finder _container() {
  return find
      .descendant(
        of: find.byType(SsInfoCallout),
        matching: find.byType(Container),
      )
      .first;
}

BoxDecoration _box(WidgetTester tester) {
  return tester.widget<Container>(_container()).decoration! as BoxDecoration;
}

Future<void> _pump(
  WidgetTester tester, {
  SsColors colors = SsColors.light,
  SsCalloutKind kind = SsCalloutKind.info,
  TextDirection direction = TextDirection.ltr,
}) async {
  await tester.pumpWidget(
    MaterialApp(
      home: SsTheme(
        colors: colors,
        child: Directionality(
          textDirection: direction,
          child: Scaffold(
            body: SsInfoCallout(kind: kind, child: const Text('Notice')),
          ),
        ),
      ),
    ),
  );
}
