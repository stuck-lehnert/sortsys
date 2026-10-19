import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

import '../../state/session_controller.dart';
import '../../ui/query_view.dart';
import '../../ui/tabler_icon.dart';
import '../../ui/text.dart';
import '../contacts/contact_list_screen.dart';
import '../delivery_notes/delivery_note_list_screen.dart';
import '../products/product_list_screen.dart';
import '../projects/project_filter.dart';
import '../projects/project_status_filter.dart';
import '../tools/tool_list_filter.dart';
import '../tools/tool_list_screen.dart';
import '../users/user_list_screen.dart';
import '../vendors/vendor_list_screen.dart';
import 'catalog.dart';
import 'entity_presentation.dart';
import 'entity_record.dart';
import 'entity_repository.dart';

class EntityListScreen extends HookWidget {
  const EntityListScreen(this.spec, {super.key});

  final EntitySpec spec;

  @override
  Widget build(BuildContext context) {
    final session = context.watch<SessionController>();
    final controller = useTextEditingController();
    final search = useState('');
    final projectStatus = useState(ProjectListStatus.active);
    final typed = useValueListenable(controller).text;

    useEffect(() {
      final timer = Timer(const Duration(milliseconds: 300), () {
        search.value = typed.trim();
      });

      return timer.cancel;
    }, [typed]);

    if (session.info?.can(spec.role) != true) {
      return const EntityAccessDenied();
    }

    if (spec.key == 'vendors') {
      return const VendorListScreen();
    }

    if (spec.key == 'tools') {
      return const ToolListScreen();
    }

    if (spec.key == 'products') {
      return const ProductListScreen();
    }

    if (spec.key == 'contacts') {
      return const ContactListScreen();
    }

    if (spec.key == 'users') {
      return const UserListScreen();
    }

    if (spec.key == 'delivery-notes') {
      return const DeliveryNoteListScreen();
    }

    final toolFilter = spec.key == 'tools'
        ? ToolListFilter.fromUri(GoRouterState.of(context).uri)
        : const ToolListFilter();

    return Column(
      children: [
        SsPageHeader(
          title: text(context, spec.de, spec.en),
          actions: spec.search
              ? SsTextField(
                  controller: controller,
                  kind: SsTextFieldKind.search,
                  hint: text(context, 'Suchen', 'Search'),
                  prefix: const Padding(
                    padding: EdgeInsets.symmetric(
                      horizontal: 8.96,
                      vertical: 5.76,
                    ),
                    child: TablerIcon('search'),
                  ),
                )
              : null,
        ),
        if (spec.key == 'projects')
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
            child: ProjectStatusFilter(
              status: projectStatus.value,
              onChanged: (status) {
                projectStatus.value = status;
              },
            ),
          ),
        Expanded(
          child: QueryView(
            requestKey: spec.list,
            identity: [
              search.value,
              projectStatus.value.finished,
              if (spec.key == 'tools') ...[
                toolFilter.input('').toWire(),
                toolFilter.archivedOnly,
              ],
            ],
            load: (session) {
              return loadEntityList(
                session,
                spec.key,
                search.value,
                projectStatus: projectStatus.value,
                toolFilter: toolFilter,
              );
            },

            builder: (context, value, reload) {
              return _EntityRows(spec: spec, rows: value, onReload: reload);
            },
          ),
        ),
      ],
    );
  }
}

class _EntityRows extends StatelessWidget {
  const _EntityRows({
    required this.spec,
    required this.rows,
    required this.onReload,
  });

  final EntitySpec spec;
  final List<EntityRecord> rows;
  final VoidCallback onReload;

  @override
  Widget build(BuildContext context) {
    if (rows.isEmpty) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              text(context, 'Keine Einträge gefunden.', 'No entries found.'),
            ),
            const SizedBox(height: 12),
            SsButton(
              kind: SsButtonKind.secondary,
              onPressed: onReload,
              child: Text(text(context, 'Aktualisieren', 'Refresh')),
            ),
          ],
        ),
      );
    }

    return RefreshIndicator(
      onRefresh: () async {
        onReload();
      },

      child: LayoutBuilder(
        builder: (context, constraints) {
          final scale = MediaQuery.textScalerOf(context).scale(14) / 14;

          if (constraints.maxWidth >= 760 && scale <= 1.4) {
            return _EntityTable(spec: spec, rows: rows);
          }

          return ListView.builder(
            itemCount: rows.length,
            padding: EdgeInsets.zero,
            itemBuilder: (context, index) {
              return Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: _EntityRow(spec: spec, row: rows[index]),
              );
            },
          );
        },
      ),
    );
  }
}

class _EntityTable extends StatelessWidget {
  const _EntityTable({required this.spec, required this.rows});

  final EntitySpec spec;
  final List<EntityRecord> rows;

  @override
  Widget build(BuildContext context) {
    final locale = Localizations.localeOf(context).languageCode;

    return SsDataTable<EntityRecord>(
      rows: rows,
      rowKey: (row) {
        return row.id;
      },

      columns: [
        SsTableColumn(
          label: text(context, 'Eintrag', 'Entry'),
          flex: 2,
          cell: (row) {
            return Text(recordTitle(row));
          },
        ),
        SsTableColumn(
          label: text(context, 'Details', 'Details'),
          flex: 3,
          cell: (row) {
            return Text(recordSubtitle(row, locale));
          },
        ),
        if (spec.key == 'projects')
          SsTableColumn(
            label: 'Status',
            cell: (row) {
              return row.finishedAt == null
                  ? const SizedBox.shrink()
                  : SsBadge(
                      child: Text(text(context, 'Abgeschlossen', 'Completed')),
                    );
            },
          ),
      ],
      onSelected: spec.get == null
          ? null
          : (row) {
              context.go('${spec.path}/${Uri.encodeComponent(row.id)}');
            },
    );
  }
}

class _EntityRow extends StatelessWidget {
  const _EntityRow({required this.spec, required this.row});

  final EntitySpec spec;
  final EntityRecord row;

  @override
  Widget build(BuildContext context) {
    final locale = Localizations.localeOf(context).languageCode;

    return SsSurface(
      child: SsListTile(
        leading: TablerIcon(spec.icon),
        title: Text(recordTitle(row)),
        subtitle: Text(recordSubtitle(row, locale)),
        trailing: row.finishedAt != null
            ? SsBadge(child: Text(text(context, 'Abgeschlossen', 'Completed')))
            : null,
        onTap: spec.get == null
            ? null
            : () {
                context.go('${spec.path}/${Uri.encodeComponent(row.id)}');
              },
      ),
    );
  }
}
