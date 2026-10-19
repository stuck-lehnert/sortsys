import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/features/projects/project_detail_tabs.dart';
import 'package:sortsys_client/features/projects/project_overview_screen.dart';
import 'package:sortsys_client/features/projects/project_regie_reports.dart';
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

  test('project report query uses only the canonical project filter', () {
    expect(projectRegieReportsInput('project/one').toWire(), {
      'projectId': 'project/one',
    });
  });

  test('report pagination preserves repeated values fragments and unused sorting', () {
    final uri = Uri(
      path: '/projects/one/regieReports',
      queryParameters: {
        'pageRegieReports': ['2'],
        'pageSizeRegieReports': ['50'],
        'sortRegieReports': ['untouched'],
        'keep': ['a', 'b'],
      },
      fragment: 'report',
    );
    final state = ProjectReportPage.fromUri(uri);
    final changed = state.apply(uri, page: 0, pageSize: 100);

    expect(state.page, 2);
    expect(state.pageSize, 50);
    expect(changed.queryParameters['pageRegieReports'], isNull);
    expect(changed.queryParameters['pageSizeRegieReports'], '100');
    expect(changed.queryParameters['sortRegieReports'], 'untouched');
    expect(changed.queryParametersAll['keep'], ['a', 'b']);
    expect(changed.fragment, 'report');
    final malformed = ProjectReportPage.fromUri(Uri.parse(
      '/projects/one/regieReports?pageRegieReports=-8&pageSizeRegieReports=7',
    ));
    expect(malformed.page, 0);
    expect(malformed.pageSize, 25);
  });

  test('canonical local civil ISO week handles year boundary and Sunday', () {
    final january = projectReportWeek(DateTime(2021, 1, 1, 12));
    expect(january.year, 2020);
    expect(january.number, 53);
    expect(january.start, DateTime(2020, 12, 28));
    expect(january.end, DateTime(2021, 1, 3));
    final sunday = projectReportWeek(DateTime(2026, 3, 29, 12));
    expect(sunday.start, DateTime(2026, 3, 23));
    expect(sunday.end, DateTime(2026, 3, 29));
    expect(sunday.number, 13);
    expect(sunday.start.hour, 0);
    expect(sunday.end.hour, 0);
  });

  testWidgets('canonical report card omits project and exposes real detail URI', (
    tester,
  ) async {
    String? selected;
    await _pump(tester, ProjectRegieReportCard(
      report: _report('report/7', summary: 'Actual summary'),
      onSelected: (report) {
        selected = report.id;
      },
    ));

    expect(find.text('Time-and-material report #7'), findsOneWidget);
    expect(find.text('KW 53/2020'), findsOneWidget);
    expect(find.text('12/28/2020 to 01/03/2021'), findsOneWidget);
    expect(find.text('Actual summary'), findsOneWidget);
    expect(find.text('0 entries'), findsNWidgets(2));
    expect(find.text('Project'), findsNothing);
    final link = tester.widget<SsLink>(find.byType(SsLink));
    expect(link.uri.toString(), '/regieReports/report%2F7');
    await tester.tap(find.text('Time-and-material report #7'));
    expect(selected, 'report/7');
    expect(tester.takeException(), isNull);
  });

  testWidgets('top report pagination uses real first-page reset callback', (
    tester,
  ) async {
    final uri = Uri.parse('/projects/one/regieReports?pageRegieReports=2&keep=a&keep=b#report');
    Uri? changed;
    await _pump(tester, ProjectRegieReportRows(
      rows: [for (var index = 0; index < 70; index++) _report('$index')],
      state: ProjectReportPage.fromUri(uri),
      uri: uri,
      onStateChanged: (next) {
        changed = next;
      },
      onSelected: (report) {},
    ));
    final pagination = tester.widget<SsPagination>(find.byType(SsPagination));
    expect(pagination.page, 3);
    expect(find.byType(ProjectRegieReportCard), findsNWidgets(20));
    expect(tester.getTopLeft(find.byType(SsPagination)).dy,
        lessThan(tester.getTopLeft(find.byType(ProjectRegieReportCard).first).dy));
    pagination.onPageSize(50);
    expect(changed!.queryParameters['pageRegieReports'], isNull);
    expect(changed!.queryParameters['pageSizeRegieReports'], '50');
    expect(changed!.queryParametersAll['keep'], ['a', 'b']);
    expect(changed!.fragment, 'report');
    expect(tester.takeException(), isNull);
  });

  testWidgets('report states hide stale cards and retry invokes real callback', (
    tester,
  ) async {
    var retries = 0;
    final uri = Uri.parse('/projects/one/regieReports');

    Widget content({bool loading = false, Object? error}) {
      return ProjectRegieReportRows(
        rows: [_report('stale')],
        state: const ProjectReportPage(),
        uri: uri,
        loading: loading,
        error: error,
        onRetry: () {
          retries++;
        },
        onStateChanged: (next) {},
        onSelected: (report) {},
      );
    }

    await _pump(tester, content(loading: true));
    expect(find.byType(SsSpinner), findsOneWidget);
    expect(find.byType(ProjectRegieReportCard), findsNothing);
    expect(find.byType(SsPagination), findsNothing);

    await _pump(tester, content(error: StateError('unavailable')));
    expect(find.byType(ProjectRegieReportCard), findsNothing);
    expect(find.text('Entries could not be loaded.'), findsOneWidget);
    await tester.tap(find.text('Reload'));
    expect(retries, 1);
    expect(tester.takeException(), isNull);
  });

  testWidgets('project tab visibility follows canonical resource permissions', (
    tester,
  ) async {
    await _pump(tester, const ProjectDetailTabs(
      id: 'one',
      tab: ProjectDetailTab.overview,
      canViewTools: true,
      canViewRegieReports: false,
    ));
    expect(find.text('Overview'), findsOneWidget);
    expect(find.text('Time-and-material reports'), findsNothing);

    await _pump(tester, const ProjectDetailTabs(
      id: 'one',
      tab: ProjectDetailTab.regieReports,
      canViewTools: false,
      canViewRegieReports: true,
    ));
    expect(find.text('Overview'), findsNothing);
    expect(find.text('Time-and-material reports'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('actual project layout scrolls report attributes at 320px scale2', (
    tester,
  ) async {
    await _pump(tester, ProjectRegieReportCard(
      report: _report('one', summary: 'Actual project report summary'),
      onSelected: (report) {},
    ), width: 320, scale: 2);
    expect(tester.takeException(), isNull);
    await tester.scrollUntilVisible(find.text('0 entries').last, 200,
        scrollable: find.byType(Scrollable).first);
    await tester.pumpAndSettle();
    expect(tester.getRect(find.text('0 entries').last).bottom, lessThanOrEqualTo(800));
    expect(tester.takeException(), isNull);
  });

  testWidgets('project tabs navigate to implemented encoded routes only', (
    tester,
  ) async {
    Widget screen(ProjectDetailTab tab) {
      return Scaffold(body: SsTheme(colors: SsColors.light,
        child: ProjectDetailTabs(
          id: 'project/one', tab: tab,
          canViewTools: true, canViewRegieReports: true,
        ),
      ));
    }

    final router = GoRouter(
      initialLocation: '/projects/project%2Fone',
      routes: [
        GoRoute(path: '/projects/:id', builder: (context, state) {
          return screen(ProjectDetailTab.overview);
        }),
        GoRoute(path: '/projects/:id/regieReports', builder: (context, state) {
          return screen(ProjectDetailTab.regieReports);
        }),
      ],
    );
    addTearDown(router.dispose);
    await tester.pumpWidget(MaterialApp.router(
      locale: const Locale('en'), routerConfig: router,
    ));
    await tester.pumpAndSettle();
    expect(find.text('Overview'), findsOneWidget);
    expect(find.text('Time-and-material reports'), findsOneWidget);
    expect(find.text('Files'), findsNothing);
    await tester.tap(find.text('Time-and-material reports'));
    await tester.pumpAndSettle();
    expect(router.routeInformationProvider.value.uri.toString(),
        '/projects/project%2Fone/regieReports');
    await tester.tap(find.text('Overview'));
    await tester.pumpAndSettle();
    expect(router.routeInformationProvider.value.uri.toString(),
        '/projects/project%2Fone');
    expect(tester.takeException(), isNull);
  });
}

models.RegieReport _report(String id, {String? summary}) {
  return models.RegieReport(
    id: id, projectId: 'one', day: DateTime(2021, 1, 1, 12),
    summary: summary, createdByUserId: 'user-1',
    createdAt: DateTime.utc(2021, 1, 1), autoId: 7,
    products: const [], specialRecords: const [], workHours: const [],
  );
}

Future<void> _pump(WidgetTester tester, Widget content, {
  double width = 1500, double scale = 1,
}) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = Size(width, 800);
  addTearDown(tester.view.resetDevicePixelRatio);
  addTearDown(tester.view.resetPhysicalSize);

  await tester.pumpWidget(MaterialApp(
    locale: const Locale('en'),
    builder: (context, child) {
      return SsTheme(colors: SsColors.light, child: MediaQuery(
        data: MediaQuery.of(context).copyWith(textScaler: TextScaler.linear(scale)),
        child: child!,
      ));
    },
    home: Scaffold(body: ProjectOverviewLayout(
      project: models.Project(id: 'one', title: 'Harbor',
        createdAt: DateTime.utc(2021, 1, 1), modifiedAt: DateTime.utc(2021, 1, 1)),
      child: content,
    )),
  ));
  await tester.pump();
}
