import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

typedef LookupOption = ({String id, String label});

Widget formHost(Widget child) {
  return MaterialApp(
    home: Scaffold(
      body: SsTheme(colors: SsColors.light, child: child),
    ),
  );
}

void main() {
  testWidgets('unresolved free text cannot save a typed relation', (
    tester,
  ) async {
    final form = GlobalKey<FormState>();

    await tester.pumpWidget(
      formHost(
        Form(
          key: form,
          child: SsAutocompleteField<LookupOption>(
            label: 'Customer',
            displayString: (option) {
              return option.label;
            },

            loadOptions: (query) {
              return const [];
            },

          ),
        ),
      ),
    );

    await tester.enterText(find.byType(TextFormField), 'not-an-entity-id');
    expect(form.currentState!.validate(), isFalse);
    await tester.pump();
    expect(find.text('Choose an option from the list.'), findsOneWidget);

    await tester.enterText(find.byType(TextFormField), '');
    expect(form.currentState!.validate(), isTrue);
  });

  testWidgets(
    'multi autocomplete saves typed unique selections and removes them',
    (tester) async {
      final form = GlobalKey<FormState>();
      List<LookupOption>? saved;
      const one = (id: '1', label: 'One');
      const two = (id: '2', label: 'Two');

      await tester.pumpWidget(
        formHost(
          Form(
            key: form,
            child: SsMultiAutocompleteField<LookupOption>(
              label: 'Recipients',
              initialValue: const [one],
              displayString: (option) {
                return option.label;
              },

              optionKey: (option) {
                return option.id;
              },

              loadOptions: (query) {
                return const [one, two, two];
              },

              onSaved: (value) {
                saved = value;
              },

            ),
          ),
        ),
      );

      await tester.enterText(find.byType(TextFormField), 'T');
      await tester.pump(const Duration(milliseconds: 300));
      await tester.pump();
      expect(find.text('Two'), findsOneWidget);

      await tester.tap(find.text('Two'));
      await tester.pump();
      form.currentState!.save();
      expect(saved, const [one, two]);
      expect(
      () {
        saved!.add(one);
      },

      throwsUnsupportedError,
    );

      final removeOne = find.byWidgetPredicate((widget) {
        return widget is SsIconButton && widget.label == 'Remove One';
      });

      await tester.tap(removeOne);
      await tester.pump();
      form.currentState!.save();
      expect(saved, const [two]);

      form.currentState!.reset();
      await tester.pump();
      form.currentState!.save();
      expect(saved, const [one]);
    },

  );

  testWidgets('scope changes reject old autocomplete results and reset text', (
    tester,
  ) async {
    final scope = ValueNotifier('first-account');
    final pending = Completer<List<LookupOption>>();
    addTearDown(scope.dispose);

    await tester.pumpWidget(
      formHost(
        ValueListenableBuilder<String>(
          valueListenable: scope,
          builder: (context, value, child) {
            return SsAutocompleteField<LookupOption>(
              label: 'Customer',
              queryIdentity: value,
              displayString: (option) {
                return option.label;
              },

              loadOptions: (query) {
                return pending.future;
              },

            );
          },

        ),
      ),
    );

    await tester.enterText(find.byType(TextFormField), 'old query');
    await tester.pump(const Duration(milliseconds: 300));
    scope.value = 'second-account';
    await tester.pump();
    pending.complete([(id: 'old', label: 'Old account result')]);
    await tester.pump();

    expect(find.text('Old account result'), findsNothing);
    expect(find.text('old query'), findsNothing);
  });

  testWidgets('disabling autocomplete cancels debounce before lookup I/O', (
    tester,
  ) async {
    final enabled = ValueNotifier(true);
    var calls = 0;
    addTearDown(enabled.dispose);

    await tester.pumpWidget(
      formHost(
        ValueListenableBuilder<bool>(
          valueListenable: enabled,
          builder: (context, value, child) {
            return SsAutocompleteField<LookupOption>(
              label: 'Customer',
              enabled: value,
              displayString: (option) {
                return option.label;
              },

              loadOptions: (query) {
                calls += 1;

                return const [];
              },

            );
          },

        ),
      ),
    );

    await tester.enterText(find.byType(TextFormField), 'query');
    enabled.value = false;
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(calls, 0);
    expect(tester.widget<TextField>(find.byType(TextField)).enabled, isFalse);
    expect(find.text('Loading options'), findsNothing);
  });

}
