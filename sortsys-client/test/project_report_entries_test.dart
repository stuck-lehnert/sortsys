import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/features/entities/entity_presentation.dart';
import 'package:sortsys_client/features/projects/project_detail_tabs.dart';
import 'package:sortsys_client/features/projects/project_overview_screen.dart';
import 'package:sortsys_client/features/projects/project_regie_reports.dart';
import 'package:sortsys_client/navigation/router.dart';
import 'package:sortsys_client/state/session_controller.dart';
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

  testWidgets(
    'real project report route matches encoded IDs and retains URI state',
    (tester) async {
      final session = SessionController();
      addTearDown(session.dispose);
      final router = createRouter(session);
      addTearDown(router.dispose);
      final uri = Uri.parse(
        '/projects/project%2Fone/regieReports?pageRegieReports=2&keep=a&keep=b#reports',
      );

      final match = router.configuration.findMatch(uri);

      expect(match.error, isNull);
      expect(match.fullPath, '/projects/:id/regieReports');
      expect(match.pathParameters['id'], 'project/one');
      expect(match.uri, uri);
      expect(match.uri.queryParametersAll['keep'], ['a', 'b']);
      expect(match.uri.fragment, 'reports');
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'project report screen rejects the actual unauthenticated final session',
    (tester) async {
      final session = SessionController();
      addTearDown(session.dispose);

      await tester.pumpWidget(
        ChangeNotifierProvider.value(
          value: session,
          child: _app(
            child: const Scaffold(
              body: ProjectOverviewScreen(
                id: 'project/one',
                tab: ProjectDetailTab.regieReports,
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byType(EntityAccessDenied), findsOneWidget);
      expect(find.byType(ProjectRegieReports), findsNothing);
      expect(find.byType(SsTabs), findsNothing);
      expect(find.byType(SsSpinner), findsNothing);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'project header and report tabs navigate at320px doubled German RTL',
    (tester) async {
      final router = GoRouter(
        initialLocation: '/projects/project%2Fone',
        routes: [
          GoRoute(
            path: '/projects/:id',
            builder: (context, state) {
              return _layout(context, state, ProjectDetailTab.overview);
            },
          ),
          GoRoute(
            path: '/projects/:id/regieReports',
            builder: (context, state) {
              return _layout(context, state, ProjectDetailTab.regieReports);
            },
          ),
        ],
      );
      addTearDown(router.dispose);

      await tester.pumpWidget(_app(router: router, narrow: true));
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('Regieberichte'));
      await tester.tap(find.text('Regieberichte'));
      await tester.pumpAndSettle();

      expect(
        router.routeInformationProvider.value.uri.toString(),
        '/projects/project%2Fone/regieReports',
      );
      expect(find.text('Harbor'), findsOneWidget);
      expect(find.byType(SsInfoCallout), findsOneWidget);
      expect(find.byType(ProjectRegieReportRows), findsOneWidget);
      expect(find.text('Keine Einträge vorhanden.'), findsOneWidget);
      expect(find.text('Overview body'), findsNothing);
      expect(tester.getSize(find.byType(ProjectOverviewLayout)).width, 320);
      expect(tester.takeException(), isNull);

      await tester.ensureVisible(find.text('Übersicht'));
      await tester.tap(find.text('Übersicht'));
      await tester.pumpAndSettle();

      expect(
        router.routeInformationProvider.value.uri.toString(),
        '/projects/project%2Fone',
      );
      expect(find.text('Overview body'), findsOneWidget);
      expect(find.byType(ProjectRegieReportRows), findsNothing);
      expect(tester.takeException(), isNull);
    },
  );
}

Widget _layout(
  BuildContext context,
  GoRouterState state,
  ProjectDetailTab tab,
) {
  final day = DateTime(2024);
  final project = models.Project(
    id: state.pathParameters['id']!,
    title: 'Harbor',
    createdAt: day,
    modifiedAt: day,
    finishedAt: day,
  );

  return Scaffold(
    body: ProjectOverviewLayout(
      project: project,
      tabs: ProjectDetailTabs(
        id: project.id,
        tab: tab,
        canViewTools: true,
        canViewRegieReports: true,
      ),
      child: tab == ProjectDetailTab.overview
          ? const Text('Overview body')
          : ProjectRegieReportRows(
              rows: const [],
              state: ProjectReportPage.fromUri(state.uri),
              uri: state.uri,
              onStateChanged: (uri) {
                context.go(uri.toString());
              },
              onSelected: (report) {
                context.go('/regieReports/${Uri.encodeComponent(report.id)}');
              },
            ),
    ),
  );
}

Widget _app({Widget? child, GoRouter? router, bool narrow = false}) {
  Widget decorate(BuildContext context, Widget? content) {
    final width = narrow ? 320.0 : 800.0;
    final media = MediaQuery.of(context);

    return SsTheme(
      colors: SsColors.light,
      child: Align(
        alignment: Alignment.topLeft,
        child: SizedBox(
          width: width,
          height: 560,
          child: MediaQuery(
            data: media.copyWith(
              size: Size(width, 560),
              textScaler: TextScaler.linear(narrow ? 2 : 1),
            ),
            child: Directionality(
              textDirection: narrow ? TextDirection.rtl : TextDirection.ltr,
              child: content!,
            ),
          ),
        ),
      ),
    );
  }

  if (router != null) {
    return MaterialApp.router(
      locale: Locale(narrow ? 'de' : 'en'),
      supportedLocales: const [Locale('en'), Locale('de')],
      localizationsDelegates: GlobalMaterialLocalizations.delegates,
      routerConfig: router,
      builder: decorate,
    );
  }

  return MaterialApp(
    locale: const Locale('en'),
    supportedLocales: const [Locale('en'), Locale('de')],
    localizationsDelegates: GlobalMaterialLocalizations.delegates,
    home: child,
    builder: decorate,
  );
}
