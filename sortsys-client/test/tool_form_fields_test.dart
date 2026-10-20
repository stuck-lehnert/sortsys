import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/contract.dart';
import 'package:sortsys_client/api/generated/api.g.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/api/procedure.dart';
import 'package:sortsys_client/features/tools/tool_draft.dart';
import 'package:sortsys_client/features/tools/tool_form_fields.dart';
import 'package:sortsys_client/features/tools/tool_form_reads.dart';
import 'package:sortsys_client/features/tools/tool_rpc_access.dart';
import 'package:sortsys_client/features/tools/tool_suggestions.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

void main() {
  setUpAll(() async {
    final fonts = FontLoader('packages/sortsys_ui/Ubuntu');

    for (final weight in ['Regular', 'Medium', 'Bold']) {
      fonts.addFont(
        rootBundle.load(
          'packages/sortsys_ui/assets/fonts/ubuntu/Ubuntu-$weight.ttf',
        ),
      );
    }

    await fonts.load();
  });

  test(
    'tool form values preserve raw seeds null clears and fixed edit mode',
    () {
      final create = _values(label: ' Initial query ');
      final edit = ToolFormValues(ToolDraft.fromTool(_tool()));
      addTearDown(create.dispose);
      addTearDown(edit.dispose);

      expect(create.label.text, ' Initial query ');
      expect(create.draft().createInput().status.isAbsent, isTrue);
      expect(edit.toolId, 'tool');
      expect(edit.customId.text, '42');
      expect(edit.brand.text, ' Brand ');
      expect(edit.category.text, ' Category ');
      expect(edit.label.text, ' Model ');
      expect(edit.purchasePrice.text, isNot(contains(RegExp('[eE]'))));
      expect(double.parse(edit.purchasePrice.text), 5e-324);
      expect(edit.usageCostPerDay.text, '0');
      expect(edit.status, models.ToolStatus.lost);

      edit.customId.text = '999';
      edit.label.clear();
      edit.purchasePrice.clear();
      edit.status = null;

      expect(edit.draft().updateInput().toWire(), {
        'id': 'tool',
        'data': {
          'brand': 'Brand',
          'category': 'Category',
          'label': null,
          'purchasePrice': null,
          'usageCostPerDay': 0.0,
          'status': null,
        },
      });
      expect(edit.isEditing, isTrue);
      expect(create.isEditing, isFalse);
    },
  );

  test('tool form values reject hidden status and invalid edit targets', () {
    for (final seed in [
      const ToolDraft(toolId: ''),
      const ToolDraft(toolId: '\ud800'),
      const ToolDraft(status: models.ToolStatus.lost),
    ]) {
      expect(
        () {
          ToolFormValues(seed);
        },
        throwsA(
          isA<FormatException>().having(
            (error) {
              return error.message;
            },
            'message',
            'INVALID_TOOL_FORM_CONTEXT',
          ),
        ),
      );
    }
  });

  testWidgets(
    'tool create fields retain canonical order hints and Magic action',
    (tester) async {
      final values = _values(label: ' Initial query ');
      final transport = _FormTransport();
      final form = GlobalKey<FormState>();
      _disposeAfterUnmount(tester, [values]);

      await _mount(tester, values, form, reads: transport.reads);

      expect(_labels(tester), [
        'Number',
        'Brand',
        'Category',
        'Model',
        'Purchase price (EUR)',
        'Usage cost per day (EUR)',
      ]);
      expect(find.byType(SsSelectField<String>), findsNothing);
      expect(
        find.text(
          'Internal tool number used for search, lists, and assignments.',
        ),
        findsOneWidget,
      );
      expect(
        find.text('Model name or additional type information.'),
        findsOneWidget,
      );
      expect(
        find.text(
          'Daily rate used for internal cost calculations and reports.',
        ),
        findsOneWidget,
      );
      expect(values.label.text, ' Initial query ');

      final action = tester.widget<SsIconButton>(find.byType(SsIconButton));
      final number = tester
          .widgetList<SsTextField>(find.byType(SsTextField))
          .first;

      expect(action.icon, 'magic');
      expect(action.iconSize, 16);
      expect(action.label, 'Suggest a number automatically');
      expect(action.tooltip, action.label);
      expect(action.onPressed, isNotNull);
      expect(number.kind, SsTextFieldKind.integer);
      expect(
        transport.requests.map((request) {
          return request.$1;
        }),
        [ApiQueries.toolsBrands, ApiQueries.toolsCategories],
      );
      expect(
        transport.requests.every((request) {
          return identical(request.$2, rpcUndefined);
        }),
        isTrue,
      );
      expect(transport.numberReads, 0);
      expect(transport.writes, 0);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'tool edit status uses real selection and explicit nullable clears',
    (tester) async {
      final values = ToolFormValues(ToolDraft.fromTool(_tool()));
      final transport = _FormTransport(toolId: 'tool');
      final form = GlobalKey<FormState>();
      var changes = 0;
      _disposeAfterUnmount(tester, [values]);

      await _mount(
        tester,
        values,
        form,
        reads: transport.reads,
        onChanged: () {
          changes++;
        },
      );

      expect(_labels(tester).first, 'Status');
      expect(find.text('Number'), findsNothing);
      expect(find.byType(SsIconButton), findsNothing);

      final select = tester.widget<SsSelectField<String>>(
        find.byType(SsSelectField<String>),
      );

      expect(
        select.options.map((option) {
          return (option.value, option.label);
        }),
        [('none', 'No status'), ('lost', 'Missing'), ('broken', 'Broken')],
      );

      await tester.tap(find.byType(DropdownButtonFormField<String>));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Broken').last);
      await tester.pumpAndSettle();

      expect(values.status, models.ToolStatus.broken);
      expect(changes, 1);

      select.onChanged!('unexpected');

      expect(values.status, models.ToolStatus.broken);
      expect(changes, 1);

      await tester.tap(find.byType(DropdownButtonFormField<String>));
      await tester.pumpAndSettle();
      await tester.tap(find.text('No status').last);
      await tester.pumpAndSettle();

      expect(values.status, isNull);
      expect(values.draft().updateInput().data.status.value, isNull);
      expect(changes, 2);
      expect(transport.numberReads, 0);
      expect(transport.writes, 0);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'tool number action serializes reads preserves zero and exact i32',
    (tester) async {
      final values = _values();
      final transport = _FormTransport();
      final form = GlobalKey<FormState>();
      var changes = 0;
      _disposeAfterUnmount(tester, [values]);

      await _mount(
        tester,
        values,
        form,
        reads: transport.reads,
        onChanged: () {
          changes++;
        },
      );

      for (final zero in <num>[0, -0.0]) {
        transport.responses['tools.suggestNextCustomId'] = zero;
        await tester.tap(find.byType(SsIconButton));
        await tester.pumpAndSettle();

        expect(values.customId.text, '7');
        expect(changes, 0);
      }

      final pending = Completer<Object?>();
      transport.responses['tools.suggestNextCustomId'] = pending.future;
      final held = tester
          .widget<SsIconButton>(find.byType(SsIconButton))
          .onPressed!;

      held();
      held();
      await tester.pump();

      expect(transport.numberReads, 3);
      expect(
        tester.widget<SsIconButton>(find.byType(SsIconButton)).onPressed,
        isNull,
      );
      expect(values.customId.text, '7');

      pending.complete(2147483647.0);
      await tester.pumpAndSettle();

      expect(values.customId.text, '2147483647');
      expect(
        values.customId.selection,
        const TextSelection.collapsed(offset: 10),
      );
      expect(values.draft().validate(), isEmpty);
      expect(changes, 1);
      expect(transport.writes, 0);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'tool number lookup failures retain manual entry and permit retry',
    (tester) async {
      final values = _values();
      final transport = _FormTransport();
      final form = GlobalKey<FormState>();
      _disposeAfterUnmount(tester, [values]);

      await _mount(tester, values, form, reads: transport.reads);

      for (final invalid in <num>[
        -1,
        1.5,
        2147483648,
        double.nan,
        double.infinity,
      ]) {
        transport.responses['tools.suggestNextCustomId'] = invalid;
        await tester.tap(find.byType(SsIconButton));
        await tester.pumpAndSettle();

        expect(values.customId.text, '7');
        expect(find.text('A number could not be suggested.'), findsOneWidget);
        expect(
          tester.widget<SsIconButton>(find.byType(SsIconButton)).onPressed,
          isNotNull,
        );
      }

      transport.failures['tools.suggestNextCustomId'] = StateError(
        'LOOKUP_FAILED',
      );
      await tester.tap(find.byType(SsIconButton));
      await tester.pumpAndSettle();

      expect(values.customId.text, '7');
      expect(find.text('A number could not be suggested.'), findsOneWidget);

      await tester.enterText(_input(values.customId), '9');
      await tester.pumpAndSettle();

      expect(find.text('A number could not be suggested.'), findsNothing);
      expect(form.currentState!.validate(), isTrue);

      transport.failures.clear();
      transport.responses['tools.suggestNextCustomId'] = 42;
      await tester.tap(find.byType(SsIconButton));
      await tester.pumpAndSettle();

      expect(values.customId.text, '42');
      expect(transport.numberReads, 7);
      expect(transport.writes, 0);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'tool late number never overwrites an edit reverted to its seed',
    (tester) async {
      final values = _values();
      final transport = _FormTransport();
      final pending = Completer<Object?>();
      transport.responses['tools.suggestNextCustomId'] = pending.future;
      final form = GlobalKey<FormState>();
      var changes = 0;
      _disposeAfterUnmount(tester, [values]);

      await _mount(
        tester,
        values,
        form,
        reads: transport.reads,
        onChanged: () {
          changes++;
        },
      );

      final original = values.customId.value;
      tester.widget<SsIconButton>(find.byType(SsIconButton)).onPressed!();
      values.customId.text = '99';
      values.customId.value = original;

      pending.complete(42);
      await tester.pumpAndSettle();

      expect(values.customId.value, original);
      expect(changes, 0);
      expect(transport.numberReads, 1);
      expect(transport.writes, 0);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('tool form validates exact numeric scalar byte and trim rules', (
    tester,
  ) async {
    final values = _values();
    final transport = _FormTransport();
    final form = GlobalKey<FormState>();
    _disposeAfterUnmount(tester, [values]);

    await _mount(tester, values, form, reads: transport.reads);

    values.customId.text = '1e2';
    values.brand.text = '\u0085';
    values.category.text = '\ufeff ';
    values.label.text = List.filled(64, '😀').join();
    values.purchasePrice.text = '1e2';
    values.usageCostPerDay.text = '-1';

    expect(form.currentState!.validate(), isFalse);
    await tester.pumpAndSettle();

    expect(values.draft().validate(), {
      'customId': ToolDraftIssue.positiveInteger,
      'brand': ToolDraftIssue.required,
      'category': ToolDraftIssue.required,
      'label': ToolDraftIssue.tooLong,
      'purchasePrice': ToolDraftIssue.nonnegativeNumber,
      'usageCostPerDay': ToolDraftIssue.nonnegativeNumber,
    });
    expect(find.text('Required field'), findsNWidgets(2));
    expect(
      find.text('Enter a whole number from 1 to 2147483647.'),
      findsOneWidget,
    );
    expect(find.text('Use at most 255 UTF-8 bytes.'), findsOneWidget);
    expect(
      find.text(
        'Enter zero or a positive number (comma or point for decimals).',
      ),
      findsNWidgets(2),
    );

    values.customId.text = '2147483647';
    values.brand.text = '\u0085 Brand \u0085';
    values.category.text = '\ufeffCategory';
    values.label.text = '${List.filled(63, '😀').join()}abc';
    values.purchasePrice.text = '0,5';
    values.usageCostPerDay.text = '0';

    expect(form.currentState!.validate(), isTrue);
    await tester.pumpAndSettle();

    final input = values.draft().createInput();

    expect(input.customId, 2147483647);
    expect(input.brand, 'Brand');
    expect(input.category, '\ufeffCategory');
    expect(input.label.value, values.label.text);
    expect(input.purchasePrice.value, 0.5);
    expect(input.usageCostPerDay.value, 0.0);
    expect(input.status.isAbsent, isTrue);

    values.brand.text = '\ud800';

    expect(form.currentState!.validate(), isFalse);
    await tester.pumpAndSettle();

    expect(find.text('Please check the entered characters.'), findsOneWidget);
    expect(transport.writes, 0);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'tool held callbacks reject revoked owner view and manage roles',
    (tester) async {
      for (final editing in [false, true]) {
        for (final revocation in [
          'active',
          'owner',
          'view:tools',
          'manage:tools',
        ]) {
          final values = editing
              ? ToolFormValues(ToolDraft.fromTool(_tool()))
              : _values();
          final transport = _FormTransport(toolId: editing ? 'tool' : null);
          final pendingNumber = Completer<Object?>();

          if (!editing) {
            transport.responses['tools.suggestNextCustomId'] =
                pendingNumber.future;
          }

          final form = GlobalKey<FormState>();
          var active = true;
          var changes = 0;
          _disposeAfterUnmount(tester, [values]);

          await _mount(
            tester,
            values,
            form,
            reads: transport.reads,
            isCurrent: () {
              return active;
            },
            onChanged: () {
              changes++;
            },
          );

          final number = editing
              ? null
              : tester.widget<SsIconButton>(find.byType(SsIconButton));
          final status = !editing
              ? null
              : tester.widget<SsSelectField<String>>(
                  find.byType(SsSelectField<String>),
                );
          final brand = _suggestion(tester, values.brand);
          final model = tester
              .widgetList<SsTextField>(find.byType(SsTextField))
              .firstWhere((field) {
                return identical(field.controller, values.label);
              });
          number?.onPressed?.call();

          if (revocation == 'active') {
            active = false;
          } else if (revocation == 'owner') {
            transport.current = false;
          } else {
            transport.permissions.remove(revocation);
          }

          if (!editing) {
            pendingNumber.complete(42);
            await tester.pumpAndSettle();
          }

          final requestsBeforeHeldCallbacks = transport.requests.length;
          number?.onPressed?.call();
          status?.onChanged?.call('broken');
          final options = await brand.loadSuggestions();
          brand.onChanged!('Retired');
          model.onChanged!('Retired');
          await tester.pumpAndSettle();

          expect(values.customId.text, editing ? '42' : '7');
          expect(values.status, editing ? models.ToolStatus.lost : null);
          expect(options, isEmpty);
          expect(changes, 0);
          expect(transport.requests, hasLength(requestsBeforeHeldCallbacks));
          expect(transport.numberReads, editing ? 0 : 1);
          expect(transport.writes, 0);
          expect(find.text('A number could not be suggested.'), findsNothing);
          expect(tester.takeException(), isNull);
        }
      }
    },
  );

  testWidgets(
    'tool replacement and disposal cannot redirect held form callbacks',
    (tester) async {
      final originalValues = _values();
      final replacementValues = _values(customId: '9');
      final originalTransport = _FormTransport();
      final replacementTransport = _FormTransport();
      final originalNumber = Completer<Object?>();
      final replacementNumber = Completer<Object?>();
      originalTransport.responses['tools.suggestNextCustomId'] =
          originalNumber.future;
      replacementTransport.responses['tools.suggestNextCustomId'] =
          replacementNumber.future;
      final form = GlobalKey<FormState>();
      var originalChanges = 0;
      var replacementChanges = 0;
      var valuesDisposed = false;

      addTearDown(() async {
        await tester.pumpWidget(const SizedBox.shrink());

        if (!valuesDisposed) {
          originalValues.dispose();
          replacementValues.dispose();
        }
      });

      await _mount(
        tester,
        originalValues,
        form,
        reads: originalTransport.reads,
        onChanged: () {
          originalChanges++;
        },
      );

      final oldNumber = tester.widget<SsIconButton>(find.byType(SsIconButton));
      final oldBrand = _suggestion(tester, originalValues.brand);
      oldNumber.onPressed!();

      // Keep the model and query identity to isolate reader-only replacement.
      await _mount(
        tester,
        originalValues,
        form,
        reads: replacementTransport.reads,
        onChanged: () {
          originalChanges++;
        },
      );

      oldNumber.onPressed!();
      expect(await oldBrand.loadSuggestions(), isEmpty);
      oldBrand.onChanged!('Retired reader');

      expect(originalTransport.numberReads, 1);
      expect(replacementTransport.numberReads, 0);
      expect(originalChanges, 0);

      final intermediateNumber = tester.widget<SsIconButton>(
        find.byType(SsIconButton),
      );
      final intermediateBrand = _suggestion(tester, originalValues.brand);

      await _mount(
        tester,
        replacementValues,
        form,
        reads: replacementTransport.reads,
        onChanged: () {
          replacementChanges++;
        },
      );

      intermediateNumber.onPressed!();
      expect(await intermediateBrand.loadSuggestions(), isEmpty);
      intermediateBrand.onChanged!('Retired values');

      expect(replacementTransport.numberReads, 0);
      expect(replacementChanges, 0);

      tester.widget<SsIconButton>(find.byType(SsIconButton)).onPressed!();
      originalNumber.complete(41);
      await tester.pumpAndSettle();

      expect(originalValues.customId.text, '7');
      expect(replacementValues.customId.text, '9');
      expect(
        tester.widget<SsIconButton>(find.byType(SsIconButton)).onPressed,
        isNull,
      );

      replacementNumber.complete(43);
      await tester.pumpAndSettle();

      expect(replacementValues.customId.text, '43');
      expect(originalChanges, 0);
      expect(replacementChanges, 1);

      final disposingNumber = Completer<Object?>();
      replacementTransport.responses['tools.suggestNextCustomId'] =
          disposingNumber.future;
      final currentNumber = tester.widget<SsIconButton>(
        find.byType(SsIconButton),
      );
      final currentBrand = _suggestion(tester, replacementValues.brand);
      currentNumber.onPressed!();

      await tester.pumpWidget(const SizedBox.shrink());
      originalValues.dispose();
      replacementValues.dispose();
      valuesDisposed = true;
      disposingNumber.complete(99);
      await tester.pumpAndSettle();

      currentNumber.onPressed!();
      expect(await currentBrand.loadSuggestions(), isEmpty);
      currentBrand.onChanged!('Disposed');
      oldNumber.onPressed!();

      expect(replacementTransport.numberReads, 2);
      expect(originalChanges, 0);
      expect(replacementChanges, 1);
      expect(originalTransport.writes + replacementTransport.writes, 0);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('tool mismatched targets and disabled fields perform no reads', (
    tester,
  ) async {
    for (final disabled in [false, true]) {
      final values = ToolFormValues(ToolDraft.fromTool(_tool()));
      final transport = _FormTransport(toolId: disabled ? 'tool' : 'other');
      final form = GlobalKey<FormState>();
      _disposeAfterUnmount(tester, [values]);

      await _mount(
        tester,
        values,
        form,
        reads: transport.reads,
        enabled: !disabled,
      );

      expect(transport.requests, isEmpty);
      expect(transport.writes, 0);
      expect(
        tester
            .widget<SsSelectField<String>>(find.byType(SsSelectField<String>))
            .onChanged,
        isNull,
      );
      expect(
        tester.widgetList<SsTextField>(find.byType(SsTextField)).every((field) {
          return !field.enabled;
        }),
        isTrue,
      );
      expect(_suggestion(tester, values.brand).enabled, isFalse);
      expect(_suggestion(tester, values.category).enabled, isFalse);
      expect(tester.takeException(), isNull);
    }
  });

  testWidgets(
    'tool brand and category wire uncapped matching and free raw input',
    (tester) async {
      final values = _values();
      final transport = _FormTransport();
      final brands = [for (var index = 0; index < 30; index++) 'Drill $index'];
      transport.responses['tools.brands'] = brands;
      transport.responses['tools.categories'] = <String>[
        ' Category ',
        'CATEGORY',
      ];
      final form = GlobalKey<FormState>();
      _disposeAfterUnmount(tester, [values]);

      await _mount(tester, values, form, reads: transport.reads);

      expect(
        _suggestion(tester, values.brand).matchSuggestions,
        same(matchToolSuggestions),
      );
      expect(
        _suggestion(tester, values.category).matchSuggestions,
        same(matchToolSuggestions),
      );

      await tester.enterText(_input(values.brand), '\ufeffDRILL ');
      await tester.pump(const Duration(milliseconds: 300));
      await tester.pumpAndSettle();

      for (var index = 0; index < 25; index++) {
        await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
        await tester.pump();
      }

      expect(find.text('Drill 25').hitTestable(), findsOneWidget);
      await tester.testTextInput.receiveAction(TextInputAction.done);
      await tester.pumpAndSettle();

      expect(values.brand.text, 'Drill 25');

      await tester.enterText(_input(values.category), 'category');
      await tester.pump(const Duration(milliseconds: 300));
      await tester.pumpAndSettle();
      await tester.tap(find.text('CATEGORY').hitTestable());
      await tester.pumpAndSettle();

      expect(values.category.text, 'CATEGORY');

      await tester.enterText(
        _input(values.brand),
        ' Independent custom brand ',
      );
      await tester.pump(const Duration(milliseconds: 300));
      await tester.testTextInput.receiveAction(TextInputAction.done);
      await tester.pumpAndSettle();

      expect(values.brand.text, ' Independent custom brand ');
      expect(form.currentState!.validate(), isTrue);
      expect(values.draft().createInput().brand, 'Independent custom brand');
      expect(transport.numberReads, 0);
      expect(transport.writes, 0);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'tool fields fit doubled German RTL at 320px in both themes and modes',
    (tester) async {
      for (final colors in [SsColors.light, SsColors.dark]) {
        for (final editing in [false, true]) {
          final values = editing
              ? ToolFormValues(ToolDraft.fromTool(_tool()))
              : _values();
          final transport = _FormTransport(toolId: editing ? 'tool' : null);
          final form = GlobalKey<FormState>();
          _disposeAfterUnmount(tester, [values]);

          await _mount(
            tester,
            values,
            form,
            reads: transport.reads,
            width: 320,
            scale: 2,
            german: true,
            rtl: true,
            colors: colors,
          );

          expect(_labels(tester), [
            editing ? 'Status' : 'Nummer',
            'Marke',
            'Kategorie',
            'Modell',
            'Kaufpreis (EUR)',
            'Nutzungskosten pro Tag (EUR)',
          ]);
          expect(form.currentState!.validate(), isTrue);

          await tester.ensureVisible(_input(values.usageCostPerDay));
          await tester.pumpAndSettle();
          await tester.enterText(_input(values.usageCostPerDay), '0,5');
          await tester.pumpAndSettle();

          expect(form.currentState!.validate(), isTrue);
          expect(values.draft().usageCostPerDay, '0,5');
          expect(transport.numberReads, 0);
          expect(transport.writes, 0);
          expect(tester.takeException(), isNull);
        }
      }
    },
  );
}

ToolFormValues _values({String customId = '7', String label = ''}) {
  return ToolFormValues(
    ToolDraft(
      customId: customId,
      brand: 'Brand',
      category: 'Category',
      label: label,
    ),
  );
}

models.Tool _tool() {
  return models.Tool(
    id: 'tool',
    customId: 42,
    brand: ' Brand ',
    category: ' Category ',
    label: ' Model ',
    purchasePrice: 5e-324,
    usageCostPerDay: 0,
    status: models.ToolStatus.lost,
    available: true,
    createdByUserId: 'actor',
    createdAt: DateTime.utc(2024),
    modifiedAt: DateTime.utc(2024, 2),
    archivedSince: DateTime.utc(2024, 3),
  );
}

Finder _input(TextEditingController controller) {
  return find.byWidgetPredicate((widget) {
    return widget is TextField && identical(widget.controller, controller);
  });
}

List<String?> _labels(WidgetTester tester) {
  final fields = tester.widgetList<SsFieldLabel>(find.byType(SsFieldLabel));

  return fields.map((field) {
    return field.label;
  }).toList();
}

SsSuggestionField _suggestion(
  WidgetTester tester,
  TextEditingController controller,
) {
  return tester.widget<SsSuggestionField>(
    find.byWidgetPredicate((widget) {
      return widget is SsSuggestionField &&
          identical(widget.controller, controller);
    }),
  );
}

void _disposeAfterUnmount(WidgetTester tester, List<ToolFormValues> values) {
  addTearDown(() async {
    await tester.pumpWidget(const SizedBox.shrink());

    for (final value in values) {
      value.dispose();
    }
  });
}

Future<void> _mount(
  WidgetTester tester,
  ToolFormValues values,
  GlobalKey<FormState> form, {
  required ToolFormReads reads,
  bool enabled = true,
  bool Function()? isCurrent,
  VoidCallback? onChanged,
  double width = 800,
  double scale = 1,
  bool german = false,
  bool rtl = false,
  SsColors colors = SsColors.light,
}) async {
  tester.view.physicalSize = Size(width, 800);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);

  await tester.pumpWidget(
    MaterialApp(
      locale: Locale(german ? 'de' : 'en'),
      supportedLocales: const [Locale('en'), Locale('de')],
      localizationsDelegates: GlobalMaterialLocalizations.delegates,
      home: SsTheme(
        colors: colors,
        child: MediaQuery(
          data: MediaQueryData(
            size: Size(width, 800),
            textScaler: TextScaler.linear(scale),
          ),
          child: Directionality(
            textDirection: rtl ? TextDirection.rtl : TextDirection.ltr,
            child: Scaffold(
              body: SingleChildScrollView(
                padding: const EdgeInsets.all(16),
                child: Form(
                  key: form,
                  child: ToolFormFields(
                    values: values,
                    queryIdentity: 'tool-form',
                    reads: reads,
                    enabled: enabled,
                    isCurrent: isCurrent,
                    onChanged: onChanged,
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

class _FormTransport {
  _FormTransport({this.toolId});

  final String? toolId;
  bool current = true;
  int writes = 0;
  final permissions = {'view:tools', 'manage:tools'};
  final requests = <(Object, Object?)>[];
  final failures = <String, Object>{};
  final responses = <String, Object?>{
    'tools.brands': <String>[],
    'tools.categories': <String>[],
    'tools.suggestNextCustomId': 42,
  };

  late final reads = ToolFormReads(
    access: ToolRpcAccess(
      scope: jsonEncode(['https://example.test', 'tenant', 'actor', toolId]),
      toolId: toolId,
      read: read,
      write: write,
      isCurrent: () {
        return current;
      },
      can: permissions.contains,
    ),
  );

  int get numberReads {
    return requests.where((request) {
      return identical(request.$1, ApiQueries.toolsSuggestNextCustomId);
    }).length;
  }

  Future<O> read<I, O>(RpcQuery<I, O> query, I input) async {
    requests.add((query, input));

    final failure = failures[query.path];

    if (failure != null) {
      throw failure;
    }

    final response = responses[query.path];

    if (response is Future<Object?>) {
      return await response as O;
    }

    return response as O;
  }

  Future<O> write<I, O>(RpcMutation<I, O> mutation, I input) async {
    writes++;

    throw StateError('UNEXPECTED_TOOL_FORM_WRITE');
  }
}
