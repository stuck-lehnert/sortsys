import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

import '../../api/generated/api.g.dart';
import '../../api/generated/models.g.dart' as models;
import '../../state/session_controller.dart';
import '../../ui/query_view.dart';
import '../../ui/text.dart';
import 'user_list_state.dart';
import 'user_read_repository.dart';

class UserListScreen extends StatelessWidget {
  const UserListScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final session = context.watch<SessionController>();
    final binding = session.binding;
    final uri = GoRouterState.of(context).uri;
    final state = UserListState.fromUri(uri);

    if (!session.authenticated || session.info?.can('view:users') != true) {
      return Center(
        child: Text(text(context, 'Keine Berechtigung', 'No permission')),
      );
    }

    return Title(
      title: text(context, 'Benutzer', 'Users'),
      color: SsTheme.of(context).text,
      child: Column(
        children: [
          SsPageHeader(
            title: text(context, 'Benutzer', 'Users'),
            actions: UserArchiveToggle(
              archivedOnly: state.archivedOnly,
              onPressed: () {
                context.go(
                  state
                      .apply(uri, archivedOnly: !state.archivedOnly)
                      .toString(),
                );
              },
            ),
          ),
          Expanded(
            child: QueryView<List<models.User>>(
              requestKey: ApiQueries.usersList.path,
              identity: [state.archivedOnly],
              load: (current) {
                return UserReadRepository(
                  read: current.read,
                  isCurrent: () {
                    return current.authenticated && current.binding == binding;
                  },
                  canView: () {
                    return current.info?.can('view:users') == true;
                  },
                ).list(state);
              },
              builder: (context, users, reload) {
                return UserListRows(
                  rows: users,
                  state: state,
                  uri: uri,
                  onStateChanged: (next) {
                    context.go(next.toString());
                  },
                  onSelected: (user) {
                    context.go('/users/${Uri.encodeComponent(user.id)}');
                  },
                );
              },
            ),
          ),
        ],
      ),
    );
  }
}

class UserArchiveToggle extends StatelessWidget {
  const UserArchiveToggle({
    super.key,
    required this.archivedOnly,
    required this.onPressed,
  });

  final bool archivedOnly;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    return SsOperationalTag(
      onPressed: onPressed,
      child: Text(
        archivedOnly
            ? text(context, 'Archiviert', 'Archived')
            : text(context, 'Nicht archiviert', 'Not archived'),
      ),
    );
  }
}

class UserListRows extends StatelessWidget {
  const UserListRows({
    super.key,
    required this.rows,
    required this.state,
    required this.uri,
    required this.onStateChanged,
    required this.onSelected,
  });

  final List<models.User> rows;
  final UserListState state;
  final Uri uri;
  final ValueChanged<Uri> onStateChanged;
  final ValueChanged<models.User> onSelected;

  String _label(BuildContext context, UserSortColumn column) {
    return switch (column) {
      UserSortColumn.firstName => text(context, 'Vorname', 'First name'),
      UserSortColumn.lastName => text(context, 'Nachname', 'Last name'),
      UserSortColumn.contract => text(context, 'Vertrag', 'Contract'),
    };
  }

  @override
  Widget build(BuildContext context) {
    final locale = Localizations.localeOf(context).languageCode;
    final sorted = sortedUsers(rows, state, locale);
    final lastPage = math.max(0, (sorted.length - 1) ~/ state.pageSize);
    final page = state.page.clamp(0, lastPage);
    final start = page * state.pageSize;
    final visible = sorted.sublist(
      start,
      math.min(start + state.pageSize, sorted.length),
    );
    final empty = Padding(
      padding: const EdgeInsets.all(14.4),
      child: Text(
        text(context, 'Keine Einträge vorhanden.', 'No entries available.'),
      ),
    );

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (sorted.isNotEmpty) ...[
          SsPagination(
            totalItems: sorted.length,
            page: page + 1,
            pageSize: state.pageSize,
            pageSizes: userPageSizes,
            itemsPerPageText: text(
              context,
              'Zeilen pro Seite',
              'Rows per page',
            ),
            backwardText: text(context, 'Zurück', 'Previous'),
            forwardText: text(context, 'Weiter', 'Next'),
            itemRangeText: (from, to, total) {
              return text(
                context,
                'Zeile $from–$to von $total',
                'Rows $from–$to of $total',
              );
            },
            pageRangeText: (current, total) {
              return text(
                context,
                'Seite $current von $total',
                'Page $current of $total',
              );
            },
            onPage: (next) {
              onStateChanged(state.apply(uri, page: next - 1));
            },
            onPageSize: (size) {
              onStateChanged(state.apply(uri, page: 0, pageSize: size));
            },
          ),
          const SizedBox(height: 8),
        ],
        Expanded(
          child: LayoutBuilder(
            builder: (context, constraints) {
              final scale = MediaQuery.textScalerOf(context).scale(14) / 14;

              if (MediaQuery.sizeOf(context).width >= 1000 && scale <= 1.4) {
                return SsDataTable<models.User>(
                  rows: visible,
                  empty: empty,
                  rowKey: (user) {
                    return user.id;
                  },
                  onSelected: onSelected,
                  columns: [
                    for (final column in UserSortColumn.values)
                      SsTableColumn(
                        label: _label(context, column),
                        header: SsTableSortHeader(
                          label: _label(context, column),
                          ascending: state.column == column
                              ? !state.descending
                              : null,
                          onPressed: () {
                            onStateChanged(
                              state.apply(uri, toggleColumn: column),
                            );
                          },
                        ),
                        cell: (user) {
                          return Text(userColumnText(user, column, locale));
                        },
                      ),
                  ],
                );
              }

              return ListView(
                padding: EdgeInsets.zero,
                children: [
                  if (visible.isEmpty) empty,
                  for (final user in visible)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 8),
                      child: SsSurface(
                        padding: const EdgeInsets.all(9.6),
                        child: SsLink(
                          uri: Uri.parse(
                            '/users/${Uri.encodeComponent(user.id)}',
                          ),
                          onPressed: () {
                            onSelected(user);
                          },
                          child: Text(userListName(user)),
                        ),
                      ),
                    ),
                ],
              );
            },
          ),
        ),
      ],
    );
  }
}
