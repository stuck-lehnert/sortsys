import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

Widget host(Widget child) {
  return MaterialApp(
    home: Scaffold(
      body: SsTheme(colors: SsColors.light, child: child),
    ),
  );
}

void main() {
  testWidgets('checkboxes validate, toggle, save and reset real bool values', (
    tester,
  ) async {
    final form = GlobalKey<FormState>();
    final changes = <bool>[];
    bool? saved;

    await tester.pumpWidget(
      host(
        Form(
          key: form,
          child: SsCheckboxField(
            label: 'Use address',
            validator: (value) {
              if (value != true) {
                return 'Enable the address.';
              }

              return null;
            },

            onChanged: changes.add,
            onSaved: (value) {
              saved = value;
            },

          ),
        ),
      ),
    );

    expect(form.currentState!.validate(), isFalse);
    await tester.pump();
    expect(find.text('Enable the address.'), findsOneWidget);

    await tester.tap(find.text('Use address'));
    await tester.pump();
    expect(form.currentState!.validate(), isTrue);
    form.currentState!.save();
    expect(saved, isTrue);

    await tester.sendKeyEvent(LogicalKeyboardKey.space);
    await tester.pump();
    expect(changes, [true, false]);

    await tester.tap(find.text('Use address'));
    await tester.pump();
    form.currentState!.reset();
    await tester.pump();
    form.currentState!.save();
    expect(saved, isFalse);
    expect(
      tester.getSize(find.byType(SsCheckbox)).height,
      greaterThanOrEqualTo(44),
    );
  });

  testWidgets(
    'checkbox semantics expose checked state and disabled controls do not toggle',
    (tester) async {
      final semantics = tester.ensureSemantics();

      try {
        await tester.pumpWidget(
          host(const SsCheckbox(value: true, label: 'Archived')),
        );

        expect(
          tester.getSemantics(find.byType(SsCheckbox)),
          matchesSemantics(
            label: 'Archived',
            hasCheckedState: true,
            isChecked: true,
            hasEnabledState: true,
            isEnabled: false,
          ),
        );

        await tester.tap(find.text('Archived'));
        await tester.pump();
        expect(
          tester.widget<SsCheckbox>(find.byType(SsCheckbox)).value,
          isTrue,
        );
        expect(find.byType(Checkbox), findsNothing);
      } finally {
        semantics.dispose();
      }

    },

  );

  testWidgets('textarea preserves whitespace and newlines through Form save', (
    tester,
  ) async {
    final form = GlobalKey<FormState>();
    final controller = TextEditingController();
    addTearDown(controller.dispose);
    String? saved;
    const value = 'First line\n\n  Second line  ';

    await tester.pumpWidget(
      host(
        Form(
          key: form,
          child: SsTextAreaField(
            label: 'Notes',
            helper: 'Enter the complete note.',
            controller: controller,
            minLines: 5,
            maxLines: 10,
            onSaved: (text) {
              saved = text;
            },

          ),
        ),
      ),
    );

    await tester.enterText(find.byType(TextFormField), value);
    form.currentState!.save();

    final input = tester.widget<TextField>(find.byType(TextField));
    expect(input.keyboardType, TextInputType.multiline);
    expect(input.textInputAction, TextInputAction.newline);
    expect(input.minLines, 5);
    expect(input.maxLines, 10);
    expect(saved, value);
    expect(controller.text, value);
    expect(tester.getSize(find.byType(TextField)).height, greaterThan(90));
  });

  testWidgets('textarea shares validation and disabled editing behavior', (
    tester,
  ) async {
    final form = GlobalKey<FormState>();

    await tester.pumpWidget(
      host(
        Form(
          key: form,
          child: SsTextAreaField(
            label: 'Description',
            enabled: false,
            initialValue: 'Existing description',
            validator: (value) {
              return value == 'Existing description'
                  ? null
                  : 'Invalid description.';
            },

          ),
        ),
      ),
    );

    expect(form.currentState!.validate(), isTrue);
    expect(tester.widget<TextField>(find.byType(TextField)).enabled, isFalse);
    expect(find.text('Existing description'), findsOneWidget);
  });

}
