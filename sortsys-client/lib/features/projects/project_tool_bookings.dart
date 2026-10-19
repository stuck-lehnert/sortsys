import 'dart:math' as math;

import 'package:flutter/widgets.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

import '../../api/generated/api.g.dart';
import '../../api/generated/models.g.dart' as models;
import '../../api/model.dart';
import '../../state/session_controller.dart';
import '../../ui/text.dart';

typedef ProjectToolBooking = models.ToolsTrackingsListResultItem;

enum ProjectBookingSort { started, ended }

models.ToolsTrackingsListInput projectBookingsInput(String projectId) {
  return models.ToolsTrackingsListInput(
    projectId: RpcOptional.value(projectId),
    finished: const RpcOptional.value(false),
  );
}

List<ProjectToolBooking> sortedProjectBookings(
  List<ProjectToolBooking> rows, {
  ProjectBookingSort? sort,
  bool descending = false,
}) {
  final indexed = rows.indexed.toList();

  indexed.sort((left, right) {
    final int comparison;

    if (sort == ProjectBookingSort.ended) {
      const open = 9007199254740991;
      final first = left.$2.endedAt?.millisecondsSinceEpoch ?? open;
      final second = right.$2.endedAt?.millisecondsSinceEpoch ?? open;
      comparison = descending
          ? second.compareTo(first)
          : first.compareTo(second);
    } else if (sort == ProjectBookingSort.started) {
      comparison = descending
          ? right.$2.startedAt.compareTo(left.$2.startedAt)
          : left.$2.startedAt.compareTo(right.$2.startedAt);
    } else {
      comparison = right.$2.startedAt.compareTo(left.$2.startedAt);
    }

    return comparison == 0 ? left.$1.compareTo(right.$1) : comparison;
  });

  return List.unmodifiable(
    indexed.map((entry) {
      return entry.$2;
    }),
  );
}

class ProjectToolBookings extends HookWidget {
  const ProjectToolBookings({super.key, required this.projectId});

  final String projectId;

  @override
  Widget build(BuildContext context) {
    final session = context.watch<SessionController>();
    final binding = session.binding;
    final revision = useState(0);
    final allowed =
        session.authenticated && session.info?.can('view:projects') == true;
    final request = useMemoized(() {
      if (!allowed) {
        return null;
      }

      return () async {
        final rows = await session.read(
          ApiQueries.toolsTrackingsList,
          projectBookingsInput(projectId),
        );

        if (!session.authenticated ||
            session.binding != binding ||
            session.info?.can('view:projects') != true) {
          throw StateError('PROJECT_BOOKING_SCOPE_CHANGED');
        }

        if (rows.any((row) {
          return row.projectId != projectId || row.endedAt != null;
        })) {
          throw const FormatException('PROJECT_BOOKING_RESPONSE_MISMATCH');
        }

        return rows;
      }();
    }, [binding, projectId, allowed, revision.value]);
    final snapshot = useFuture(request, preserveState: false);

    if (!allowed) {
      return const SizedBox.shrink();
    }

    final rows = snapshot.data ?? const <ProjectToolBooking>[];
    final loading = snapshot.connectionState != ConnectionState.done;

    if (!loading && !snapshot.hasError && rows.isEmpty) {
      return const SizedBox.shrink();
    }

    return SsDisclosure(
      title: text(
        context,
        'Gebuchte Werkzeuge (${rows.length})',
        'Booked tools (${rows.length})',
      ),
      child: ProjectToolBookingsContent(
        key: ValueKey((binding, projectId)),
        rows: rows,
        loading: loading,
        error: snapshot.error,
        onRetry: () {
          revision.value++;
        },
        toolBuilder: (context, id) {
          return _BookingEntityLink(id: id, tool: true, comma: false);
        },
        userBuilder: (context, id, comma) {
          return _BookingEntityLink(id: id, tool: false, comma: comma);
        },
      ),
    );
  }
}

class _BookingEntityLink extends HookWidget {
  const _BookingEntityLink({
    required this.id,
    required this.tool,
    required this.comma,
  });

  final String id;
  final bool tool;
  final bool comma;

