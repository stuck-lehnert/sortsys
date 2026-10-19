import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
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

  testWidgets(
    'text-only navigation activates by keyboard and pointer without a substitute icon',
    (tester) async {
      var calls = 0;
      await _pump(
        tester,
        onPressed: () {
          calls++;
        },
      );
      Focus.of(tester.element(find.text('Händler'))).requestFocus();
      await tester.pumpAndSettle();
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();

      expect(calls, 1);
      await tester.tap(find.text('Händler'));
      await tester.pumpAndSettle();

      expect(calls, 2);
      expect(find.byType(SsIcon), findsNothing);
      await _pump(tester, icon: 'building', onPressed: () {});

      expect(find.byType(SsIcon), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'text-only navigation supports both layouts at 320px with doubled Ubuntu',
    (tester) async {
      for (final vertical in [false, true]) {
        await _pump(tester, vertical: vertical, scale: 2, onPressed: () {});

        expect(find.text('Händler'), findsOneWidget);
        expect(find.byType(SsIcon), findsNothing);
        expect(tester.getSize(find.byType(SsNavigationItem)).width, 160);
        expect(tester.takeException(), isNull);
      }
    },
  );
}

Future<void> _pump(
  WidgetTester tester, {
  String? icon,
  bool vertical = false,
  double scale = 1,
  required VoidCallback onPressed,
}) async {
  tester.view.physicalSize = const Size(320, 400);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);

  await tester.pumpWidget(
    MaterialApp(
      home: SsTheme(
        colors: SsColors.light,
        child: MediaQuery(
          data: MediaQueryData(
            size: const Size(320, 400),
            textScaler: TextScaler.linear(scale),
          ),
          child: Scaffold(
            body: Center(
              child: SizedBox(
                width: 160,
                child: SsNavigationItem(
                  label: 'Händler',
                  icon: icon,
                  selected: false,
                  vertical: vertical,
                  onPressed: onPressed,
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
