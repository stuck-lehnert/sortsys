import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

void main() {
  testWidgets('caller focus reaches autocomplete input and real selection', (
    tester,
  ) async {
    final focus = FocusNode();
    addTearDown(focus.dispose);
    String? selected;
    await _pump(
      tester,
      focus: focus,
      onChanged: (value) {
        selected = value;
      },
    );
    focus.requestFocus();
    await tester.pumpAndSettle();

    expect(focus.hasFocus, isTrue);
    expect(
      tester.widget<EditableText>(find.byType(EditableText)).focusNode,
      same(focus),
    );
    await tester.enterText(find.byType(TextField), 'Cem');
    await tester.pump(const Duration(milliseconds: 300));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Cement').last);
    await tester.pumpAndSettle();

    expect(selected, 'Cement');
    expect(tester.takeException(), isNull);
  });

  testWidgets('caller focus survives query reset and field disposal', (
    tester,
  ) async {
    final focus = FocusNode();
    addTearDown(focus.dispose);
    await _pump(tester, focus: focus, identity: 'first');
    focus.requestFocus();
    await tester.pumpAndSettle();
    await _pump(tester, focus: focus, identity: 'second');
    focus.requestFocus();
    await tester.pumpAndSettle();

    expect(focus.hasFocus, isTrue);
    expect(
      tester.widget<EditableText>(find.byType(EditableText)).focusNode,
      same(focus),
    );
    await tester.pumpWidget(const SizedBox.shrink());
    focus.addListener(_listener);
    focus.removeListener(_listener);

    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'autocomplete switches focus ownership and retains local fallback',
    (tester) async {
      final first = FocusNode();
      final second = FocusNode();
      addTearDown(first.dispose);
      addTearDown(second.dispose);
      await _pump(tester, focus: first);
      await _pump(tester, focus: second);
      second.requestFocus();
      await tester.pumpAndSettle();

      expect(second.hasFocus, isTrue);
      expect(
        tester.widget<EditableText>(find.byType(EditableText)).focusNode,
        same(second),
      );
      first.addListener(_listener);
      first.removeListener(_listener);
      await _pump(tester);
      final local = tester
          .widget<EditableText>(find.byType(EditableText))
          .focusNode;

      expect(local, isNot(same(first)));
      expect(local, isNot(same(second)));
      local.requestFocus();
      await tester.pumpAndSettle();

      expect(local.hasFocus, isTrue);
      await tester.pumpWidget(const SizedBox.shrink());
      second.addListener(_listener);
      second.removeListener(_listener);

      expect(tester.takeException(), isNull);
    },
  );
}

void _listener() {}

Future<void> _pump(
  WidgetTester tester, {
  FocusNode? focus,
  String identity = 'scope',
  ValueChanged<String?>? onChanged,
}) async {
  await tester.pumpWidget(
    MaterialApp(
      home: SsTheme(
        colors: SsColors.light,
        child: Scaffold(
          body: SsAutocompleteField<String>(
            label: 'Product',
            focusNode: focus,
            queryIdentity: identity,
            loadOptions: (query) async {
              return query.isEmpty ? [] : ['Cement'];
            },
            displayString: (value) {
              return value;
            },
            onChanged: onChanged,
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}
