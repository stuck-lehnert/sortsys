import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

Widget navigationHost(Widget child) {
  return MaterialApp(
    home: Scaffold(
      body: SsTheme(colors: SsColors.light, child: child),
    ),
  );
}

void main() {
  testWidgets(
    'Webapp-style sections collapse and support keyboard activation',
    (tester) async {
      await tester.pumpWidget(
        navigationHost(
          const SsNavigationSection(
            label: 'Project work',
            icon: 'layout-dashboard',
            children: [Text('Projects')],
          ),
        ),
      );

      expect(find.text('Projects'), findsNothing);
      await tester.tap(find.text('Project work'));
      await tester.pump();
      expect(find.text('Projects'), findsOneWidget);

      await tester.sendKeyEvent(LogicalKeyboardKey.space);
      await tester.pump();
      expect(find.text('Projects'), findsNothing);
      expect(find.byType(ExpansionTile), findsNothing);
    },

  );

  testWidgets('active route transitions expand the matching Webapp section', (
    tester,
  ) async {
    final active = ValueNotifier(false);
    addTearDown(active.dispose);

    await tester.pumpWidget(
      navigationHost(
        ValueListenableBuilder<bool>(
          valueListenable: active,
          builder: (context, value, child) {
            return SsNavigationSection(
              label: 'Project work',
              icon: 'layout-dashboard',
              active: value,
              children: const [Text('Projects')],
            );
          },

        ),
      ),
    );

    expect(find.text('Projects'), findsNothing);
    active.value = true;
    await tester.pump();
    expect(find.text('Projects'), findsOneWidget);

    await tester.tap(find.text('Project work'));
    await tester.pump();
    expect(find.text('Projects'), findsNothing);
  });

  testWidgets(
    'Webapp sidebar works at 320px and doubled text without bottom tabs',
    (tester) async {
      tester.view.physicalSize = const Size(320, 720);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      await tester.pumpWidget(
        navigationHost(
          MediaQuery(
            data: const MediaQueryData(
              size: Size(320, 720),
              textScaler: TextScaler.linear(2),
            ),
            child: SsWorkspaceLayout(
              brand: const Text('sortsys'),
              menuLabel: 'Open navigation',
              closeMenuLabel: 'Close navigation',
              navigationBuilder: (close) {
                return SingleChildScrollView(
                  child: SsNavigationSection(
                    label: 'Project work',
                    icon: 'layout-dashboard',
                    active: true,
                    children: [
                      SsNavigationItem(
                        label: 'Projects',
                        icon: 'layout-dashboard',
                        selected: true,
                        onPressed: close,
                      ),
                    ],
                  ),
                );
              },

              child: const Text('Workspace'),
            ),
          ),
        ),
      );

      expect(find.byType(BottomNavigationBar), findsNothing);
      await tester.tap(find.byType(SsIconButton).first);
      await tester.pump();
      expect(find.text('Projects'), findsOneWidget);

      await tester.tap(find.text('Projects'));
      await tester.pump();
      expect(find.text('Projects'), findsNothing);
      expect(tester.takeException(), isNull);
    },

  );
}
