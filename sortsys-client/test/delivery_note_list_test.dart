import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/api/procedure.dart';
import 'package:sortsys_client/features/delivery_notes/delivery_note_list_screen.dart';
import 'package:sortsys_client/features/delivery_notes/delivery_note_list_state.dart';
import 'package:sortsys_client/features/delivery_notes/delivery_note_read_repository.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

void main() {
  setUpAll(() async {
    final fonts = FontLoader('packages/sortsys_ui/Ubuntu');

    for (final weight in ['Regular', 'Medium', 'Bold']) {
      fonts.addFont(rootBundle.load(
        'packages/sortsys_ui/assets/fonts/ubuntu/Ubuntu-$weight.ttf',
      ));
    }

    await fonts.load();
  });

  test('DeliveryNotes URL state validates first values and preserves repeats', () {
    final uri = Uri.parse('/products/deliveryNotes?pageDeliveryNotes=2'
        '&pageDeliveryNotes=8&pageSizeDeliveryNotes=50'
        '&sortDeliveryNotes=%5B2,%22DESC%22%5D&x=a&x=b#part');
    final state = DeliveryNoteListState.fromUri(uri);

    expect(state.page, 2);
    expect(state.pageSize, 50);
    expect(state.column, DeliveryNoteSortColumn.effective);
    expect(state.descending, isTrue);

    final next = state.apply(uri, page: 0, pageSize: 100);

    expect(next.queryParameters.containsKey('pageDeliveryNotes'), isFalse);
    expect(next.queryParameters['pageSizeDeliveryNotes'], '100');
    expect(next.queryParametersAll['x'], ['a', 'b']);
    expect(next.fragment, 'part');

    for (final invalid in ['[4,"ASC"]', '[0,"asc"]', '{}', 'bad']) {
      final bad = DeliveryNoteListState.fromUri(Uri(
        path: '/products/deliveryNotes',
        queryParameters: {
          'sortDeliveryNotes': invalid,
          'pageDeliveryNotes': '-1',
          'pageSizeDeliveryNotes': '26',
        },
      ));

      expect(bad.column, isNull);
      expect(bad.page, 0);
      expect(bad.pageSize, 25);
    }

    var sorting = Uri.parse('/products/deliveryNotes');

    for (final expected in ['[0,"ASC"]', '[0,"DESC"]', null]) {
      sorting = DeliveryNoteListState.fromUri(sorting).apply(
        sorting,
        toggleColumn: DeliveryNoteSortColumn.number,
      );

      expect(sorting.queryParameters['sortDeliveryNotes'], expected);
    }
  });

  test('delivery note sorts use numeric IDs dates and stable empty-last comments', () {
    final notes = [
      _note('ten', 10, comment: 'Zed', day: 1),
      _note('empty', 1, day: 4),
      _note('two', 2, comment: 'ada', day: 3),
      _note('equal', 2, comment: 'Ada', day: 2),
    ];

    expect(_ids(sortedDeliveryNotes(notes, const DeliveryNoteListState(
      column: DeliveryNoteSortColumn.number,
    ))), ['empty', 'two', 'equal', 'ten']);
    expect(_ids(sortedDeliveryNotes(notes, const DeliveryNoteListState(
      column: DeliveryNoteSortColumn.comment, descending: true,
    ))), ['ten', 'two', 'equal', 'empty']);

    for (final column in [DeliveryNoteSortColumn.created, DeliveryNoteSortColumn.effective]) {
      expect(_ids(sortedDeliveryNotes(notes, DeliveryNoteListState(column: column))),
          ['ten', 'equal', 'two', 'empty']);
    }

    expect(_ids(notes), ['ten', 'empty', 'two', 'equal']);
    expect(deliveryNoteNumber(_note('float', 10.0)), '10');
  });

  test('delivery note reads use empty input and reject stale scope or permission', () async {
    final reads = _Reads()..response = [_note('one', 1)];
    final repository = _repository(reads);

    final notes = await repository.list();

    expect(reads.requests.single.$1, 'deliveryNotes.list');
    expect((reads.requests.single.$2 as models.DeliveryNotesListInput).toWire(), isEmpty);
    expect(() => notes.add(_note('two', 2)), throwsUnsupportedError);

    for (final scope in [true, false]) {
      final blocked = _Reads();
      blocked.current = !scope;
      blocked.allowed = scope;

      await expectLater(_repository(blocked).list(), throwsStateError);
      expect(blocked.requests, isEmpty);

      blocked.current = true;
      blocked.allowed = true;
      final pending = Completer<Object?>();
      blocked.response = pending.future;

      final result = _repository(blocked).list();

      if (scope) {
        blocked.current = false;
      } else {
        blocked.allowed = false;
      }

      pending.complete([_note('one', 1)]);
      await expectLater(result, throwsStateError);
    }
  });

  testWidgets('delivery note table has four columns links sort and top paging', (tester) async {
    final notes = List.generate(30, (index) {
      return _note('$index', index + 1);
    });
    Uri? next;
    models.DeliveryNote? selected;

    await _pump(tester, DeliveryNoteListRows(
      rows: notes,
      state: const DeliveryNoteListState(),
      uri: Uri.parse('/products/deliveryNotes?x=a&x=b#part'),
      onStateChanged: (uri) {
        next = uri;
      },
      onSelected: (note) {
        selected = note;
      },
    ));

    final table = tester.widget<SsDataTable<models.DeliveryNote>>(
      find.byType(SsDataTable<models.DeliveryNote>),
    );
    final paging = tester.widget<SsPagination>(find.byType(SsPagination));

    expect(table.columns.map((column) {
      return column.label;
    }), ['Number', 'Recorded on', 'Effective on', 'Comment']);
    expect(table.rows, orderedEquals(notes.take(25)));
    await tester.tap(find.text('#1'));

    expect(selected?.id, '0');
    await tester.tap(find.text('Comment'));

    expect(next?.queryParameters['sortDeliveryNotes'], '[3,"ASC"]');
    paging.onPage(2);

    expect(next?.queryParameters['pageDeliveryNotes'], '1');
    expect(tester.getTopLeft(find.byType(SsPagination)).dy,
        lessThan(tester.getTopLeft(find.byType(SsDataTable<models.DeliveryNote>)).dy));
    expect(tester.takeException(), isNull);
  });

  testWidgets('delivery note page clamps and page-size changes reset URL state', (tester) async {
    final notes = List.generate(30, (index) {
      return _note('$index', index + 1);
    });
    Uri? next;

    await _pump(tester, DeliveryNoteListRows(
      rows: notes,
      state: const DeliveryNoteListState(page: 99),
      uri: Uri.parse('/products/deliveryNotes?pageDeliveryNotes=99&x=a&x=b#part'),
      onStateChanged: (uri) {
        next = uri;
      },
      onSelected: (note) {},
    ));

    final table = tester.widget<SsDataTable<models.DeliveryNote>>(
      find.byType(SsDataTable<models.DeliveryNote>),
    );
    final paging = tester.widget<SsPagination>(find.byType(SsPagination));

    expect(table.rows, orderedEquals(notes.skip(25)));
    expect(paging.page, 2);
    paging.onPageSize(50);

    expect(next?.queryParameters.containsKey('pageDeliveryNotes'), isFalse);
    expect(next?.queryParameters['pageSizeDeliveryNotes'], '50');
    expect(next?.queryParametersAll['x'], ['a', 'b']);
    expect(next?.fragment, 'part');
    expect(tester.takeException(), isNull);
  });

  testWidgets('compact delivery notes keep encoded links at 320px doubled Ubuntu', (tester) async {
    final notes = List.generate(12, (index) {
      return _note(index == 0 ? ' A&/B ' : '$index', index + 1, comment: 'HIDDEN');
    });
    models.DeliveryNote? selected;

    await _pump(tester, DeliveryNoteListRows(
      rows: notes,
      state: const DeliveryNoteListState(),
      uri: Uri.parse('/products/deliveryNotes'),
      onStateChanged: (uri) {},
      onSelected: (note) {
        selected = note;
      },
    ), width: 320, scale: 2);

    final link = tester.widget<SsLink>(find.byType(SsLink).first);

    expect(link.uri.toString(), '/products/deliveryNotes/%20A%26%2FB%20');
    expect(find.text('HIDDEN'), findsNothing);
    expect(find.text('03/02/2025'), findsNothing);
    expect(find.text('01/02/2024'), findsWidgets);
    await tester.tap(find.text('Delivery note #1'));

    expect(selected?.id, ' A&/B ');
    await tester.scrollUntilVisible(find.text('Delivery note #12'), 180,
        scrollable: find.byType(Scrollable).last);
    await tester.pumpAndSettle();

    expect(find.text('Delivery note #12'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('empty delivery note tables retain bilingual canonical headers', (tester) async {
    for (final locale in ['de', 'en']) {
      await _pump(tester, DeliveryNoteListRows(
        rows: const [],
        state: const DeliveryNoteListState(),
        uri: Uri.parse('/products/deliveryNotes'),
        onStateChanged: (uri) {},
        onSelected: (note) {},
      ), locale: locale);

      expect(find.text(locale == 'de' ? 'Erfasst am' : 'Recorded on'), findsOneWidget);
      expect(find.text(locale == 'de' ? 'Keine Einträge vorhanden.' : 'No entries available.'),
          findsOneWidget);
      expect(find.byType(SsPagination), findsNothing);
      expect(tester.takeException(), isNull);
    }
  });
}

List<String> _ids(List<models.DeliveryNote> notes) {
  return notes.map((note) {
    return note.id;
  }).toList();
}

models.DeliveryNote _note(String id, num number, {String? comment, int day = 2}) {
  return models.DeliveryNote(
    id: id,
    autoId: number,
    projectId: 'project',
    comment: comment,
    createdAt: DateTime(2024, 1, day),
    effectiveTimestamp: DateTime(2025, 3, day),
    records: const [],
    specialRecords: const [],
  );
}

DeliveryNoteReadRepository _repository(_Reads reads) {
  return DeliveryNoteReadRepository(
    read: reads.read,
    isCurrent: () {
      return reads.current;
    },
    canView: () {
      return reads.allowed;
    },
  );
}

class _Reads {
  Object? response;
  bool current = true;
  bool allowed = true;
  final requests = <(String, Object?)>[];

  Future<O> read<I, O>(RpcQuery<I, O> query, I input) async {
    requests.add((query.path, input));

    final value = response;

    if (value is Future<Object?>) {
      return await value as O;
    }

    return value as O;
  }
}

Future<void> _pump(WidgetTester tester, Widget child, {
  double width = 1400,
  double scale = 1,
  String locale = 'en',
}) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = Size(width, 1000);
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
