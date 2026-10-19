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
import 'tool_detail_layout.dart';
import 'tool_filter_dialog.dart';
import 'tool_filter_options.dart';
import 'tool_list_filter.dart';
import 'tool_list_state.dart';

class ToolListScreen extends StatelessWidget {
  const ToolListScreen({super.key});

  Future<void> _showFilters(
    BuildContext context,
    SessionController session,
    Uri uri,
    ToolListFilter filter,
  ) async {
    final binding = session.binding;

    bool current() {
      return session.authenticated &&
          session.binding == binding &&
          session.info?.can('view:tools') == true;
    }

    if (!current()) {
      return;
    }

    final options = ToolFilterOptions(
      read: session.read,
      isCurrent: current,
      can: (permission) {
        return session.info?.can(permission) == true;
      },
    );
    final result = await showDialog<ToolListFilter>(
      context: context,
      builder: (dialogContext) {
        final active = dialogContext.watch<SessionController>();

        return ToolFilterDialog(
          initialFilter: filter,
          queryIdentity: (binding, 'tool-filter'),
          enabled: identical(active, session) && current(),
          loadBrands: options.brands,
          loadCategories: options.categories,
          onApplied: (next) {
            Navigator.of(dialogContext).pop(next);
          },
          onCancel: () {
            Navigator.of(dialogContext).pop();
          },
        );
      },
    );

    if (!context.mounted || !current() || result == null) {
      return;
    }

    if (GoRouterState.of(context).uri != uri) {
      return;
    }

    context.go(applyToolFilters(uri, result).toString());
  }

  @override
  Widget build(BuildContext context) {
    final session = context.watch<SessionController>();
    final binding = session.binding;
    final uri = GoRouterState.of(context).uri;
    final filter = ToolListFilter.fromUri(uri);

    if (!session.authenticated || session.info?.can('view:tools') != true) {
      return Center(
        child: Text(text(context, 'Keine Berechtigung', 'No permission')),
      );
    }

    final hasFilter = filter.status != null ||
        filter.brand?.isNotEmpty == true ||
        filter.category?.isNotEmpty == true;

    return Title(
      title: text(context, 'Werkzeuge', 'Tools'),
      color: SsTheme.of(context).text,
      child: Column(
        children: [
          SsPageHeader(
            title: text(context, 'Werkzeuge', 'Tools'),
            actions: Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                SsOperationalTag(
                  onPressed: () {
                    context.go(toolArchiveUri(
                      uri,
                      archivedOnly: !filter.archivedOnly,
                    ).toString());
                  },
                  child: Text(
                    filter.archivedOnly
                        ? text(context, 'Archiviert', 'Archived')
                        : text(context, 'Nicht archiviert', 'Not archived'),
                  ),
                ),
                SsOperationalTag(
                  onPressed: () {
                    _showFilters(context, session, uri, filter);
                  },
                  child: Text(
                    hasFilter
                        ? text(context, 'Filter ändern', 'Edit filters')
                        : text(context, 'Filter', 'Filter'),
                  ),
                ),
                if (hasFilter)
                  SsOperationalTag(
                    onPressed: () {
                      context.go(
                        applyToolFilters(uri, const ToolListFilter()).toString(),
                      );
                    },
                    child: Text(text(context, 'Filter aus', 'Clear filters')),
                  ),
              ],
            ),
          ),
          Expanded(
            child: QueryView<List<models.Tool>>(
              requestKey: ApiQueries.toolsList.path,
              identity: [filter.input('').toWire(), filter.archivedOnly],
              load: (current) async {
                void checkScope() {
                  if (!current.authenticated ||
                      current.binding != binding ||
                      current.info?.can('view:tools') != true) {
                    throw StateError('TOOL_LIST_SCOPE_CHANGED');
                  }
                }

                checkScope();

                final rows = await current.read(
                  ApiQueries.toolsList,
                  filter.input(''),
                );
                checkScope();

                return filter.visibleRows(rows);
              },
              builder: (context, rows, reload) {
                return ToolListRows(
                  rows: rows,
                  state: ToolListState.fromUri(uri),
                  uri: uri,
                  onStateChanged: (next) {
                    context.go(next.toString());
                  },
                  onSelected: (tool) {
                    context.go('/tools/${Uri.encodeComponent(tool.id)}');
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

class ToolListRows extends StatelessWidget {
  const ToolListRows({
    super.key,
    required this.rows,
    required this.state,
    required this.uri,
    required this.onStateChanged,
    required this.onSelected,
  });

  final List<models.Tool> rows;
  final ToolListState state;
  final Uri uri;
  final ValueChanged<Uri> onStateChanged;
  final ValueChanged<models.Tool> onSelected;

  String _label(BuildContext context, ToolSortColumn column) {
    return switch (column) {
      ToolSortColumn.number => text(context, 'Nummer', 'Number'),
      ToolSortColumn.status => text(context, 'Status', 'Status'),
      ToolSortColumn.brand => text(context, 'Marke', 'Brand'),
      ToolSortColumn.category => text(context, 'Kategorie', 'Category'),
      ToolSortColumn.model => text(context, 'Modell', 'Model'),
    };
  }

  Widget _status(BuildContext context, models.Tool tool, SsTagSize size) {
    final (de, en, tone) = toolStatusPresentation(tool);

    return SsTag(
      tone: tone,
      size: size,
      child: Text(text(context, de, en)),
    );
  }

  @override
  Widget build(BuildContext context) {
    final german = Localizations.localeOf(context).languageCode == 'de';
    final sorted = sortedTools(rows, state, german: german);
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
            pageSizes: toolPageSizes,
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
                return SsDataTable<models.Tool>(
                  rows: visible,
                  empty: empty,
                  rowKey: (tool) {
                    return tool.id;
                  },
                  onSelected: onSelected,
                  columns: [
                    for (final column in ToolSortColumn.values)
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
                        cell: (tool) {
                          if (column == ToolSortColumn.status) {
                            return _status(context, tool, SsTagSize.medium);
                          }

                          return Text(
                            toolColumnText(tool, column, german: german),
                          );
                        },
                      ),
                  ],
                );
              }

              return ListView(
                padding: EdgeInsets.zero,
                children: [
                  if (visible.isEmpty) empty,
                  for (final tool in visible)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 8),
                      child: SsSurface(
                        padding: const EdgeInsets.all(9.6),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            SsLink(
                              uri: Uri.parse(
                                '/tools/${Uri.encodeComponent(tool.id)}',
                              ),
                              onPressed: () {
                                onSelected(tool);
                              },
                              child: Text(
                                '${toolNumber(tool.customId)} ${toolTitle(tool)}',
                              ),
                            ),
                            const SizedBox(height: 8),
                            _status(context, tool, SsTagSize.small),
                          ],
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
