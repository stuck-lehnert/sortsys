import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

void main() {
  testWidgets(
    'calendar selection clear save and reset use real nullable dates',
    (tester) async {
      final form = GlobalKey<FormState>();
      DateTime? saved;
      final initial = DateTime(2026, 2, 1);

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SsTheme(
              colors: SsColors.light,
              child: Form(
                key: form,
                child: SsDateField(
                  label: 'Order received on',
                  clearLabel: 'Clear date',
                  initialValue: initial,
                  onSaved: (value) {
                    saved = value;
                  },
                ),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.byTooltip('Order received on'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('18'));
      await tester.pumpAndSettle();
      form.currentState!.save();

      expect(saved, DateTime(2026, 2, 18));
      expect(find.text('18.02.2026'), findsOneWidget);

      await tester.tap(find.byTooltip('Clear date'));
      await tester.pumpAndSettle();
      form.currentState!.save();

      expect(saved, isNull);
      form.currentState!.reset();
      await tester.pumpAndSettle();
      form.currentState!.save();

      expect(saved, initial);
      expect(find.text('01.02.2026'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('calendar handles leap-day and next-month navigation', (
    tester,
  ) async {
    DateTime? selected;

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SsDateField(
            label: 'Date',
            clearLabel: 'Clear date',
            initialValue: DateTime(2028, 2, 1),
            onChanged: (value) {
              selected = value;
            },
          ),
        ),
      ),
    );
    await tester.tap(find.byTooltip('Date'));
    await tester.pumpAndSettle();

    expect(find.text('29'), findsOneWidget);
    await tester.tap(find.byTooltip('Next month'));
    await tester.pumpAndSettle();

    expect(find.text('31'), findsOneWidget);
    await tester.tap(find.text('31'));
    await tester.pumpAndSettle();

    expect(selected, DateTime(2028, 3, 31));
    expect(tester.takeException(), isNull);
  });

  testWidgets('calendar response cannot change a field disabled while open', (
    tester,
  ) async {
    late StateSetter update;
    var enabled = true;
    final selected = <DateTime?>[];

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: StatefulBuilder(
            builder: (context, setState) {
              update = setState;

              return SsDateField(
                label: 'Date',
                clearLabel: 'Clear date',
                initialValue: DateTime(2026, 2, 1),
                enabled: enabled,
                onChanged: selected.add,
              );
            },
          ),
        ),
      ),
    );
    await tester.tap(find.byTooltip('Date'));
    await tester.pumpAndSettle();

    update(() {
      enabled = false;
    });

    await tester.pump();
    await tester.tap(find.text('15'));
    await tester.pumpAndSettle();

    expect(selected, isEmpty);
    expect(find.text('01.02.2026'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'date field validates and disabled actions do not open calendar',
    (tester) async {
      final form = GlobalKey<FormState>();
      final changes = <DateTime?>[];

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Form(
              key: form,
              child: SsDateField(
                label: 'Date',
                clearLabel: 'Clear date',
                enabled: false,
                onChanged: changes.add,
                validator: (value) {
                  return value == null ? 'Required date' : null;
                },
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.byTooltip('Date'));
      await tester.pumpAndSettle();

      expect(changes, isEmpty);
      expect(find.byType(GridView), findsNothing);
      expect(form.currentState!.validate(), isFalse);
      await tester.pump();

      expect(find.text('Required date'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );

  test('typed dates reject rollovers and support local and ISO notation', () {
    expect(ssParseDateText('29.02.2028'), DateTime(2028, 2, 29));
    expect(ssParseDateText('2028-02-29'), DateTime(2028, 2, 29));
    expect(ssParseDateText(' 1.2.2026 '), DateTime(2026, 2, 1));

    for (final input in [
      '',
      '31.02.2026',
      '29.02.2027',
      '2026-13-01',
      '00.01.2026',
      '01.00.2026',
      '01.01.0099',
      '2026-02-30',
      '01.01.999999',
      'not a date',
    ]) {
      expect(ssParseDateText(input), isNull, reason: input);
    }
  });

  testWidgets('typed dates participate in real Form validation and saving', (
    tester,
  ) async {
    final form = GlobalKey<FormState>();
    final changes = <DateTime?>[];
    DateTime? saved;

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Form(
            key: form,
            child: SsDateField(
              label: 'Date',
              clearLabel: 'Clear date',
              onChanged: changes.add,
              onSaved: (value) {
                saved = value;
              },
              validator: (value) {
                return value == null ? 'Required date' : null;
              },
            ),
          ),
        ),
      ),
    );
    await tester.enterText(find.byType(TextField), '18.02.2026');

    expect(form.currentState!.validate(), isTrue);
    form.currentState!.save();
    expect(saved, DateTime(2026, 2, 18));
    expect(changes, [DateTime(2026, 2, 18)]);
    expect(
      tester.getSize(find.byType(InputDecorator)).height,
      greaterThanOrEqualTo(44),
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('malformed optional text blocks saving and can be cleared', (
    tester,
  ) async {
    final form = GlobalKey<FormState>();

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Form(
            key: form,
            child: SsDateField(label: 'Date', clearLabel: 'Clear date'),
          ),
        ),
      ),
    );
    await tester.enterText(find.byType(TextField), '31.02.2026');

    expect(form.currentState!.validate(), isFalse);
    await tester.pump();
    expect(
      tester.widget<TextField>(find.byType(TextField)).controller!.text,
      '31.02.2026',
    );
    expect(find.text('Invalid format.'), findsOneWidget);

    await tester.tap(find.byTooltip('Clear date'));
    await tester.pumpAndSettle();
    expect(form.currentState!.validate(), isTrue);
    expect(
      tester.widget<TextField>(find.byType(TextField)).controller!.text,
      isEmpty,
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('ISO paste normalizes on blur without another value change', (
    tester,
  ) async {
    final changes = <DateTime?>[];

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SsDateField(
            label: 'Date',
            clearLabel: 'Clear date',
            onChanged: changes.add,
          ),
        ),
      ),
    );
    await tester.enterText(find.byType(TextField), '2028-02-29');
    tester.widget<TextField>(find.byType(TextField)).focusNode!.unfocus();
    await tester.pumpAndSettle();

    expect(find.text('29.02.2028'), findsOneWidget);
    expect(changes, [DateTime(2028, 2, 29)]);
    expect(tester.takeException(), isNull);
  });

  testWidgets('reset rejects a calendar result opened for an older edit', (
    tester,
  ) async {
    final form = GlobalKey<FormState>();
    final changes = <DateTime?>[];
    DateTime? saved;
    final initial = DateTime(2026, 2, 1);

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Form(
            key: form,
            child: SsDateField(
              label: 'Date',
              clearLabel: 'Clear date',
              initialValue: initial,
              onChanged: changes.add,
              onSaved: (value) {
                saved = value;
              },
            ),
          ),
        ),
      ),
    );
    await tester.enterText(find.byType(TextField), '18.02.2026');
    await tester.tap(find.byTooltip('Date'));
    await tester.pumpAndSettle();
    form.currentState!.reset();
    await tester.pump();
    await tester.tap(find.text('15'));
    await tester.pumpAndSettle();
    form.currentState!.save();

    expect(saved, initial);
    expect(changes, [DateTime(2026, 2, 18)]);
    expect(find.text('01.02.2026'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('programmatic FormField changes update the editable text', (
    tester,
  ) async {
    final field = GlobalKey<FormFieldState<DateTime>>();

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SsDateField(
            key: field,
            label: 'Date',
            clearLabel: 'Clear date',
          ),
        ),
      ),
    );
    field.currentState!.didChange(DateTime(2028, 2, 29));
    await tester.pump();

    expect(find.text('29.02.2028'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
