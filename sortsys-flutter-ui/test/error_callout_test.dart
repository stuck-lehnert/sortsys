import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

void main() {
  testWidgets('error callout uses canonical colors and directional geometry', (
    tester,
  ) async {
    for (final colors in [SsColors.light, SsColors.dark]) {
      for (final direction in [TextDirection.ltr, TextDirection.rtl]) {
        await _pump(tester, colors, direction);

        final container = tester.widget<Container>(
          find
              .descendant(
                of: find.byType(SsInfoCallout),
                matching: find.byType(Container),
              )
              .first,
        );
        final decoration = container.decoration! as BoxDecoration;
        final border = decoration.border! as BorderDirectional;
        final borderColor = Color.lerp(colors.border, colors.danger, 0.46);
        final style = DefaultTextStyle.of(tester.element(find.text('Failure')))
            .style;

        expect(
          decoration.color,
          Color.lerp(colors.surface, colors.danger, 0.1),
        );
        expect(border.start, BorderSide(color: borderColor!, width: 4));
        expect(border.end, BorderSide(color: borderColor));
        expect(border.top, BorderSide(color: borderColor));
        expect(border.bottom, BorderSide(color: borderColor));
        expect(
          container.padding,
          const EdgeInsets.symmetric(horizontal: 10.88, vertical: 9.6),
        );
        expect(style.color, Color.lerp(colors.text, colors.danger, 0.76));
        expect(style.fontSize, 14.08);
        expect(find.byType(SsIcon), findsNothing);
        expect(tester.takeException(), isNull);
      }
    }
  });

  testWidgets(
    'error callout applies canonical tint to an optional actual icon',
    (tester) async {
      for (final colors in [SsColors.light, SsColors.dark]) {
        await _pump(tester, colors, TextDirection.ltr, icon: 'alert-triangle');

        final icon = tester.widget<SsIcon>(find.byType(SsIcon));

        expect(icon.color, Color.lerp(colors.text, colors.danger, 0.78));
        expect(icon.size, 15);
        expect(tester.takeException(), isNull);
      }
    },
  );
}

Future<void> _pump(
  WidgetTester tester,
  SsColors colors,
  TextDirection direction, {
  String? icon,
}) async {
  await tester.pumpWidget(
    Directionality(
      textDirection: direction,
      child: SsTheme(
        colors: colors,
        child: Center(
          child: SizedBox(
            width: 360,
            child: SsInfoCallout(
              kind: SsCalloutKind.error,
              icon: icon,
              child: const Text('Failure'),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}
