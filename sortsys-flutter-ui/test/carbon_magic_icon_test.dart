import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

const _asset = 'packages/sortsys_ui/assets/icons/carbon/magic.svg';

Widget _host(SsColors colors, Widget child) {
  return MaterialApp(
    home: SsTheme(
      colors: colors,
      child: Scaffold(body: Center(child: child)),
    ),
  );
}

void main() {
  testWidgets('Magic retains all four published paths and three transforms', (
    tester,
  ) async {
    final svg = await rootBundle.loadString(_asset);
    final manifest = await AssetManifest.loadFromAssetBundle(rootBundle);

    final assetNames = manifest.listAssets();
    final paths = RegExp(r'<path d="([^"]+)"(?: transform="([^"]+)")?\s*/>')
        .allMatches(svg)
        .map((match) {
          return (data: match.group(1), transform: match.group(2));
        })
        .toList();

    expect(ssIconNames, contains('magic'));
    expect(assetNames, contains('assets/icons/carbon/magic.svg'));
    expect(assetNames, isNot(contains('assets/carbon_icon_provenance.json')));
    expect(
      assetNames,
      isNot(contains('packages/sortsys_ui/assets/carbon_icon_provenance.json')),
    );
    expect(svg, contains('viewBox="0 0 32 32" fill="currentColor"'));
    expect(svg, contains('Copyright IBM Corp. 2016, 2023'));
    expect(svg, contains('Licensed under Apache-2.0; see LICENSE.'));
    expect(paths, [
      (
        data:
            'M29.4141,24,12,6.5859a2.0476,2.0476,0,0,0-2.8281,0l-2.586,2.586'
            'a2.0021,2.0021,0,0,0,0,2.8281L23.999,29.4141'
            'a2.0024,2.0024,0,0,0,2.8281,0l2.587-2.5865'
            'a1.9993,1.9993,0,0,0,0-2.8281ZM8,10.5859,10.5859,8'
            'l5,5-2.5866,2.5869-5-5Z',
        transform: null,
      ),
      (
        data: 'M2.586 14.586H5.414V17.414H2.586z',
        transform: 'rotate(-45 4 16)',
      ),
      (
        data: 'M14.586 2.586H17.414V5.414H14.586z',
        transform: 'rotate(-45 16 4)',
      ),
      (data: 'M2.586 2.586H5.414V5.414H2.586z', transform: 'rotate(-45 4 4)'),
    ]);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'Magic renders canonical 16px and larger themed sizes with semantics',
    (tester) async {
      final semantics = tester.ensureSemantics();

      try {
        for (final colors in [SsColors.light, SsColors.dark]) {
          await tester.pumpWidget(
            _host(
              colors,
              IconTheme(
                data: IconThemeData(color: colors.text),
                child: const Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    SsIcon('magic', size: 16, semanticLabel: 'Magic at 16'),
                    SsIcon('magic', size: 20, semanticLabel: 'Magic at 20'),
                    SsIcon('magic', size: 32, semanticLabel: 'Magic at 32'),
                  ],
                ),
              ),
            ),
          );
          await tester.pumpAndSettle();

          final pictures = tester.widgetList<SvgPicture>(
            find.byType(SvgPicture),
          );
          final loaders = pictures.map((picture) {
            return picture.bytesLoader as SvgAssetLoader;
          }).toList();

          expect(loaders, hasLength(3));
          expect(
            loaders.map((loader) {
              return loader.assetName;
            }),
            everyElement('assets/icons/carbon/magic.svg'),
          );
          expect(
            loaders.map((loader) {
              return loader.packageName;
            }),
            everyElement('sortsys_ui'),
          );
          expect(
            pictures.map((picture) {
              return picture.width;
            }),
            [16, 20, 32],
          );
          expect(
            pictures.map((picture) {
              return picture.height;
            }),
            [16, 20, 32],
          );
          expect(
            pictures.map((picture) {
              return picture.colorFilter;
            }),
            everyElement(ColorFilter.mode(colors.text, BlendMode.srcIn)),
          );
          expect(find.bySemanticsLabel('Magic at 16'), findsOneWidget);
          expect(find.bySemanticsLabel('Magic at 20'), findsOneWidget);
          expect(find.bySemanticsLabel('Magic at 32'), findsOneWidget);
          expect(tester.takeException(), isNull);
        }
      } finally {
        semantics.dispose();
      }
    },
  );

  testWidgets(
    'Magic number action preserves tooltip keyboard and disabled state',
    (tester) async {
      final semantics = tester.ensureSemantics();
      const label = 'Suggest number';

      try {
        for (final colors in [SsColors.light, SsColors.dark]) {
          final focus = FocusNode();
          var activations = 0;

          Widget action({required bool enabled}) {
            return _host(
              colors,
              SsIconButton(
                icon: 'magic',
                label: label,
                iconSize: 16,
                borderless: true,
                focusNode: focus,
                onPressed: enabled
                    ? () {
                        activations += 1;
                      }
                    : null,
              ),
            );
          }

          try {
            await tester.pumpWidget(action(enabled: true));
            await tester.pumpAndSettle();

            expect(find.byTooltip(label), findsOneWidget);
            expect(tester.getSize(find.byType(SvgPicture)), const Size(16, 16));
            expect(
              tester.getSemantics(find.byType(SsPressable)),
              matchesSemantics(
                label: label,
                isButton: true,
                hasEnabledState: true,
                isEnabled: true,
                isFocusable: true,
                hasFocusAction: true,
                hasTapAction: true,
              ),
            );

            await tester.tap(find.byType(SsIconButton));
            await tester.pump();
            expect(activations, 1);

            focus.requestFocus();
            await tester.pump();
            await tester.sendKeyEvent(LogicalKeyboardKey.enter);
            await tester.pump();
            expect(activations, 2);

            await tester.sendKeyEvent(LogicalKeyboardKey.space);
            await tester.pump();
            expect(activations, 3);

            await tester.pumpWidget(action(enabled: false));
            await tester.pumpAndSettle();
            await tester.tap(find.byType(SsIconButton));
            await tester.sendKeyEvent(LogicalKeyboardKey.enter);
            await tester.sendKeyEvent(LogicalKeyboardKey.space);
            await tester.pump();

            expect(activations, 3);
            expect(find.byTooltip(label), findsOneWidget);
            expect(
              tester.getSemantics(find.byType(SsPressable)),
              matchesSemantics(
                label: label,
                isButton: true,
                hasEnabledState: true,
                isEnabled: false,
              ),
            );
            expect(tester.takeException(), isNull);
          } finally {
            await tester.pumpWidget(const SizedBox.shrink());
            focus.dispose();
          }
        }
      } finally {
        semantics.dispose();
      }
    },
  );

  testWidgets(
    'Magic disabling during a press cancels activation and supports reuse',
    (tester) async {
      final semantics = tester.ensureSemantics();
      const label = 'Suggest number';
      const pressDelay = Duration(milliseconds: 150);

      try {
        for (final colors in [SsColors.light, SsColors.dark]) {
          var enabled = true;
          var activations = 0;
          late StateSetter update;

          await tester.pumpWidget(
            _host(
              colors,
              StatefulBuilder(
                builder: (context, setState) {
                  update = setState;

                  return SsIconButton(
                    icon: 'magic',
                    label: label,
                    iconSize: 16,
                    borderless: true,
                    onPressed: !enabled
                        ? null
                        : () {
                            activations += 1;
                          },
                  );
                },
              ),
            ),
          );
          await tester.pumpAndSettle();

          final interrupted = await tester.startGesture(
            tester.getCenter(find.byType(SsIconButton)),
          );
          await tester.pump(pressDelay);

          update(() {
            enabled = false;
          });
          await tester.pump();

          final disabledFocus = tester
              .widget<FocusableActionDetector>(
                find.descendant(
                  of: find.byType(SsPressable),
                  matching: find.byType(FocusableActionDetector),
                ),
              )
              .focusNode!;

          expect(disabledFocus.canRequestFocus, isFalse);

          // Focus rejects requests immediately; semantics updates next frame.
          disabledFocus.requestFocus();
          await tester.pumpAndSettle();

          expect(disabledFocus.hasFocus, isFalse);
          expect(
            tester.getSemantics(find.byType(SsPressable)),
            matchesSemantics(
              label: label,
              isButton: true,
              hasEnabledState: true,
              isEnabled: false,
            ),
          );

          await interrupted.up();
          await tester.pumpAndSettle();

          expect(activations, 0);
          expect(tester.takeException(), isNull);

          update(() {
            enabled = true;
          });
          await tester.pumpAndSettle();
          await tester.tap(find.byType(SsIconButton));
          await tester.pump();

          expect(activations, 1);

          final canceled = await tester.startGesture(
            tester.getCenter(find.byType(SsIconButton)),
          );
          await tester.pump(pressDelay);
          await canceled.cancel();
          await tester.pumpAndSettle();

          expect(activations, 1);
          expect(tester.takeException(), isNull);

          final disposed = await tester.startGesture(
            tester.getCenter(find.byType(SsIconButton)),
          );
          await tester.pump(pressDelay);
          await tester.pumpWidget(const SizedBox.shrink());
          await disposed.cancel();
          await tester.pump();

          expect(activations, 1);
          expect(tester.takeException(), isNull);
        }
      } finally {
        await tester.pumpWidget(const SizedBox.shrink());
        semantics.dispose();
      }
    },
  );
}