  @override
  Widget build(BuildContext context) {
    final session = context.watch<SessionController>();
    final allowed =
        session.authenticated &&
        (tool || session.info?.can('view:users') == true);
    final request = useMemoized(() {
      if (!allowed) {
        return null;
      }

      return () async {
        if (tool) {
          final value = await session.read(
            ApiQueries.toolsGet,
            models.ToolsGetInput(id: id),
          );

          if (value.id != id) {
            throw const FormatException('BOOKING_TOOL_RESPONSE_MISMATCH');
          }

          final suffix = value.label?.isNotEmpty == true
              ? ' ${value.label}'
              : '';

          return '${value.customId} ${value.brand} ${value.category}$suffix';
        }

        final value = await session.read(
          ApiQueries.usersGet,
          models.UsersGetInput(id: id),
        );

        if (value.id != id) {
          throw const FormatException('BOOKING_USER_RESPONSE_MISMATCH');
        }

        final first = value.firstName;
        final last = value.lastName ?? '';

        if (comma && first.isNotEmpty && last.isNotEmpty) {
          return '$last, $first';
        }

        return [first, last]
            .where((part) {
              return part.isNotEmpty;
            })
            .join(' ');
      }();
    }, [session.binding, id, tool, comma, allowed]);
    final result = useFuture(request, preserveState: false);

    if (!allowed) {
      return Text(text(context, 'Keine Berechtigung', 'No permission'));
    }

    if (result.connectionState != ConnectionState.done) {
      return const Align(
        alignment: AlignmentDirectional.centerStart,
        child: SsSpinner(),
      );
    }

    if (result.hasError) {
      return Text(text(context, 'Unbekannt', 'Unknown'));
    }

    final location = '/${tool ? 'tools' : 'users'}/${Uri.encodeComponent(id)}';

    return SsLink(
      uri: Uri.parse(location),
      onPressed: () {
        context.go(location);
      },
      child: Text(result.data ?? ''),
    );
  }
}

class ProjectToolBookingsContent extends StatefulWidget {
  const ProjectToolBookingsContent({
    super.key,
    required this.rows,
    required this.toolBuilder,
    required this.userBuilder,
    this.loading = false,
    this.error,
    this.onRetry,
  });

  final List<ProjectToolBooking> rows;
  final Widget Function(BuildContext, String) toolBuilder;
  final Widget Function(BuildContext, String, bool) userBuilder;
  final bool loading;
  final Object? error;
  final VoidCallback? onRetry;

  @override
  State<ProjectToolBookingsContent> createState() {
    return _ProjectToolBookingsContentState();
  }
}

