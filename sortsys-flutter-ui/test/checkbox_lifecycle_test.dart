import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

void main() {
  testWidgets('held checkbox field callback ignores disposed form state', (
    tester,
  ) async {
    final changes = <bool>[];

    await tester.pumpWidget(
      _host(
        SsCheckboxField(
          label: 'Confirm',
          onChanged: (value) {
            changes.add(value);
          },
        ),
      ),
    );

    final change = tester
        .widget<SsCheckbox>(find.byType(SsCheckbox))
        .onChanged!;

    await tester.pumpWidget(const SizedBox());

    expect(() {
      change(true);
    }, returnsNormally);
    await tester.pump();

    expect(changes, isEmpty);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'held checkbox callback cannot retarget disabled or rebound fields',
    (tester) async {
      final key = GlobalKey<FormFieldState<bool>>();
      final originalChanges = <bool>[];
      final currentChanges = <bool>[];

      Widget field({
        required bool enabled,
        required ValueChanged<bool> onChanged,
      }) {
        return _host(
          SsCheckboxField(
            key: key,
            label: 'Confirm',
            enabled: enabled,
            onChanged: onChanged,
          ),
        );
      }

      await tester.pumpWidget(
        field(
          enabled: true,
          onChanged: (value) {
            originalChanges.add(value);
          },
        ),
      );

      final oldChange = tester
          .widget<SsCheckbox>(find.byType(SsCheckbox))
          .onChanged!;

      await tester.pumpWidget(
        field(
          enabled: false,
          onChanged: (value) {
            currentChanges.add(value);
          },
        ),
      );

      oldChange(true);
      await tester.pump();

      expect(key.currentState!.value, isFalse);
      expect(originalChanges, isEmpty);
      expect(currentChanges, isEmpty);
      expect(
        tester.widget<SsCheckbox>(find.byType(SsCheckbox)).onChanged,
        isNull,
      );

      await tester.pumpWidget(
        field(
          enabled: true,
          onChanged: (value) {
            currentChanges.add(value);
          },
        ),
      );

      oldChange(true);
      await tester.pump();

      expect(key.currentState!.value, isFalse);
      expect(originalChanges, isEmpty);
      expect(currentChanges, isEmpty);

      await tester.tap(find.byType(SsCheckbox));
      await tester.pumpAndSettle();

      expect(key.currentState!.value, isTrue);
      expect(originalChanges, isEmpty);
      expect(currentChanges, [true]);
      expect(tester.takeException(), isNull);
    },
  );
}

Widget _host(Widget child) {
  return MaterialApp(
    home: SsTheme(
      colors: SsColors.dark,
      child: Scaffold(body: child),
    ),
  );
}
