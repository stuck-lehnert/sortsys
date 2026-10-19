import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/api/procedure.dart';
import 'package:sortsys_client/features/users/user_list_screen.dart';
import 'package:sortsys_client/features/users/user_list_state.dart';
import 'package:sortsys_client/features/users/user_read_repository.dart';
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
    'Users URL state validates first values and preserves unrelated repeats',
    () {
      final uri = Uri.parse(
        '/users?pageUsers=2&pageUsers=9&pageSizeUsers=50'
        '&sortUsers=%5B1,%22DESC%22%5D&archived=yes&x=a&x=b#section',
      );
      final state = UserListState.fromUri(uri);

      expect(state.page, 2);
      expect(state.pageSize, 50);
      expect(state.column, UserSortColumn.lastName);
      expect(state.descending, isTrue);
      expect(state.archivedOnly, isTrue);
      expect(state.input().toWire(), {'includeArchived': true});

      final next = state.apply(
        uri,
        page: 0,
        pageSize: 100,
        archivedOnly: false,
      );

      expect(next.queryParameters.containsKey('pageUsers'), isFalse);
      expect(next.queryParameters['pageSizeUsers'], '100');
      expect(next.queryParameters.containsKey('archived'), isFalse);
      expect(next.queryParametersAll['x'], ['a', 'b']);
      expect(next.fragment, 'section');

      for (final invalid in ['[3,"ASC"]', '[0,"desc"]', '{}', 'bad']) {
        final bad = UserListState.fromUri(
          Uri(
            path: '/users',
            queryParameters: {
              'sortUsers': invalid,
              'pageUsers': '-1',
              'pageSizeUsers': '26',
              'archived': 'true',
            },
          ),
        );

        expect(bad.column, isNull);
        expect(bad.page, 0);
        expect(bad.pageSize, 25);
        expect(bad.archivedOnly, isFalse);
        expect(bad.input().toWire(), isEmpty);
      }

      var sorting = Uri.parse('/users');

      for (final expected in ['[0,"ASC"]', '[0,"DESC"]', null]) {
        sorting = UserListState.fromUri(sorting)
            .apply(sorting, toggleColumn: UserSortColumn.firstName);

        expect(sorting.queryParameters['sortUsers'], expected);
      }
    },
  );

  test('user sorting is stable empty-last localized and archive-only without mutation', () {
    final users = [
      _user('z', 'Zed'),
      _user('blank', ''),
      _user('a', 'ada', contract: models.UserContractType.externalValue),
      _user('equal', 'Ada', archived: true),
    ];

    expect(
      sortedUsers(
        users,
        const UserListState(column: UserSortColumn.firstName),
        'en',
      ).map((user) => user.id),
      ['a', 'equal', 'z', 'blank'],
    );
    expect(
      sortedUsers(
        users,
        const UserListState(column: UserSortColumn.firstName, descending: true),
        'en',
      ).map((user) => user.id),
      ['z', 'a', 'equal', 'blank'],
    );
    expect(
      sortedUsers(
        users,
        const UserListState(archivedOnly: true),
        'en',
      ).map((user) => user.id),
      ['equal'],
    );
    expect(users.map((user) => user.id), ['z', 'blank', 'a', 'equal']);
    expect(userColumnText(users[2], UserSortColumn.contract, 'de'), 'Extern');
    expect(userColumnText(users[2], UserSortColumn.contract, 'en'), 'External');
    expect(
      userColumnText(
        _user('sub', 'Sub', contract: models.UserContractType.subcontractor),
        UserSortColumn.contract,
        'en',
      ),
      'SUB',
    );
    expect(userListName(_user('space', ' ', lastName: ' Name ')), '   Name ');
  });

  test(
    'user reads send actual active/archive inputs and return immutable rows',
    () async {
      final reads = _Reads()..response = [_user('a', 'Ada')];
      final repository = UserReadRepository(
        read: reads.read,
        isCurrent: () => true,
        canView: () => true,
      );

      final users = await repository.list(const UserListState());
      await repository.list(const UserListState(archivedOnly: true));

      expect(reads.requests.map((request) => request.$1), [
        'users.list',
        'users.list',
      ]);
      expect((reads.requests[0].$2 as models.UsersListInput).toWire(), isEmpty);
      expect((reads.requests[1].$2 as models.UsersListInput).toWire(), {
        'includeArchived': true,
      });
      expect(() => users.add(_user('b', 'Bob')), throwsUnsupportedError);
    },
  );

  test(
    'user reads reject changed session or permission before and after await',
    () async {
      for (final scope in [true, false]) {
        final reads = _Reads();
        var current = !scope;
        var allowed = scope;
        final repository = UserReadRepository(
          read: reads.read,
          isCurrent: () => current,
          canView: () => allowed,
        );

        await expectLater(
          repository.list(const UserListState()),
          throwsStateError,
        );
        expect(reads.requests, isEmpty);
        current = true;
        allowed = true;
        final pending = Completer<Object?>();
        reads.response = pending.future;

        final result = repository.list(const UserListState());

        if (scope) {
          current = false;
        } else {
          allowed = false;
        }

        pending.complete([_user('a', 'Ada')]);
        await expectLater(result, throwsStateError);
      }
    },
  );

  testWidgets(
    'user table has canonical columns selection sorting and top paging',
    (tester) async {
      final users = List.generate(
        30,
        (index) => _user('$index', 'Person $index'),
      );
      Uri? next;
      models.User? selected;
      await _pump(
        tester,
        UserListRows(
          rows: users,
          state: const UserListState(),
          uri: Uri.parse('/users?x=a&x=b#part'),
          onStateChanged: (uri) {
            next = uri;
          },
          onSelected: (user) {
            selected = user;
          },
        ),
      );

      expect(find.text('First name'), findsOneWidget);
      expect(find.text('Last name'), findsOneWidget);
      expect(find.text('Contract'), findsOneWidget);
      expect(
        tester.widget<SsDataTable<models.User>>(
          find.byType(SsDataTable<models.User>),
        ).rows,
        orderedEquals(users.take(25)),
      );
      expect(find.text('Internal'), findsWidgets);
      await tester.tap(find.text('Person 0'));

      expect(selected?.id, '0');
      await tester.tap(find.text('First name'));

      expect(next?.queryParameters['sortUsers'], '[0,"ASC"]');
      final paging = tester.widget<SsPagination>(find.byType(SsPagination));
      paging.onPage(2);

      expect(next?.queryParameters['pageUsers'], '1');
      paging.onPageSize(50);

      expect(next?.queryParameters.containsKey('pageUsers'), isFalse);
      expect(next?.queryParameters['pageSizeUsers'], '50');
      expect(next?.queryParametersAll['x'], ['a', 'b']);
      expect(next?.fragment, 'part');
      expect(
        tester.getTopLeft(find.byType(SsPagination)).dy,
        lessThan(tester.getTopLeft(find.byType(SsDataTable<models.User>)).dy),
      );
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'compact user cards keep genuine encoded links at 320px doubled Ubuntu',
    (tester) async {
      final users = [
        _user(' A&/B ', 'Ada', lastName: List.filled(12, 'Long').join(' ')),
        _user('last', 'Last', lastName: 'Person'),
      ];
      models.User? selected;
      await _pump(
        tester,
        UserListRows(
          rows: users,
          state: const UserListState(),
          uri: Uri.parse('/users'),
          onStateChanged: (uri) {},
          onSelected: (user) {
            selected = user;
          },
        ),
        width: 320,
        scale: 2,
      );

      expect(find.byType(SsDataTable<models.User>), findsNothing);
      final link = tester.widget<SsLink>(find.byType(SsLink).first);

      expect(link.uri.toString(), '/users/%20A%26%2FB%20');
      await tester.tap(find.text(userListName(users.first)));

      expect(selected?.id, ' A&/B ');
      await tester.scrollUntilVisible(
        find.text('Last Person'),
        180,
        scrollable: find.byType(Scrollable).last,
      );
      await tester.pumpAndSettle();

      expect(find.text('Last Person'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'archive toggle is genuine and archive-empty state is bilingual',
    (tester) async {
      var toggles = 0;
      await _pump(
        tester,
        UserArchiveToggle(
          archivedOnly: false,
          onPressed: () {
            toggles++;
          },
        ),
      );
      await tester.tap(find.text('Not archived'));

      expect(toggles, 1);
      await _pump(
        tester,
        UserArchiveToggle(
          archivedOnly: true,
          onPressed: () {
            toggles++;
          },
        ),
        locale: 'de',
      );
      await tester.tap(find.text('Archiviert'));

      expect(toggles, 2);

      for (final locale in ['de', 'en']) {
        await _pump(
          tester,
          UserListRows(
            rows: [_user('active', 'Active')],
            state: const UserListState(archivedOnly: true, page: 90),
            uri: Uri.parse('/users?archived=yes'),
            onStateChanged: (uri) {},
            onSelected: (user) {},
          ),
          locale: locale,
        );

        expect(
          find.text(
            locale == 'de'
                ? 'Keine Einträge vorhanden.'
                : 'No entries available.',
          ),
          findsOneWidget,
        );
        expect(find.byType(SsPagination), findsNothing);
        expect(tester.takeException(), isNull);
      }
    },
  );
}

models.User _user(
  String id,
  String firstName, {
  String? lastName,
  models.UserContractType contract = models.UserContractType.internal,
  bool archived = false,
}) {
  return models.User(
    id: id,
    firstName: firstName,
    lastName: lastName,
    username: id,
    contractType: contract,
    createdAt: DateTime.utc(2024),
    modifiedAt: DateTime.utc(2024),
    archivedAt: archived ? DateTime.utc(2025) : null,
  );
}

class _Reads {
  Object? response;
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

Future<void> _pump(
  WidgetTester tester,
  Widget child, {
  double width = 1400,
  double scale = 1,
  String locale = 'en',
}) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = Size(width, 1000);
  addTearDown(tester.view.resetDevicePixelRatio);
  addTearDown(tester.view.resetPhysicalSize);

  await tester.pumpWidget(
    MaterialApp(
      locale: Locale(locale),
      supportedLocales: const [Locale('de'), Locale('en')],
      localizationsDelegates: GlobalMaterialLocalizations.delegates,
      builder: (context, child) {
        return SsTheme(
          colors: SsColors.light,
          child: MediaQuery(
            data: MediaQuery.of(context)
                .copyWith(textScaler: TextScaler.linear(scale)),
            child: child!,
          ),
        );
      },
      home: Scaffold(body: child),
    ),
  );
  await tester.pumpAndSettle();
}
