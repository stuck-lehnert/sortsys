import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/features/projects/project_lifecycle_intent.dart';
import 'package:sortsys_client/features/projects/project_overview_screen.dart';
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

  for (final colors in [SsColors.light, SsColors.dark]) {
    testWidgets('info callout matches canonical geometry and ${colors.brightness}', (
      tester,
    ) async {
      await _pump(tester, colors: colors);

      final callout = find.byType(SsInfoCallout);
      final container = tester.widget<Container>(find.descendant(
        of: callout,
        matching: find.byType(Container),
      ));
      final decoration = container.decoration! as BoxDecoration;
      final border = decoration.border! as BorderDirectional;
      final icon = tester.widget<SsIcon>(find.byType(SsIcon));
      final box = tester.getRect(callout);
      final content = tester.getRect(find.text('Completed project notice'));
      final iconBox = tester.getRect(find.byType(SsIcon));
      final style = DefaultTextStyle.of(
        tester.element(find.text('Completed project notice')),
      ).style;

      expect(border.start.width, 4);
      expect(border.top.width, 1);
      expect(border.end.width, 1);
      expect(border.start.color, Color.lerp(colors.border, colors.accent, 0.4));
      expect(decoration.color, Color.lerp(colors.surface, colors.accent, 0.08));
      expect(decoration.borderRadius, isNull);
      expect(content.left - box.left, closeTo(39.68, 0.01));
      expect(content.top - box.top, closeTo(10.6, 0.01));
      expect(iconBox.left - box.left, closeTo(14.88, 0.01));
      expect(iconBox.top - box.top, closeTo(11.88, 0.01));
      expect(iconBox.width, closeTo(15, 0.001));
      expect(iconBox.height, closeTo(15, 0.001));
      expect(icon.name, 'task-complete');
      expect(icon.color, colors.strongAccent);
      expect(icon.semanticLabel, isNull);
      expect(style.fontSize, 14.08);
      expect(tester.takeException(), isNull);
    });
  }

  testWidgets('info callout mirrors canonical leading border and icon in RTL', (
    tester,
  ) async {
    await _pump(tester, direction: TextDirection.rtl);

    final box = tester.getRect(find.byType(SsInfoCallout));
    final icon = tester.getRect(find.byType(SsIcon));
    final content = tester.getRect(find.text('Completed project notice'));

    expect(box.right - icon.right, closeTo(14.88, 0.01));
    expect(box.right - content.right, closeTo(39.68, 0.01));
    expect(tester.takeException(), isNull);
  });

  testWidgets('project callout scrolls without clipping at320px and doubled text', (
    tester,
  ) async {
    await _pump(tester, width: 320, scale: 2);

    expect(tester.takeException(), isNull);
    await tester.scrollUntilVisible(
      find.text('Completed project notice'),
      100,
      scrollable: find.byType(Scrollable).first,
    );
    final box = tester.getRect(find.byType(SsInfoCallout));
    final content = tester.getRect(find.text('Completed project notice'));

    expect(content.left, greaterThanOrEqualTo(box.left));
    expect(content.right, lessThanOrEqualTo(box.right));
    expect(content.bottom, lessThanOrEqualTo(box.bottom));
    expect(tester.takeException(), isNull);
  });

  test('passive lifecycle intent retains exact generated identifier payload', () {
    for (final action in ProjectLifecycleAction.values) {
      final intent = ProjectLifecycleIntent(id: 'project/one', action: action);
      intent.validate();

      final decoded = ProjectLifecycleIntent.fromWire(
        action.name,
        intent.input.toWire(),
      );

      expect(decoded.input.toWire(), {'id': 'project/one'});
      expect(decoded.action, action);
      expect(decoded.finished, action == ProjectLifecycleAction.finish);
    }

    expect(
      () {
        ProjectLifecycleIntent.fromWire('finish', {'id': ''});
      },
      throwsFormatException,
    );
    expect(
      () {
        ProjectLifecycleIntent.fromWire('delete', {'id': 'one'});
      },
      throwsFormatException,
    );
  });
}

Future<void> _pump(
  WidgetTester tester, {
  SsColors colors = SsColors.light,
  TextDirection direction = TextDirection.ltr,
  double width = 600,
  double scale = 1,
}) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = Size(width, 800);
  addTearDown(tester.view.resetDevicePixelRatio);
  addTearDown(tester.view.resetPhysicalSize);

  await tester.pumpWidget(MaterialApp(
    builder: (context, child) {
      return SsTheme(
        colors: colors,
        child: Directionality(
          textDirection: direction,
          child: MediaQuery(
            data: MediaQuery.of(context).copyWith(
              textScaler: TextScaler.linear(scale),
            ),
            child: child!,
          ),
        ),
      );
    },
    home: Scaffold(
      body: ProjectOverviewLayout(
        project: models.Project(
          id: 'one',
          title: 'Harbor',
          createdAt: DateTime.utc(2026, 1, 1),
          modifiedAt: DateTime.utc(2026, 1, 1),
        ),
        child: const SsInfoCallout(
          icon: 'task-complete',
          child: Text('Completed project notice'),
        ),
      ),
    ),
  ));
  await tester.pumpAndSettle();
}
