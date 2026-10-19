import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

void main() {
  testWidgets('tag palettes match canonical CSS mixes in both themes', (
    tester,
  ) async {
    for (final colors in [SsColors.light, SsColors.dark]) {
      final palettes = [
        (
          SsTagTone.outline,
          colors.mutedSurface.withValues(alpha: 0.88),
          colors.border,
          colors.text,
        ),
        (
          SsTagTone.neutral,
          Color.lerp(colors.surface, colors.secondaryText, 0.18),
          Color.lerp(colors.border, colors.secondaryText, 0.46),
          colors.text,
        ),
        (
          SsTagTone.green,
          Color.lerp(colors.surface, colors.success, 0.30),
          Color.lerp(colors.border, colors.success, 0.74),
          Color.lerp(colors.text, colors.success, 0.86),
        ),
        (
          SsTagTone.red,
          Color.lerp(colors.surface, colors.danger, 0.26),
          Color.lerp(colors.border, colors.danger, 0.78),
          Color.lerp(colors.text, colors.danger, 0.90),
        ),
        (
          SsTagTone.magenta,
          Color.lerp(colors.surface, const Color(0xff7b54c8), 0.30),
          Color.lerp(colors.border, const Color(0xff7b54c8), 0.78),
          Color.lerp(colors.text, const Color(0xff6e43bc), 0.88),
        ),
        (
          SsTagTone.cyan,
          Color.lerp(colors.surface, colors.accent, 0.30),
          Color.lerp(colors.border, colors.accent, 0.78),
          Color.lerp(colors.text, colors.strongAccent, 0.86),
        ),
      ];

      for (final (tone, background, border, foreground) in palettes) {
        await tester.pumpWidget(
          _host(SsTag(tone: tone, child: const Text('Status')), colors: colors),
        );
        final decoration = tester.widget<DecoratedBox>(
          find.descendant(
            of: find.byType(SsTag),
            matching: find.byType(DecoratedBox),
          ),
        ).decoration as BoxDecoration;
        final style = _style(tester);

        expect(decoration.color, background);
        expect(decoration.border, Border.all(color: border!));
        expect(decoration.borderRadius, isNull);
        expect(style.color, foreground);
        expect(find.byType(SsPressable), findsNothing);
        expect(tester.takeException(), isNull);
      }
    }
  });

  testWidgets('tag sizes preserve canonical font and border-box padding', (
    tester,
  ) async {
    for (final (size, fontSize, padding) in [
      (
        SsTagSize.medium,
        12.48,
        const EdgeInsets.symmetric(horizontal: 10.28, vertical: 6.76),
      ),
      (
        SsTagSize.small,
        11.52,
        const EdgeInsets.symmetric(horizontal: 8.68, vertical: 5.64),
      ),
    ]) {
      await tester.pumpWidget(
        _host(SsTag(size: size, child: const Text('available'))),
      );
      final actualPadding = tester.widget<Padding>(
        find.descendant(
          of: find.byType(SsTag),
          matching: find.byType(Padding),
        ),
      );
      final style = _style(tester);

      expect(actualPadding.padding, padding);
      expect(style.fontSize, fontSize);
      expect(style.fontWeight, FontWeight.w600);
      expect(style.height, 1);
      expect(tester.takeException(), isNull);
    }
  });

  testWidgets('long noninteractive tags wrap at 320px with doubled text', (
    tester,
  ) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(320, 900);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.view.resetPhysicalSize);

    await tester.pumpWidget(
      _host(
        const MediaQuery(
          data: MediaQueryData(textScaler: TextScaler.linear(2)),
          child: SsTag(
            tone: SsTagTone.magenta,
            child: Text('A long status that remains readable on narrow screens'),
          ),
        ),
      ),
    );

    expect(tester.getSize(find.byType(SsTag)).width, lessThanOrEqualTo(320));
    expect(find.byType(SsPressable), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('header accepts a tag subtitle and preserves string subtitles', (
    tester,
  ) async {
    await tester.pumpWidget(
      _host(
        const SsPageHeader(
          title: '41 Makita Bohrer',
          subtitle: 'Hidden fallback',
          subtitleWidget: SsTag(
            tone: SsTagTone.green,
            child: Text('available'),
          ),
        ),
      ),
    );

    expect(find.text('41 Makita Bohrer'), findsOneWidget);
    expect(find.text('available'), findsOneWidget);
    expect(find.text('Hidden fallback'), findsNothing);

    await tester.pumpWidget(
      _host(
        const SsPageHeader(title: 'Project', subtitle: 'Existing subtitle'),
      ),
    );

    expect(find.text('Existing subtitle'), findsOneWidget);
    expect(find.byType(SsTag), findsNothing);
    expect(tester.takeException(), isNull);
  });
}

TextStyle _style(WidgetTester tester) {
  return tester.widget<DefaultTextStyle>(
    find.descendant(
      of: find.byType(SsTag),
      matching: find.byType(DefaultTextStyle),
    ),
  ).style;
}

Widget _host(Widget child, {SsColors colors = SsColors.light}) {
  return MaterialApp(
    home: Scaffold(
      body: SsTheme(colors: colors, child: Center(child: child)),
    ),
  );
}
