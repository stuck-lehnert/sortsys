import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as api_models;
import 'package:sortsys_client/features/projects/project_list_screen.dart';
import 'package:sortsys_client/features/projects/project_list_state.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

api_models.Project project(String id, String title, {String? street}) {
  return api_models.Project(
    id: id,
    title: title,
    address: street == null
        ? null
        : api_models.ProjectAddress(streetAddress: street, city: 'Graz'),
    createdAt: DateTime.utc(2026),
    modifiedAt: DateTime.utc(2026),
  );
}

void main() {
  test('list defaults match Webapp active first page of25 without sorting', () {
    final state = ProjectListState.fromUri(Uri.parse('/projects'));

    expect(state.finished, isFalse);
    expect(state.page, 0);
    expect(state.pageSize, 25);
    expect(state.sortColumn, isNull);
  });

  test('canonical finished, pagination and sort URL protocol round trips', () {
    final uri = Uri(
      path: '/projects',
      queryParameters: {
        'finished': 'yes',
        'pageProjects': '2',
        'pageSizeProjects': '50',
        'sortProjects': jsonEncode([1, 'DESC']),
        'otherFilter': 'keep',
      },
    );
    final state = ProjectListState.fromUri(uri);

    expect(state.finished, isTrue);
    expect(state.page, 2);
    expect(state.pageSize, 50);
    expect(state.sortColumn, ProjectSortColumn.address);
    expect(state.descending, isTrue);
    expect(state.apply(uri).queryParameters, uri.queryParameters);
    expect(
      state.apply(uri, finished: false).queryParameters['finished'],
      isNull,
    );
    expect(state.apply(uri, page: 0).queryParameters['pageProjects'], isNull);
    expect(
      state.apply(uri, pageSize: 25).queryParameters['pageSizeProjects'],
      isNull,
    );
    expect(state.apply(uri, page: 1).queryParameters['otherFilter'], 'keep');
  });

  test('sort header cycles ascending descending and original server order', () {
    var uri = Uri.parse('/projects');

    for (final expected in ['ASC', 'DESC', null]) {
      final state = ProjectListState.fromUri(uri);
      uri = state.apply(uri, toggleColumn: ProjectSortColumn.title);
      final sorting = uri.queryParameters['sortProjects'];

      if (expected == null) {
        expect(sorting, isNull);
      } else {
        expect(jsonDecode(sorting!), [0, expected]);
      }
    }
  });

  test(
    'malformed URL state falls back without losing unrelated parameters',
    () {
      final uri = Uri.parse(
        '/projects?sortProjects=broken&pageProjects=-8&'
        'pageSizeProjects=200&finished=true&other=present',
      );
      final state = ProjectListState.fromUri(uri);

      expect(state.finished, isFalse);
      expect(state.page, 0);
      expect(state.pageSize, 25);
      expect(state.sortColumn, isNull);
      expect(state.apply(uri).queryParameters, {'other': 'present'});
    },
  );

  test('sorting is stable, immutable and keeps missing addresses last', () {
    final rows = [
      project('1', 'bravo', street: 'Beta'),
      project('2', 'Alpha'),
      project('3', 'alpha', street: 'Alpha'),
    ];
    final byTitle = sortedProjects(
      rows,
      const ProjectListState(sortColumn: ProjectSortColumn.title),
    );
    final byAddress = sortedProjects(
      rows,
      const ProjectListState(
        sortColumn: ProjectSortColumn.address,
        descending: true,
      ),
    );

    expect(
      byTitle.map((row) {
        return row.id;
      }),

      ['2', '3', '1'],
    );
    expect(
      byAddress.map((row) {
        return row.id;
      }),

      ['1', '3', '2'],
    );
    expect(rows.first.id, '1');
    expect(() {
      byTitle.add(rows.first);
    }, throwsUnsupportedError);
  });

  test('project address matches canonical street and zip-city display', () {
    const address = api_models.ProjectAddress(
      streetAddress: 'Harbor12',
      city: 'Graz',
    );

    expect(projectAddress(address), 'Harbor12, Graz');
    expect(projectAddress(null), '');
  });

  for (final scale in [1.0, 2.0]) {
    testWidgets('project pagination works at320px and scale$scale', (
      tester,
    ) async {
      tester.view.physicalSize = const Size(320, 900);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      Uri? next;
      final selections = <api_models.Project>[];
      final rows = List.generate(26, (index) {
        return project('$index', 'Project$index');
      });

      await tester.pumpWidget(
        MaterialApp(
          builder: (context, child) {
            return MediaQuery(
              data: MediaQuery.of(
                context,
              ).copyWith(textScaler: TextScaler.linear(scale)),
              child: SsTheme(colors: SsColors.light, child: child!),
            );
          },

          home: Scaffold(
            body: ProjectListRows(
              rows: rows,
              state: const ProjectListState(),
              uri: Uri.parse('/projects'),
              onStateChanged: (uri) {
                next = uri;
              },

              onSelected: selections.add,
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Rows 1–25 of 26'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.tap(find.text('Next'));
      await tester.pumpAndSettle();

      expect(next?.queryParameters['pageProjects'], '1');
      expect(tester.takeException(), isNull);
    });
  }

  testWidgets('clamped last page still selects the actual project', (
    tester,
  ) async {
    api_models.Project? selected;
    final stateChanges = <Uri>[];
    final rows = List.generate(26, (index) {
      return project('$index', 'Project$index');
    });

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: ProjectListRows(
            rows: rows,
            state: const ProjectListState(page: 99),
            uri: Uri.parse('/projects?pageProjects=99'),
            onStateChanged: stateChanges.add,
            onSelected: (row) {
              selected = row;
            },
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('Project25'));

    expect(selected?.id, '25');
    expect(find.text('Rows 26–26 of 26'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
