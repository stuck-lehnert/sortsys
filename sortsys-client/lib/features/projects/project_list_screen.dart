import 'dart:math' as math;

import 'package:flutter/widgets.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

import '../../api/generated/api.g.dart';
import '../../api/generated/models.g.dart' as api_models;
import '../../api/model.dart';
import '../../state/session_controller.dart';
import '../../ui/text.dart';
import 'project_list_state.dart';

class ProjectListScreen extends HookWidget {
  const ProjectListScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final session = context.watch<SessionController>();
    final uri = GoRouterState.of(context).uri;
    final state = ProjectListState.fromUri(uri);
    final revision = useState(0);
    final allowed = session.info?.can('view:projects') == true;
    final future = useMemoized(() {
      if (!allowed) {
        return null;
      }

      final input = api_models.ProjectsListInput(
        finished: RpcOptional.value(state.finished),
      );

      return session.read(ApiQueries.projectsList, input);
    }, [session.binding, allowed, state.finished, revision.value]);

    final snapshot = useFuture(future, preserveState: false);

    if (!allowed) {
      return Center(
        child: Text(text(context, 'Keine Berechtigung', 'No permission')),
      );
    }

    Widget body;

    if (snapshot.connectionState != ConnectionState.done) {
      body = const Center(child: SsSpinner());
    } else if (snapshot.hasError) {
      body = Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(errorText(context, snapshot.error)),
            const SizedBox(height: 8),
            SsButton(
              kind: SsButtonKind.secondary,
              onPressed: () {
                revision.value += 1;
              },

              child: Text(text(context, 'Aktualisieren', 'Refresh')),
            ),
          ],
        ),
      );
    } else {
      body = ProjectListRows(
        rows: snapshot.requireData,
        state: state,
        uri: uri,
        shrinkWrap: true,
        onStateChanged: (next) {
          context.go(next.toString());
        },

        onSelected: (project) {
          context.go('/projects/${Uri.encodeComponent(project.id)}');
        },
      );
    }

    return CustomScrollView(
      slivers: [
        SliverToBoxAdapter(
          child: SsPageHeader(
            title: text(context, 'Projekte', 'Projects'),
            actions: SsButton(
              kind: SsButtonKind.secondary,
              onPressed: () {
                context.go(
                  state.apply(uri, finished: !state.finished).toString(),
                );
              },

              child: Text(
                state.finished
                    ? text(context, 'Abgeschlossen', 'Completed')
                    : text(context, 'Aktiv', 'Active'),
              ),
            ),
          ),
        ),
        const SliverToBoxAdapter(child: SizedBox(height: 8)),
        if (snapshot.connectionState == ConnectionState.done &&
            !snapshot.hasError)
          SliverToBoxAdapter(child: body)
        else
          SliverFillRemaining(hasScrollBody: false, child: body),
      ],
    );
  }
}

class ProjectListRows extends StatelessWidget {
  const ProjectListRows({
    super.key,
    required this.rows,
    required this.state,
    required this.uri,
    required this.onStateChanged,
    required this.onSelected,
    this.shrinkWrap = false,
  });

  final List<api_models.Project> rows;
  final ProjectListState state;
  final Uri uri;
  final ValueChanged<Uri> onStateChanged;
  final ValueChanged<api_models.Project> onSelected;
  final bool shrinkWrap;

  Widget _sortHeader(BuildContext context, ProjectSortColumn column) {
    final label = column == ProjectSortColumn.title
        ? text(context, 'Titel', 'Title')
        : text(context, 'Anschrift', 'Address');
    final active = state.sortColumn == column;

    return SsTableSortHeader(
      label: label,
      ascending: active ? !state.descending : null,
      onPressed: () {
        onStateChanged(state.apply(uri, toggleColumn: column));
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    final sorted = sortedProjects(rows, state);
    final lastPage = math.max(0, (sorted.length - 1) ~/ state.pageSize);
    final page = state.page.clamp(0, lastPage);
    final start = page * state.pageSize;
    final end = math.min(start + state.pageSize, sorted.length);
    final visible = sorted.sublist(start, end);
    final content = LayoutBuilder(
      builder: (context, constraints) {
        final scale = MediaQuery.textScalerOf(context).scale(14) / 14;
        final empty = Padding(
          padding: const EdgeInsets.all(14.4),
          child: Text(
            text(context, 'Keine Einträge vorhanden.', 'No entries available.'),
          ),
        );

        if (MediaQuery.sizeOf(context).width >= 1000 && scale <= 1.4) {
          return SsDataTable<api_models.Project>(
            rows: visible,
            shrinkWrap: shrinkWrap,
            empty: empty,
            rowKey: (row) {
              return row.id;
            },

            onSelected: onSelected,
            columns: [
              SsTableColumn(
                label: text(context, 'Titel', 'Title'),
                header: _sortHeader(context, ProjectSortColumn.title),
                cell: (row) {
                  return Text(row.title);
                },
              ),
              SsTableColumn(
                label: text(context, 'Anschrift', 'Address'),
                header: _sortHeader(context, ProjectSortColumn.address),
                cell: (row) {
                  return Text(projectAddress(row.address));
                },
              ),
            ],
          );
        }

        if (visible.isEmpty) {
          return SsSurface(child: empty);
        }

        return SsSurface(
          padding: const EdgeInsets.all(8),
          child: ListView.builder(
            padding: EdgeInsets.zero,
            shrinkWrap: shrinkWrap,
            physics: shrinkWrap ? const NeverScrollableScrollPhysics() : null,
            itemCount: visible.length,
            itemBuilder: (context, index) {
              final project = visible[index];
              final address = projectAddress(project.address);

              return Padding(
                padding: EdgeInsets.only(
                  bottom: index == visible.length - 1 ? 0 : 8,
                ),
                child: SsSurface(
                  child: SsListTile(
                    title: Text(project.title),
                    subtitle: address.isEmpty ? null : Text(address),
                    onTap: () {
                      onSelected(project);
                    },
                  ),
                ),
              );
            },
          ),
        );
      },
    );

    return Column(
      mainAxisSize: shrinkWrap ? MainAxisSize.min : MainAxisSize.max,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        ProjectPagination(
          total: sorted.length,
          page: page,
          pageSize: state.pageSize,
          onPage: (page) {
            onStateChanged(state.apply(uri, page: page));
          },

          onSize: (size) {
            onStateChanged(state.apply(uri, pageSize: size));
          },
        ),
        const SizedBox(height: 8),
        if (shrinkWrap) content else Expanded(child: content),
      ],
    );
  }
}

class ProjectPagination extends StatelessWidget {
  const ProjectPagination({
    super.key,
    required this.total,
    required this.page,
    required this.pageSize,
    required this.onPage,
    required this.onSize,
  });

  final int total;
  final int page;
  final int pageSize;
  final ValueChanged<int> onPage;
  final ValueChanged<int> onSize;

  @override
  Widget build(BuildContext context) {
    return SsPagination(
      totalItems: total,
      page: page + 1,
      pageSize: pageSize,
      pageSizes: projectPageSizes,
      itemsPerPageText: text(context, 'Zeilen pro Seite', 'Rows per page'),
      backwardText: text(context, 'Zurück', 'Previous'),
      forwardText: text(context, 'Weiter', 'Next'),
      itemRangeText: (from, to, total) {
        return text(
          context,
          'Zeile $from–$to von $total',
          'Rows $from–$to of $total',
        );
      },

      pageRangeText: (page, total) {
        return text(context, 'Seite $page von $total', 'Page $page of $total');
      },

      onPage: (page) {
        onPage(page - 1);
      },

      onPageSize: onSize,
    );
  }
}