class _ProjectToolBookingsContentState
    extends State<ProjectToolBookingsContent> {
  int _page = 0;
  int _pageSize = 25;
  ProjectBookingSort? _sort;
  bool _descending = false;

  String _date(DateTime value) {
    final german = Localizations.localeOf(context).languageCode == 'de';

    return DateFormat(german ? 'dd.MM.yyyy' : 'MM/dd/yyyy')
        .format(value.toLocal());
  }

  Widget _user(String? id, {required bool comma}) {
    if (id == null) {
      return const SizedBox.shrink();
    }

    return widget.userBuilder(context, id, comma);
  }

  Widget _sortHeader(ProjectBookingSort column, String label) {
    return SsTableSortHeader(
      label: label,
      ascending: _sort == column ? !_descending : null,
      onPressed: () {
        setState(() {
          if (_sort != column) {
            _sort = column;
            _descending = false;
          } else if (!_descending) {
            _descending = true;
          } else {
            _sort = null;
            _descending = false;
          }
        });
      },
    );
  }

  Widget _state() {
    if (widget.error != null) {
      return Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            text(
              context,
              'Einträge konnten nicht geladen werden.',
              'Entries could not be loaded.',
            ),
          ),
          if (widget.onRetry != null) ...[
            const SizedBox(height: 8),
            SsButton(
              kind: SsButtonKind.secondary,
              onPressed: widget.onRetry,
              child: Text(text(context, 'Erneut laden', 'Reload')),
            ),
          ],
        ],
      );
    }

    if (widget.loading) {
      return Wrap(
        spacing: 8,
        crossAxisAlignment: WrapCrossAlignment.center,
        children: [
          const SsSpinner(),
          Text(text(context, 'Einträge werden geladen …', 'Loading entries …')),
        ],
      );
    }

    return Text(
      text(context, 'Keine Einträge vorhanden.', 'No entries available.'),
    );
  }

  Widget _tile(ProjectToolBooking row) {
    return SsSurface(
      padding: const EdgeInsets.all(9.6),
      child: SsAttributeList(
        children: [
          SsAttribute(
            label: text(context, 'Werkzeug', 'Tool'),
            child: widget.toolBuilder(context, row.toolId),
          ),
          if (row.responsibleUserId != null)
            SsAttribute(
              label: text(context, 'Verantwortlich', 'Responsible'),
              child: _user(row.responsibleUserId, comma: false),
            ),
          if (row.startedByUserId != null)
            SsAttribute(
              label: text(context, 'Herausgeber', 'Issuer'),
              child: _user(row.startedByUserId, comma: false),
            ),
          SsAttribute(
            label: row.endedAt == null
                ? text(context, 'Seit', 'Since')
                : text(context, 'Von', 'From'),
            child: Text(_date(row.startedAt)),
          ),
          if (row.endedAt != null)
            SsAttribute(
              label: text(context, 'Bis', 'Until'),
              child: Text(_date(row.endedAt!)),
            ),
          if (row.deadlineAt != null)
            SsAttribute(label: 'Deadline', child: Text(_date(row.deadlineAt!))),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final sorted = sortedProjectBookings(
      widget.rows,
      sort: _sort,
      descending: _descending,
    );
    final page = _page
        .clamp(0, math.max(0, (sorted.length - 1) ~/ _pageSize))
        .toInt();
    final visible = widget.loading || widget.error != null
        ? const <ProjectToolBooking>[]
        : sorted.skip(page * _pageSize).take(_pageSize).toList();
    final empty = Padding(
      padding: const EdgeInsets.all(14.4),
      child: Semantics(liveRegion: true, child: _state()),
    );
    final compact =
        MediaQuery.sizeOf(context).width < 1400 ||
        MediaQuery.textScalerOf(context).scale(14) / 14 > 1.4;
    final colors = SsTheme.of(context);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        SizedBox(
          height: 320,
          child: compact
              ? DecoratedBox(
                  decoration: BoxDecoration(
                    color: colors.surface.withValues(alpha: 0.2),
                    border: Border.all(color: colors.border),
                  ),
                  child: SingleChildScrollView(
                    padding: const EdgeInsets.all(9),
                    child: visible.isEmpty
                        ? empty
                        : Column(
                            crossAxisAlignment: CrossAxisAlignment.stretch,
                            children: [
                              for (final row in visible)
                                Padding(
                                  padding: const EdgeInsets.only(bottom: 8),
                                  child: _tile(row),
                                ),
                            ],
                          ),
                  ),
                )
              : SsDataTable<ProjectToolBooking>(
                  rows: visible,
                  rowKey: (row) {
                    return row.id;
                  },
                  empty: empty,
                  columns: [
                    SsTableColumn(
                      label: text(context, 'Werkzeug', 'Tool'),
                      cell: (row) {
                        return widget.toolBuilder(context, row.toolId);
                      },
                    ),
                    SsTableColumn(
                      label: text(context, 'Verantwortlicher', 'Responsible'),
                      cell: (row) {
                        return _user(row.responsibleUserId, comma: true);
                      },
                    ),
                    SsTableColumn(
                      label: text(context, 'Herausgeber', 'Issuer'),
                      cell: (row) {
                        return _user(row.startedByUserId, comma: true);
                      },
                    ),
                    SsTableColumn(
                      label: text(context, 'Von', 'From'),
                      header: _sortHeader(
                        ProjectBookingSort.started,
                        text(context, 'Von', 'From'),
                      ),
                      cell: (row) {
                        return Text(_date(row.startedAt));
                      },
                    ),
                    SsTableColumn(
                      label: text(context, 'Bis', 'Until'),
                      header: _sortHeader(
                        ProjectBookingSort.ended,
                        text(context, 'Bis', 'Until'),
                      ),
                      cell: (row) {
                        return Text(
                          row.endedAt == null
                              ? text(context, 'offen', 'open')
                              : _date(row.endedAt!),
                        );
                      },
                    ),
                  ],
                ),
        ),
        if (!widget.loading && widget.error == null && sorted.isNotEmpty)
          SsPagination(
            totalItems: sorted.length,
            page: page + 1,
            pageSize: _pageSize,
            pageSizes: const [25, 50, 100],
            backwardText: text(context, 'Zurück', 'Previous'),
            forwardText: text(context, 'Weiter', 'Next'),
            itemsPerPageText: text(context, 'Zeilen pro Seite', 'Rows per page'),
            itemRangeText: (first, last, total) {
              return text(
                context,
                'Zeile $first–$last von $total',
                'Rows $first–$last of $total',
              );
            },
            pageRangeText: (current, total) {
              return text(
                context,
                'Seite $current von $total',
                'Page $current of $total',
              );
            },
            onPage: (page) {
              setState(() {
                _page = page - 1;
              });
            },
            onPageSize: (size) {
              setState(() {
                _page = 0;
                _pageSize = size;
              });
            },
          ),
      ],
    );
  }
}
