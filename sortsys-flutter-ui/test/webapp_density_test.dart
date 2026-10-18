import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

Widget _host(Widget child) {
  return MaterialApp(
    home: Scaffold(
      body: SsTheme(colors: SsColors.light, child: child),
    ),
  );
}

void main() {
  testWidgets(
    'reference button/input/icon geometry is compact without losing actions',
    (tester) async {
      await tester.pumpWidget(
        _host(
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              SsButton(onPressed: () {}, child: const Text('Regular')),

              SsButton(
                size: SsButtonSize.small,
                onPressed: () {},

                child: const Text('Small'),
              ),
              SsIconButton(icon: 'search', label: 'Search', onPressed: () {}),

              const SizedBox(width: 240, child: SsTextField()),
            ],
          ),
        ),
      );

      expect(
        tester.getSize(find.widgetWithText(SsButton, 'Regular')).height,
        32,
      );
      expect(
        tester.getSize(find.widgetWithText(SsButton, 'Small')).height,
        27.52,
      );
      expect(tester.getSize(find.byType(SsIconButton)).height, 28.8);
      expect(
        tester.getSize(find.byType(SsTextField)).height,
        greaterThanOrEqualTo(ssTextFieldMinimumHeight),
      );
      expect(tester.takeException(), isNull);
    },
  );

  for (final scale in [1.0, 2.0]) {
    testWidgets('text input containers keep the minimum at scale $scale', (
      tester,
    ) async {
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(320, 900);
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      var visibilityActions = 0;
      DateTime? selectedDate = DateTime(2026, 10, 12);

      await tester.pumpWidget(
        _host(
          MediaQuery(
            data: MediaQueryData(textScaler: TextScaler.linear(scale)),
            child: SingleChildScrollView(
              child: Column(
                children: [
                  const SsTextField(key: ValueKey('plain')),
                  const SsTextField(
                    key: ValueKey('prefix'),
                    prefix: SsIcon('search'),
                  ),
                  SsTextField(
                    key: const ValueKey('password'),
                    kind: SsTextFieldKind.password,
                    suffix: SsIconButton(
                      icon: 'eye',
                      label: 'Show password',
                      onPressed: () {
                        visibilityActions++;
                      },
                    ),
                  ),
                  const SsTextField(key: ValueKey('disabled'), enabled: false),
                  const SsTextField(key: ValueKey('readonly'), readOnly: true),
                  SsDateField(
                    key: const ValueKey('date'),
                    label: 'Date',
                    clearLabel: 'Clear date',
                    initialValue: selectedDate,
                    onChanged: (value) {
                      selectedDate = value;
                    },
                  ),
                  const SsTextField(
                    key: ValueKey('helper'),
                    helper: 'Additional information below the input.',
                  ),
                  const SsTextField(
                    key: ValueKey('error'),
                    error: 'This value requires a correction before saving.',
                  ),
                ],
              ),
            ),
          ),
        ),
      );

      for (final name in [
        'plain',
        'prefix',
        'password',
        'disabled',
        'readonly',
        'helper',
        'error',
      ]) {
        final editable = find.descendant(
          of: find.byKey(ValueKey(name)),
          matching: find.byType(EditableText),
        );
        final container = InputDecorator.containerOf(tester.element(editable));

        if (container == null) {
          fail('Missing input container for $name');
        }

        expect(
          container.size.height,
          greaterThanOrEqualTo(ssTextFieldMinimumHeight),
          reason: '$name editable container at text scale $scale',
        );
      }

      final action = find.byTooltip('Show password');
      await tester.ensureVisible(action);
      await tester.tap(action);
      await tester.pump();

      expect(visibilityActions, 1);

      final date = find.byKey(const ValueKey('date'));
      final dateEditable = find.descendant(
        of: date,
        matching: find.byType(EditableText),
      );
      final dateContainer = InputDecorator.containerOf(
        tester.element(dateEditable),
      );

      if (dateContainer == null) {
        fail('Missing input container for date');
      }

      expect(
        dateContainer.size.height,
        greaterThanOrEqualTo(ssTextFieldMinimumHeight),
      );

      final dateField = tester.widget<SsDateField>(date);
      final clearDate = find.descendant(
        of: date,
        matching: find.byTooltip(dateField.clearLabel),
      );
      await tester.ensureVisible(clearDate);
      await tester.tap(clearDate);
      await tester.pump();

      expect(selectedDate, isNull);
      expect(tester.takeException(), isNull);
    });
  }

  testWidgets(
    'table rows use CSS cell geometry and regular14.24px type, not nested buttons',
    (tester) async {
      int? selected;

      await tester.pumpWidget(
        _host(
          SsDataTable<int>(
            rows: const [1, 2],
            rowKey: (row) {
              return row;
            },

            onSelected: (row) {
              selected = row;
            },

            columns: [
              SsTableColumn(
                label: 'Title',
                cell: (row) {
                  return Text('Row $row');
                },
              ),
            ],
          ),
        ),
      );

      expect(find.byType(SsButton), findsNothing);
      expect(
        tester.getSize(find.byKey(const ValueKey<Object>(1))).height,
        closeTo(38.144, 0.5),
      );
      final text = tester.widget<Text>(find.text('Row 1'));
      final element = tester.element(find.byWidget(text));
      final style = DefaultTextStyle.of(element).style;

      expect(style.fontSize, 14.24);
      expect(style.height, 1.35);
      expect(style.fontWeight ?? FontWeight.w400, FontWeight.w400);
      await tester.tap(find.text('Row 2'));
      expect(selected, 2);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('table keeps the actual header and state for zero rows', (
    tester,
  ) async {
    await tester.pumpWidget(
      _host(
        SsDataTable<int>(
          rows: const [],
          empty: const Text('No entries available.'),
          rowKey: (row) {
            return row;
          },

          columns: [
            SsTableColumn(
              label: 'Title',
              cell: (row) {
                return Text('$row');
              },
            ),
          ],
        ),
      ),
    );

    expect(find.text('Title'), findsOneWidget);
    expect(find.text('No entries available.'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'persistent header and desktop sidebar match48px and256px reference',
    (tester) async {
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(1440, 900);
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      addTearDown(() async {
        await tester.binding.setSurfaceSize(null);
      });

      await tester.pumpWidget(
        _host(
          SsWorkspaceLayout(
            brand: const Text('Company'),
            menuLabel: 'Open menu',
            closeMenuLabel: 'Close menu',
            headerActions: SsIconButton(
              icon: 'search',
              label: 'Search',
              borderless: true,
              onPressed: () {},
            ),
            navigationBuilder: (close) {
              return const SizedBox(key: ValueKey('navigation'));
            },

            child: const SizedBox(key: ValueKey('content')),
          ),
        ),
      );

      expect(tester.getTopLeft(find.byKey(const ValueKey('content'))).dy, 48);
      expect(
        tester.getSize(find.byKey(const ValueKey('navigation'))).width,
        255,
      );
      expect(tester.getTopLeft(find.byKey(const ValueKey('content'))).dx, 256);
      expect(tester.getTopLeft(find.text('Company')).dx, closeTo(15.2, 0.1));
      expect(find.byTooltip('Open menu'), findsNothing);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('tabs provide real roving keyboard selection and wrap around', (
    tester,
  ) async {
    var value = 'products';

    await tester.pumpWidget(
      _host(
        StatefulBuilder(
          builder: (context, setState) {
            return SsTabs<String>(
              tabs: const [
                SsTab(value: 'products', label: 'Products'),
                SsTab(value: 'notes', label: 'Delivery notes'),
                SsTab(value: 'vendors', label: 'Vendors'),
              ],
              value: value,
              onChanged: (next) {
                setState(() {
                  value = next;
                });
              },
            );
          },
        ),
      ),
    );
    await tester.sendKeyEvent(LogicalKeyboardKey.tab);
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowRight);
    await tester.pumpAndSettle();
    expect(value, 'notes');

    await tester.sendKeyEvent(LogicalKeyboardKey.end);
    await tester.pumpAndSettle();
    expect(value, 'vendors');
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowRight);
    await tester.pumpAndSettle();
    expect(value, 'products');
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowLeft);
    await tester.pumpAndSettle();
    expect(value, 'vendors');
    await tester.sendKeyEvent(LogicalKeyboardKey.home);
    await tester.pumpAndSettle();
    expect(value, 'products');
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'pagination has compact42px geometry and functional page/size controls',
    (tester) async {
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(1200, 700);
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      addTearDown(() async {
        await tester.binding.setSurfaceSize(null);
      });

      int? nextPage;
      int? nextSize;

      await tester.pumpWidget(
        _host(
          Align(
            alignment: Alignment.topLeft,
            child: SsPagination(
              totalItems: 70,
              page: 1,
              pageSize: 25,
              onPage: (page) {
                nextPage = page;
              },

              onPageSize: (size) {
                nextSize = size;
              },
            ),
          ),
        ),
      );

      expect(
        tester.getSize(find.byType(SsPagination)).height,
        closeTo(42.144, 0.5),
      );
      expect(find.text('1-25 / 70'), findsOneWidget);
      await tester.tap(find.text('Previous'));
      expect(nextPage, isNull);
      await tester.tap(find.text('Next'));
      expect(nextPage, 2);
      await tester.tap(find.text('25'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('50'));
      await tester.pumpAndSettle();
      expect(nextSize, 50);
      expect(tester.takeException(), isNull);
    },
  );
}
