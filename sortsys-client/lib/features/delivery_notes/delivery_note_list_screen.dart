import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

import '../../api/generated/api.g.dart';
import '../../api/generated/models.g.dart' as models;
import '../../state/session_controller.dart';
import '../../ui/query_view.dart';
import '../../ui/text.dart';
import 'delivery_note_list_state.dart';
import 'delivery_note_read_repository.dart';

class DeliveryNoteListScreen extends StatelessWidget {
  const DeliveryNoteListScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final session = context.watch<SessionController>();
    final binding = session.binding;
    final uri = GoRouterState.of(context).uri;
    final state = DeliveryNoteListState.fromUri(uri);

    if (!session.authenticated || session.info?.can('view:deliveryNotes') != true) {
      return Center(
        child: Text(text(context, 'Keine Berechtigung', 'No permission')),
      );
    }

    return Title(
      title: text(context, 'Lieferscheine', 'Delivery notes'),
      color: SsTheme.of(context).text,
      child: Column(
        children: [
          SsPageHeader(title: text(context, 'Lieferscheine', 'Delivery notes')),
          Expanded(
            child: QueryView<List<models.DeliveryNote>>(
              requestKey: ApiQueries.deliveryNotesList.path,
              identity: const [],
              load: (current) {
                return DeliveryNoteReadRepository(
                  read: current.read,
                  isCurrent: () {
                    return current.authenticated && current.binding == binding;
                  },
                  canView: () {
                    return current.info?.can('view:deliveryNotes') == true;
                  },
                ).list();
              },
              builder: (context, notes, reload) {
                return DeliveryNoteListRows(
                  rows: notes,
                  state: state,
                  uri: uri,
                  onStateChanged: (next) {
                    context.go(next.toString());
                  },
                  onSelected: (note) {
                    context.go('/products/deliveryNotes/${Uri.encodeComponent(note.id)}');
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

class DeliveryNoteListRows extends StatelessWidget {
  const DeliveryNoteListRows({
    super.key,
    required this.rows,
    required this.state,
    required this.uri,
    required this.onStateChanged,
    required this.onSelected,
  });

  final List<models.DeliveryNote> rows;
  final DeliveryNoteListState state;
  final Uri uri;
  final ValueChanged<Uri> onStateChanged;
  final ValueChanged<models.DeliveryNote> onSelected;

  String _label(BuildContext context, DeliveryNoteSortColumn column) {
    return switch (column) {
      DeliveryNoteSortColumn.number => text(context, 'Nummer', 'Number'),
      DeliveryNoteSortColumn.created => text(context, 'Erfasst am', 'Recorded on'),
      DeliveryNoteSortColumn.effective => text(context, 'Effektiv am', 'Effective on'),
      DeliveryNoteSortColumn.comment => text(context, 'Kommentar', 'Comment'),
    };
  }

  Widget _link(BuildContext context, models.DeliveryNote note, {bool compact = false}) {
    final number = deliveryNoteNumber(note);

    return SsLink(
      uri: Uri.parse('/products/deliveryNotes/${Uri.encodeComponent(note.id)}'),
      onPressed: () {
        onSelected(note);
      },
      child: Text(compact
          ? text(context, 'Lieferschein #$number', 'Delivery note #$number')
          : '#$number'),
    );
  }

  @override
  Widget build(BuildContext context) {
    final sorted = sortedDeliveryNotes(rows, state);
    final lastPage = math.max(0, (sorted.length - 1) ~/ state.pageSize);
    final page = state.page.clamp(0, lastPage);
    final start = page * state.pageSize;
    final visible = sorted.sublist(
      start,
      math.min(start + state.pageSize, sorted.length),
    );
    final dates = DateFormat(
      Localizations.localeOf(context).languageCode == 'en'
          ? 'MM/dd/yyyy'
          : 'dd.MM.yyyy',
    );
    final empty = Padding(
      padding: const EdgeInsets.all(14.4),
      child: Text(text(context, 'Keine Einträge vorhanden.', 'No entries available.')),
    );

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (sorted.isNotEmpty) ...[
          SsPagination(
            totalItems: sorted.length,
            page: page + 1,
            pageSize: state.pageSize,
            pageSizes: deliveryNotePageSizes,
            itemsPerPageText: text(context, 'Zeilen pro Seite', 'Rows per page'),
            backwardText: text(context, 'Zurück', 'Previous'),
            forwardText: text(context, 'Weiter', 'Next'),
            itemRangeText: (from, to, total) {
              return text(context, 'Zeile $from–$to von $total', 'Rows $from–$to of $total');
            },
            pageRangeText: (current, total) {
              return text(context, 'Seite $current von $total', 'Page $current of $total');
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
                return SsDataTable<models.DeliveryNote>(
                  rows: visible,
                  empty: empty,
                  rowKey: (note) {
                    return note.id;
                  },
                  onSelected: onSelected,
                  columns: [
                    for (final column in DeliveryNoteSortColumn.values)
                      SsTableColumn(
                        label: _label(context, column),
                        header: SsTableSortHeader(
                          label: _label(context, column),
                          ascending: state.column == column ? !state.descending : null,
                          onPressed: () {
                            onStateChanged(state.apply(uri, toggleColumn: column));
                          },
                        ),
                        cell: (note) {
                          return switch (column) {
                            DeliveryNoteSortColumn.number => _link(context, note),
                            DeliveryNoteSortColumn.created => Text(
                              dates.format(note.createdAt.toLocal()),
                            ),
                            DeliveryNoteSortColumn.effective => Text(
                              dates.format(note.effectiveTimestamp.toLocal()),
                            ),
                            DeliveryNoteSortColumn.comment => Text(note.comment ?? ''),
                          };
                        },
                      ),
                  ],
                );
              }

              return ListView(
                padding: EdgeInsets.zero,
                children: [
                  if (visible.isEmpty) empty,
                  for (final note in visible)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 8),
                      child: SsSurface(
                        padding: const EdgeInsets.all(9.6),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            _link(context, note, compact: true),
                            Text(dates.format(note.createdAt.toLocal())),
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
