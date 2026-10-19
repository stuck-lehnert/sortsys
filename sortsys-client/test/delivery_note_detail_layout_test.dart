import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/features/delivery_notes/delivery_note_detail_layout.dart';
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

  testWidgets('delivery details keep canonical attributes zero costs and links', (
    tester,
  ) async {
    var opens = 0;
    final note = _note(comment: 'Original comment', author: 'author');

    await _pump(
      tester,
      DeliveryNoteDetailLayout(
        note: note,
        project: SsLink(
          uri: Uri.parse('/projects/%20A%26%2FB%20'),
          onPressed: () {
            opens++;
          },
          child: const Text('Project name'),
        ),
        author: SsLink(
          uri: Uri.parse('/users/author'),
          onPressed: () {
            opens++;
          },
          child: const Text('Ada'),
        ),
        costs: _costs(),
      ),
    );

    expect(tester.widget<SsPageHeader>(find.byType(SsPageHeader)).title,
        'Delivery note #0');
    expect(_labels(tester), ['Project', 'Comment', 'Created on', 'Created by', 'Costs']);
    expect(find.text('01/02/2024'), findsOneWidget);
    expect(find.text('03/04/2025'), findsNothing);
    expect(find.text('€0.00'), findsOneWidget);
    await tester.tap(find.text('Project name'));
    await tester.tap(find.text('Ada'));

    expect(opens, 2);
    expect(tester.takeException(), isNull);
  });

  testWidgets('delivery details preserve truthy comment and matching cost owner', (
    tester,
  ) async {
    await _pump(tester, DeliveryNoteDetailLayout(
      note: _note(comment: '', author: ''),
      project: const Text('Project'),
      author: const Text('HIDDEN AUTHOR'),
      costs: _costs(owner: 'wrong'),
    ));

    expect(_labels(tester), ['Project', 'Created on']);
    expect(find.text('HIDDEN AUTHOR'), findsNothing);
    await _pump(tester, DeliveryNoteDetailLayout(
      note: _note(comment: ' '),
      project: const Text('Projektname'),
      costs: _costs(),
    ), locale: 'de');

    expect(tester.widget<SsPageHeader>(find.byType(SsPageHeader)).title,
        'Lieferschein #0');
    expect(_labels(tester), ['Projekt', 'Kommentar', 'Erstellt am', 'Kosten']);
    expect(find.text('02.01.2024'), findsOneWidget);
    expect(find.text('0,00\u00a0€'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('delivery record sections require data and start expanded', (
    tester,
  ) async {
    await _pump(tester, DeliveryNoteDetailLayout(
      note: _note(),
      project: const Text('Project'),
      products: const Text('PRODUCT CONTENT'),
      specialItems: const Text('SPECIAL CONTENT'),
    ));

    expect(find.byType(SsDisclosure), findsNothing);
    await _pump(tester, DeliveryNoteDetailLayout(
      note: _note(records: true),
      project: const Text('Project'),
      products: const Text('PRODUCT CONTENT'),
      specialItems: const Text('SPECIAL CONTENT'),
    ));

    expect(find.byType(SsDisclosure), findsNWidgets(2));
    expect(find.text('PRODUCT CONTENT').hitTestable(), findsOneWidget);
    expect(find.text('SPECIAL CONTENT').hitTestable(), findsOneWidget);
    await tester.tap(find.text('Products'));
    await tester.pumpAndSettle();

    expect(find.text('PRODUCT CONTENT').hitTestable(), findsNothing);
    expect(find.text('SPECIAL CONTENT').hitTestable(), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('delivery detail sections scroll at 320px with doubled Ubuntu', (
    tester,
  ) async {
    await _pump(tester, DeliveryNoteDetailLayout(
      note: _note(records: true, comment: List.filled(12, 'Comment').join(' ')),
      project: const Text('Project name'),
      costs: _costs(),
      products: const SizedBox(height: 420, child: Text('PRODUCT CONTENT')),
      specialItems: const Text('FINAL SPECIAL CONTENT'),
    ), width: 320, scale: 2);

    await tester.scrollUntilVisible(find.text('FINAL SPECIAL CONTENT'), 200,
        scrollable: find.byType(Scrollable).first);
    await tester.pumpAndSettle();

    expect(tester.getBottomLeft(find.text('FINAL SPECIAL CONTENT')).dy,
        lessThanOrEqualTo(900));
    expect(tester.takeException(), isNull);
  });
}

List<String> _labels(WidgetTester tester) {
  return tester.widgetList<SsAttribute>(find.byType(SsAttribute)).map((field) {
    return field.label;
  }).toList();
}

models.DeliveryNote _note({String? comment, String? author, bool records = false}) {
  return models.DeliveryNote(
    id: 'note',
    autoId: 0,
    projectId: 'project',
    comment: comment,
    createdByUserId: author,
    createdAt: DateTime(2024, 1, 2),
    effectiveTimestamp: DateTime(2025, 3, 4),
    records: records ? const [models.DeliveryNoteRecordsItem(
      id: 'record', noteId: 'note', productId: 'product', quantity: 0, unit: 'kg',
    )] : const [],
    specialRecords: records ? const [models.DeliveryNoteSpecialRecordsItem(
      id: 'special', noteId: 'note', name: 'Special', unit: 'kg', amount: 0,
    )] : const [],
  );
}

models.DeliveryNotesCostsGetOutput _costs({String owner = 'note'}) {
  return models.DeliveryNotesCostsGetOutput(
    noteId: owner,
    totalCost: 0,
    records: const [],
    specialRecords: const [],
  );
}

Future<void> _pump(
  WidgetTester tester,
  Widget child, {
  double width = 1400,
  double scale = 1,
  String locale = 'en',
}) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = Size(width, 900);
  addTearDown(tester.view.resetDevicePixelRatio);
  addTearDown(tester.view.resetPhysicalSize);

  await tester.pumpWidget(MaterialApp(
    locale: Locale(locale),
    supportedLocales: const [Locale('de'), Locale('en')],
    localizationsDelegates: GlobalMaterialLocalizations.delegates,
    builder: (context, child) {
      return SsTheme(
        colors: SsColors.light,
        child: MediaQuery(
          data: MediaQuery.of(context).copyWith(textScaler: TextScaler.linear(scale)),
          child: child!,
        ),
      );
    },
    home: Scaffold(body: child),
  ));
  await tester.pumpAndSettle();
}
