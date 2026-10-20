import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

typedef _Contact = ({String id, String name});

const _existing = (id: 'existing', name: 'Ada');
const _created = (id: 'verified-id', name: 'Canonical name');

void main() {
  testWidgets(
    'multi picker appends only the genuine result and keeps selections',
    (tester) async {
      final pending = Completer<_Contact?>();
      final selected = <List<_Contact>>[];
      final queries = <String>[];

      await _pump(
        tester,
        selected,
        create: (query) {
          queries.add(query);

          return pending.future;
        },
      );
      await _query(tester, ' New contact ');
      await tester.tap(find.text('Create contact: New contact'));
      await tester.pump();

      expect(queries, ['New contact']);
      expect(selected, isEmpty);
      expect(find.text('Ada'), findsOneWidget);

      pending.complete(_created);
      await tester.pumpAndSettle();

      expect(selected.single, [_existing, _created]);
      expect(find.text('Canonical name'), findsOneWidget);
      expect(
        tester.widget<TextField>(find.byType(TextField)).controller!.text,
        isEmpty,
      );
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'multi picker suppresses creation for an already selected exact name',
    (tester) async {
      final selected = <List<_Contact>>[];
      var calls = 0;

      await _pump(
        tester,
        selected,
        create: (query) async {
          calls++;

          return _created;
        },
      );
      await _query(tester, ' aDa ');

      expect(find.textContaining('Create contact:'), findsNothing);
      expect(find.text('Ada'), findsOneWidget);
      expect(selected, isEmpty);
      expect(calls, 0);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'multi picker restores cancellation and rejects a revoked pending result',
    (tester) async {
      final selected = <List<_Contact>>[];
      final pending = Completer<_Contact?>();

      await _pump(
        tester,
        selected,
        create: (query) async {
          return null;
        },
      );
      await _query(tester, 'Cancelled');
      await tester.tap(find.text('Create contact: Cancelled'));
      await tester.pumpAndSettle();

      expect(selected, isEmpty);
      expect(
        tester.widget<TextField>(find.byType(TextField)).controller!.text,
        'Cancelled',
      );
      expect(find.text('Ada'), findsOneWidget);

      await _pump(
        tester,
        selected,
        create: (query) {
          return pending.future;
        },
      );
      await _query(tester, 'Pending');
      await tester.tap(find.text('Create contact: Pending'));
      await tester.pump();
      await _pump(tester, selected);

      pending.complete(_created);
      await tester.pumpAndSettle();

      expect(selected, isEmpty);
      expect(find.text('Canonical name'), findsNothing);
      expect(find.text('Ada'), findsOneWidget);
      expect(
        tester.widget<TextField>(find.byType(TextField)).controller!.text,
        'Pending',
      );
      expect(tester.takeException(), isNull);
    },
  );
}

Future<void> _query(WidgetTester tester, String query) async {
  await tester.enterText(find.byType(TextField), query);
  await tester.pump(const Duration(milliseconds: 300));
  await tester.pumpAndSettle();
}

Future<void> _pump(
  WidgetTester tester,
  List<List<_Contact>> selected, {
  Future<_Contact?> Function(String)? create,
}) async {
  await tester.pumpWidget(
    MaterialApp(
      home: SsTheme(
        colors: SsColors.light,
        child: Scaffold(
          body: Padding(
            padding: const EdgeInsets.all(24),
            child: Form(
              child: SsMultiAutocompleteField<_Contact>(
                label: 'Contacts',
                queryIdentity: 'actor',
                initialValue: const [_existing],
                loadOptions: (query) async {
                  return [_existing];
                },
                displayString: (contact) {
                  return contact.name;
                },
                optionKey: (contact) {
                  return contact.id;
                },
                onChanged: selected.add,
                onCreate: create,
                createLabel: (query) {
                  return 'Create contact: $query';
                },
              ),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}
