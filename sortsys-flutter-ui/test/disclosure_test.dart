import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

void main() {
  testWidgets(
    'collapsed disclosure preserves edits and supports keyboard opening',
    (tester) async {
      final controller = TextEditingController();
      final semantics = tester.ensureSemantics();

      try {
        await tester.pumpWidget(_app(controller: controller));
        await tester.pumpAndSettle();

        expect(_bodyHeight(tester), 0);
        expect(find.bySemanticsLabel('Note'), findsNothing);

        await tester.tap(find.text('Contacts'));
        await tester.pumpAndSettle();
        expect(_bodyHeight(tester), greaterThan(44));
        expect(find.bySemanticsLabel('Note'), findsOneWidget);

        await tester.enterText(
          find.byKey(const ValueKey('note')),
          'Retained note',
        );
        await tester.tap(find.text('Contacts'));
        await tester.pumpAndSettle();
        expect(_bodyHeight(tester), 0);
        expect(find.bySemanticsLabel('Note'), findsNothing);
        expect(controller.text, 'Retained note');

        await tester.sendKeyEvent(LogicalKeyboardKey.enter);
        await tester.pumpAndSettle();
        expect(_bodyHeight(tester), greaterThan(44));
        expect(find.text('Retained note'), findsOneWidget);
        expect(tester.takeException(), isNull);
      } finally {
        await tester.pumpWidget(const SizedBox.shrink());
        controller.dispose();
        semantics.dispose();
      }
    },
  );

  testWidgets('collapsed controls leave keyboard traversal at doubled text', (
    tester,
  ) async {
    final inside = FocusNode();
    final after = FocusNode();

    try {
      await tester.pumpWidget(_app(inside: inside, after: after, scale: 2));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Contacts'));
      await tester.pumpAndSettle();
      await tester.sendKeyEvent(LogicalKeyboardKey.space);
      await tester.pumpAndSettle();
      expect(_bodyHeight(tester), 0);

      await tester.sendKeyEvent(LogicalKeyboardKey.tab);
      await tester.pumpAndSettle();
      expect(inside.hasFocus, isFalse);
      expect(after.hasPrimaryFocus, isTrue);
      expect(tester.takeException(), isNull);
    } finally {
      await tester.pumpWidget(const SizedBox.shrink());
      inside.dispose();
      after.dispose();
    }
  });
}

double _bodyHeight(WidgetTester tester) {
  final animation = find.descendant(
    of: find.byType(SsDisclosure),
    matching: find.byType(AnimatedAlign),
  );

  return tester.getSize(animation).height;
}

Widget _app({
  TextEditingController? controller,
  FocusNode? inside,
  FocusNode? after,
  double scale = 1,
}) {
  return MaterialApp(
    builder: (context, navigator) {
      return SsTheme(
        colors: SsColors.light,
        child: MediaQuery(
          data: MediaQuery.of(context)
              .copyWith(textScaler: TextScaler.linear(scale)),
          child: navigator ?? const SizedBox.shrink(),
        ),
      );
    },
    home: Scaffold(
      body: Align(
        alignment: Alignment.topLeft,
        child: SizedBox(
          width: 320,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              SsDisclosure(
                title: 'Contacts',
                child: TextField(
                  key: const ValueKey('note'),
                  controller: controller,
                  focusNode: inside,
                  decoration: const InputDecoration(labelText: 'Note'),
                ),
              ),
              TextField(
                focusNode: after,
                decoration: const InputDecoration(labelText: 'After'),
              ),
            ],
          ),
        ),
      ),
    ),
  );
}
