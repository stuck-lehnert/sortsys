import 'package:go_router/go_router.dart';

import '../features/auth/login_screen.dart';
import '../features/customers/customer_list_screen.dart';
import '../features/entities/catalog.dart';
import '../features/entities/entity_screens.dart';
import '../features/entities/product_area_shell.dart';
import '../features/home/home_screen.dart';
import '../features/planning/planning_screen.dart';
import '../features/projects/project_list_screen.dart';
import '../features/projects/project_overview_screen.dart';
import '../state/session_controller.dart';
import '../ui/workspace_shell.dart';
import 'route_paths.dart';

GoRouter createRouter(SessionController session) {
  return GoRouter(
    refreshListenable: session,
    redirect: (context, state) {
      return _redirect(session, state);
    },

    routes: [
      GoRoute(
        path: '/login',
        builder: (context, state) {
          return const LoginScreen();
        },
      ),
      ShellRoute(
        builder: (context, state, child) {
          return WorkspaceShell(child: child);
        },

        routes: [
          GoRoute(
            path: '/',
            redirect: (context, state) {
              return state.uri.replace(path: '/dashboard').toString();
            },
          ),
          GoRoute(
            path: '/dashboard',
            builder: (context, state) {
              return const HomeScreen();
            },
          ),
          GoRoute(
            path: '/deployments',
            builder: (context, state) {
              return const PlanningScreen();
            },
          ),
          _legacyRoute('/planning'),
          _legacyRoute('/vendors'),
          _legacyRoute('/delivery-notes'),
          _legacyRoute('/regie-reports'),
          ShellRoute(
            builder: (context, state, child) {
              return ProductAreaShell(child: child);
            },

            routes: [
              _entityRoute(entitySpec('vendors')),
              _entityRoute(entitySpec('delivery-notes')),
              _entityRoute(entitySpec('products')),
            ],
          ),
          for (final spec in entityCatalog)
            if (!const {
              'products',
              'vendors',
              'delivery-notes',
            }.contains(spec.key))
              _entityRoute(spec),
        ],
      ),
    ],
  );
}

String? _redirect(SessionController session, GoRouterState state) {
  if (!session.authenticated && state.uri.path != '/login') {
    return Uri(
      path: '/login',
      queryParameters: {'next': state.uri.toString()},
    ).toString();
  }

  if (session.authenticated && state.uri.path == '/login') {
    final next = state.uri.queryParameters['next'];
    final uri = next == null ? null : Uri.tryParse(next);
    final internal =
        uri != null &&
        uri.scheme.isEmpty &&
        uri.authority.isEmpty &&
        uri.path.startsWith('/') &&
        uri.path != '/login';

    return internal ? uri.toString() : '/';
  }

  return null;
}

GoRoute _legacyRoute(String legacyPath) {
  return GoRoute(
    path: legacyPath,
    redirect: (context, state) {
      return canonicalClientUri(state.uri).toString();
    },

    routes: [
      GoRoute(
        path: ':id',
        redirect: (context, state) {
          return canonicalClientUri(state.uri).toString();
        },
      ),
    ],
  );
}

GoRoute _entityRoute(EntitySpec spec) {
  return GoRoute(
    path: spec.path,
    builder: (context, state) {
      if (spec.key == 'projects') {
        return const ProjectListScreen();
      }

      if (spec.key == 'customers') {
        return const CustomerListScreen();
      }

      return EntityListScreen(spec);
    },

    routes: [
      if (spec.get != null)
        GoRoute(
          path: ':id',
          builder: (context, state) {
            final id = state.pathParameters['id']!;

            if (spec.key == 'projects') {
              return ProjectOverviewScreen(id: id);
            }

            return EntityDetailScreen(spec, id);
          },
        ),
    ],
  );
}
