import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/features/products/product_categories_picker.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

void main() {
  testWidgets(
    'empty query retains raw selections and toggles exact duplicates',
    (tester) async {
      final fixture = _Fixture(
        options: ['Steel', 'Alu'],
        selected: [' Steel ', ' Steel ', 'Legacy'],
      );

      await tester.pumpWidget(fixture.app());
      await tester.tap(find.byType(TextField));
      await tester.pumpAndSettle();

      expect(find.byType(TextButton), findsNWidgets(4));
      expect(find.byKey(_option(0, ' Steel ')), findsOneWidget);
      expect(find.byKey(_option(1, ' Steel ')), findsOneWidget);

      final chip = find.byKey(
        const ValueKey(('product-category-chip', 0, ' Steel ')),
      );

      expect(
        find.descendant(of: chip, matching: find.byType(TextButton)),
        findsNothing,
      );

      await tester.tap(find.byKey(_option(0, ' Steel ')));
      await tester.pumpAndSettle();

      expect(fixture.selected, ['Legacy']);
      expect(fixture.changes, hasLength(1));
      expect(() {
        fixture.changes.single.add('foreign');
      }, throwsUnsupportedError);
      expect(
        tester.widget<TextField>(find.byType(TextField)).controller!.text,
        '',
      );
      expect(find.byKey(_option(0, 'Legacy')), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'query keeps selected matches within stable first twenty options',
    (tester) async {
      final fixture = _Fixture(
        options: List.generate(24, (index) {
          return 'Cat $index';
        }),
        selected: ['Cat 0'],
      );
      const query = '\uFEFF CAT \uFEFF';

      await tester.pumpWidget(fixture.app());
      await tester.enterText(find.byType(TextField), query);
      await tester.pumpAndSettle();

      expect(find.byType(TextButton), findsNWidgets(21));
      expect(find.byKey(_option(19, 'Cat 19')), findsOneWidget);
      expect(find.byKey(_option(20, 'Cat 20')), findsNothing);
      expect(
        tester
            .widget<Semantics>(find.byKey(_option(0, 'Cat 0')))
            .properties
            .selected,
        isTrue,
      );

      final popup = tester.getRect(
        find.byKey(const ValueKey('product-category-options')),
      );
      final input = tester.getRect(find.byType(TextField));

      expect(popup.width, closeTo(input.width, 0.01));
      expect(popup.top, closeTo(input.bottom + 4, 0.01));
      expect(popup.height, lessThanOrEqualTo(208));

      await tester.tap(find.byKey(_option(0, 'Cat 0')));
      await tester.pumpAndSettle();

      expect(fixture.selected, isEmpty);
      expect(
        tester.widget<TextField>(find.byType(TextField)).controller!.text,
        query,
      );
      expect(
        tester
            .widget<Semantics>(find.byKey(_option(0, 'Cat 0')))
            .properties
            .selected,
        isFalse,
      );

      final outside = find.text('Outside');
      final activePopup = tester.getRect(
        find.byKey(const ValueKey('product-category-options')),
      );

      expect(activePopup.contains(tester.getCenter(outside)), isFalse);

      await tester.tap(outside);
      await tester.pumpAndSettle();

      expect(
        find.byKey(const ValueKey('product-category-options')),
        findsNothing,
      );
      expect(fixture.outsideTaps, 1);
      expect(fixture.selected, isEmpty);
      expect(fixture.changes, hasLength(1));
      expect(
        tester.widget<TextField>(find.byType(TextField)).controller!.text,
        query,
      );
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'unresolved query never creates or replaces selected category IDs',
    (tester) async {
      final fixture = _Fixture(options: ['Known'], selected: ['Known']);

      await tester.pumpWidget(fixture.app());
      await tester.enterText(
        find.byType(TextField),
        'Not an existing category',
      );
      await tester.pumpAndSettle();
      await tester.testTextInput.receiveAction(TextInputAction.done);
      await tester.pumpAndSettle();

      expect(fixture.selected, ['Known']);
      expect(fixture.changes, isEmpty);
      expect(
        find.byKey(const ValueKey('product-category-options')),
        findsNothing,
      );
      expect(find.byType(TextButton), findsOneWidget);
      expect(
        tester.widget<TextField>(find.byType(TextField)).controller!.text,
        'Not an existing category',
      );
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('disabled replaced and disposed owners reject held callbacks', (
    tester,
  ) async {
    final fixture = _Fixture(options: ['Known']);

    await tester.pumpWidget(fixture.app());
    await tester.enterText(find.byType(TextField), 'Kn');
    await tester.pumpAndSettle();

    final row = find.byKey(_option(0, 'Known'));
    final held = tester
        .widget<TextButton>(
          find.descendant(of: row, matching: find.byType(TextButton)),
        )
        .onPressed!;
    final heldQuery = tester
        .widget<SsTextField>(find.byType(SsTextField))
        .onChanged!;

    fixture.update(() {
      fixture.enabled = false;
    });
    await tester.pumpAndSettle();

    held();
    heldQuery('foreign');

    expect(fixture.changes, isEmpty);
    expect(tester.widget<TextField>(find.byType(TextField)).enabled, isFalse);
    expect(
      tester.widget<TextField>(find.byType(TextField)).controller!.text,
      'Kn',
    );
    expect(
      find.byKey(const ValueKey('product-category-options')),
      findsNothing,
    );

    fixture.update(() {
      fixture.enabled = true;
    });
    await tester.pumpAndSettle();

    held();

    fixture.update(() {
      fixture.identity = 'scope-two';
      fixture.options = ['Other'];
      fixture.selected = ['Other'];
    });
    await tester.pumpAndSettle();

    held();
    heldQuery('Known');

    expect(fixture.selected, ['Other']);
    expect(fixture.changes, isEmpty);
    expect(
      tester.widget<TextField>(find.byType(TextField)).controller!.text,
      '',
    );

    fixture.update(() {
      fixture.identity = 'scope-one';
    });
    await tester.pumpAndSettle();

    held();

    await tester.pumpWidget(const SizedBox.shrink());

    held();
    heldQuery('Known');

    expect(fixture.changes, isEmpty);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'keyboard activation toggles an existing option without clearing query',
    (tester) async {
      final fixture = _Fixture(options: ['Known']);

      await tester.pumpWidget(fixture.app());
      await tester.enterText(find.byType(TextField), 'Kn');
      await tester.pumpAndSettle();

      final caption = find.descendant(
        of: find.byKey(_option(0, 'Known')),
        matching: find.text('Known'),
      );

      Focus.of(tester.element(caption)).requestFocus();
      await tester.pump();
      await tester.sendKeyEvent(LogicalKeyboardKey.space);
      await tester.pumpAndSettle();

      expect(fixture.selected, ['Known']);
      expect(fixture.changes, hasLength(1));
      expect(
        tester.widget<TextField>(find.byType(TextField)).controller!.text,
        'Kn',
      );
      expect(find.byKey(_option(0, 'Known')), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'canonical category popup fits doubled German RTL in both themes',
    (tester) async {
      tester.view.physicalSize = const Size(320, 900);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      final longCategory = List.filled(100, 'W').join();
      final fixture = _Fixture(
        options: [longCategory],
        selected: [longCategory],
      );

      for (final colors in [SsColors.light, SsColors.dark]) {
        await tester.pumpWidget(
          fixture.app(colors: colors, rtl: true, scale: 2),
        );
        await tester.enterText(find.byType(TextField), 'w');
        await tester.pumpAndSettle();

        final popup = tester.getRect(
          find.byKey(const ValueKey('product-category-options')),
        );

        expect(popup.left, greaterThanOrEqualTo(0));
        expect(popup.right, lessThanOrEqualTo(320));
        expect(popup.height, lessThanOrEqualTo(208));
        expect(find.byKey(_option(0, longCategory)), findsOneWidget);
        expect(tester.takeException(), isNull);
      }
    },
  );
}

ValueKey<(String, int, String)> _option(int index, String category) {
  return ValueKey(('product-category-option', index, category));
}

class _Fixture {
  _Fixture({required this.options, List<String> selected = const []})
    : selected = List.of(selected);

  List<String> options;
  List<String> selected;
  final changes = <List<String>>[];
  String identity = 'scope-one';
  bool enabled = true;
  int outsideTaps = 0;
  late StateSetter update;

  Widget app({
    SsColors colors = SsColors.light,
    bool rtl = false,
    double scale = 1,
  }) {
    return MaterialApp(
      key: ObjectKey(this),
      home: SsTheme(
        colors: colors,
        child: Builder(
          builder: (context) {
            final media = MediaQuery.of(context);

            return MediaQuery(
              data: media.copyWith(textScaler: TextScaler.linear(scale)),
              child: Directionality(
                textDirection: rtl ? TextDirection.rtl : TextDirection.ltr,
                child: Scaffold(
                  body: SingleChildScrollView(
                    child: Padding(
                      padding: const EdgeInsets.all(16),
                      child: StatefulBuilder(
                        builder: (context, setState) {
                          update = setState;

                          return Column(
                            mainAxisSize: MainAxisSize.min,
                            crossAxisAlignment: CrossAxisAlignment.stretch,
                            children: [
                              ProductCategoriesPicker(
                                label: 'Kategorien',
                                options: options,
                                selected: selected,
                                queryIdentity: identity,
                                enabled: enabled,
                                onChanged: (value) {
                                  setState(() {
                                    selected = value;
                                    changes.add(value);
                                  });
                                },
                              ),
                              // Keep the outside target below the 208px popup.
                              const SizedBox(height: 240),
                              TextButton(
                                onPressed: () {
                                  outsideTaps++;
                                },
                                child: const Text('Outside'),
                              ),
                            ],
                          );
                        },
                      ),
                    ),
                  ),
                ),
              ),
            );
          },
        ),
      ),
    );
  }
}
