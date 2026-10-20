import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

void main() {
  testWidgets('User icon renders its genuine size variants with semantics', (
    tester,
  ) async {
    final semantics = tester.ensureSemantics();

    try {
      await tester.pumpWidget(
        MaterialApp(
          home: SsTheme(
            colors: SsColors.light,
            child: const Scaffold(
              body: Row(
                children: [
                  SsIcon('user', size: 16, semanticLabel: 'User at 16'),
                  SsIcon('user', size: 20, semanticLabel: 'User at 20'),
                  SsIcon('user', size: 32, semanticLabel: 'User at 32'),
                ],
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      final pictures = tester
          .widgetList<SvgPicture>(find.byType(SvgPicture))
          .toList();
      final loaders = pictures.map((picture) {
        return picture.bytesLoader as SvgAssetLoader;
      }).toList();

      expect(
        loaders.map((loader) {
          return loader.assetName;
        }),
        [
          'assets/icons/carbon/user-16.svg',
          'assets/icons/carbon/user.svg',
          'assets/icons/carbon/user.svg',
        ],
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
      expect(find.bySemanticsLabel('User at 16'), findsOneWidget);
      expect(find.bySemanticsLabel('User at 20'), findsOneWidget);
      expect(find.bySemanticsLabel('User at 32'), findsOneWidget);
      expect(tester.takeException(), isNull);
    } finally {
      semantics.dispose();
    }
  });
}
