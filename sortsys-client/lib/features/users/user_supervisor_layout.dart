import 'dart:math' as math;

import 'package:flutter/widgets.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

import '../../api/generated/models.g.dart' as models;
import '../../ui/text.dart';
import 'user_list_state.dart';
import 'user_supervisor_graph.dart';

class UserSupervisorLayout extends StatefulWidget {
  const UserSupervisorLayout({
    super.key,
    required this.queryIdentity,
    required this.compareNames,
    this.users,
    this.defaultSupervisorId,
    this.hasError = false,
    this.onUserPressed,
  });

  final Object queryIdentity;
  final Comparator<String> compareNames;
  final List<models.User>? users;
  final String? defaultSupervisorId;
  final bool hasError;
  final ValueChanged<models.User>? onUserPressed;

  @override
  State<UserSupervisorLayout> createState() {
    return _UserSupervisorLayoutState();
  }
}

class _UserSupervisorLayoutState extends State<UserSupervisorLayout> {
  Set<String> _expandedIds = {};

  @override
  void didUpdateWidget(covariant UserSupervisorLayout oldWidget) {
    super.didUpdateWidget(oldWidget);

    if (widget.queryIdentity != oldWidget.queryIdentity) {
      _expandedIds = {};
    }
  }

  Widget _userTile(models.User user) {
    final onPressed = widget.onUserPressed;

    return SsSurface(
      padding: const EdgeInsets.all(16),
      child: SsLink(
        uri: Uri.parse('/users/${Uri.encodeComponent(user.id)}'),
        onPressed: onPressed == null
            ? null
            : () {
                onPressed(user);
              },
        child: Text(
          userListName(user),
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: const TextStyle(
            fontSize: 16.64,
            height: 1.15,
            fontWeight: FontWeight.w700,
            letterSpacing: -0.3328,
          ),
        ),
      ),
    );
  }

  Widget _node(UserSupervisorRow row) {
    final colors = SsTheme.of(context);
    final expanded = _expandedIds.contains(row.user.id);

    return Padding(
      padding: EdgeInsetsDirectional.only(start: row.depth * 48.0),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.only(top: 22),
            child: SizedBox(
              width: 18,
              child: row.depth == 0
                  ? const SizedBox(height: 1)
                  : Container(height: 1, color: colors.border),
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                _userTile(row.user),
                if (row.cycle)
                  Padding(
                    padding: const EdgeInsets.only(top: 6),
                    child: Text(
                      text(context, 'Zyklus erkannt', 'Cycle detected'),
                      style: colors.body.copyWith(color: colors.secondaryText),
                    ),
                  ),
                if (!row.cycle && row.directReportCount > 0)
                  Align(
                    alignment: AlignmentDirectional.centerStart,
                    child: SsButton(
                      kind: SsButtonKind.ghost,
                      size: SsButtonSize.small,
                      onPressed: () {
                        setState(() {
                          final next = Set<String>.of(_expandedIds);

                          if (!next.remove(row.user.id)) {
                            next.add(row.user.id);
                          }

                          _expandedIds = next;
                        });
                      },
                      child: Text(
                        expanded
                            ? text(
                                context,
                                'Untergebene ausblenden',
                                'Hide direct reports',
                              )
                            : text(
                                context,
                                'Untergebene anzeigen (${row.directReportCount})',
                                'Show direct reports (${row.directReportCount})',
                              ),
                      ),
                    ),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _treeCard(List<UserSupervisorRow> rows, {bool cycleGroup = false}) {
    final depth = rows.fold<int>(0, (maximum, row) {
      return math.max(maximum, row.depth);
    });

    return LayoutBuilder(
      builder: (context, constraints) {
        // Keep deep nodes usable without shrinking their minimum-width tile.
        final width = math.max(constraints.maxWidth - 34, 250 + depth * 48.0);

        return SsSurface(
          padding: const EdgeInsets.all(16),
          child: SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: SizedBox(
              width: width,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  if (cycleGroup) ...[
                    Text(
                      text(
                        context,
                        'Zyklen oder verwaiste Einträge',
                        'Cycles or orphaned entries',
                      ),
                      style: SsTheme.of(context).body
                          .copyWith(fontSize: 18, fontWeight: FontWeight.w700),
                    ),
                    const SizedBox(height: 10),
                  ],
                  for (final (index, row) in rows.indexed) ...[
                    if (index > 0) const SizedBox(height: 10),
                    _node(row),
                  ],
                ],
              ),
            ),
          ),
        );
      },
    );
  }

  Widget _status(UserSupervisorGraph graph) {
    if (widget.users == null) {
      return SsSurface(
        padding: const EdgeInsets.all(16),
        child: Row(
          children: [
            const SsSpinner(),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                text(
                  context,
                  'Vorgesetztenstruktur wird geladen …',
                  'Loading supervisor hierarchy …',
                ),
              ),
            ),
          ],
        ),
      );
    }

    if (graph.users.isEmpty) {
      return SsSurface(
        padding: const EdgeInsets.all(16),
        child: Text(
          text(context, 'Keine Benutzer vorhanden.', 'No users available.'),
        ),
      );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (final root in graph.roots) ...[
          _treeCard(graph.visibleRows(root, _expandedIds)),
          const SizedBox(height: 16),
        ],
        if (graph.cycleRoots.isNotEmpty)
          _treeCard([
            for (final root in graph.cycleRoots)
              ...graph.visibleRows(root, _expandedIds),
          ], cycleGroup: true),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    final graph = UserSupervisorGraph(
      widget.users ?? const [],
      compareNames: widget.compareNames,
    );
    final defaultUser = graph.defaultSupervisor(widget.defaultSupervisorId);
    final allExpanded = graph.allExpanded(_expandedIds);

    return Title(
      title: text(context, 'Vorgesetzte', 'Supervisors'),
      color: SsTheme.of(context).text,
      child: ListView(
        padding: EdgeInsets.zero,
        children: [
          SsPageHeader(
            title: text(context, 'Vorgesetzte', 'Supervisors'),
            actions: SsButton(
              kind: SsButtonKind.ghost,
              size: SsButtonSize.small,
              onPressed: graph.expandableIds.isEmpty
                  ? null
                  : () {
                      setState(() {
                        _expandedIds = graph.toggleAll(_expandedIds);
                      });
                    },
              child: Text(
                allExpanded
                    ? text(context, 'Alle zuklappen', 'Collapse all')
                    : text(context, 'Alle aufklappen', 'Expand all'),
              ),
            ),
          ),
          if (defaultUser != null)
            Padding(
              padding: const EdgeInsets.only(bottom: 16),
              child: Text(
                text(
                  context,
                  'Standard-Vorgesetzter: ${userListName(defaultUser)}',
                  'Default supervisor: ${userListName(defaultUser)}',
                ),
                style: SsTheme.of(context).body
                    .copyWith(color: SsTheme.of(context).secondaryText),
              ),
            ),
          if (widget.hasError) ...[
            SsInfoCallout(
              kind: SsCalloutKind.error,
              child: Text(
                text(
                  context,
                  'Vorgesetztenstruktur konnte nicht vollständig geladen werden',
                  'The supervisor hierarchy could not be loaded completely',
                ),
                style: const TextStyle(
                  fontSize: 14.4,
                  fontWeight: FontWeight.w700,
                  letterSpacing: 0.16,
                ),
              ),
            ),
            const SizedBox(height: 16),
          ],
          _status(graph),
        ],
      ),
    );
  }
}
