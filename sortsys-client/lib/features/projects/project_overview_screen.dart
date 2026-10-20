import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:provider/provider.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

import '../../api/generated/api.g.dart';
import '../../api/generated/models.g.dart' as models;
import '../../state/session_controller.dart';
import '../../ui/query_view.dart';
import '../../ui/text.dart';
import '../entities/entity_presentation.dart';
import 'project_detail_tabs.dart';
import 'project_editor.dart';
import 'project_history.dart';
import 'project_list_state.dart';
import 'project_related_sections.dart';
import 'project_regie_reports.dart';
import 'project_tool_bookings.dart';

class ProjectOverviewScreen extends HookWidget {
  const ProjectOverviewScreen({
    super.key,
    required this.id,
    this.tab = ProjectDetailTab.overview,
  });

  final String id;
  final ProjectDetailTab tab;

  @override
  Widget build(BuildContext context) {
    final session = context.watch<SessionController>();
    final binding = session.binding;
    final editorIdentity = (binding: binding, projectId: id);
    final editing = useState<({String binding, String projectId})?>(null);

    bool canRead() {
      return context.mounted &&
          session.authenticated &&
          session.binding == binding &&
          session.info?.can('view:projects') == true &&
          (tab != ProjectDetailTab.regieReports ||
              session.info?.can('view:regieReports') == true);
    }

    if (!canRead()) {
      return const EntityAccessDenied();
    }

    return QueryView<models.Project>(
      requestKey: ApiQueries.projectsGet.path,
      identity: '${tab.name}:$id',
      load: (current) async {
        if (!canRead() || !identical(current, session)) {
          throw StateError('PROJECT_DETAIL_SCOPE_CHANGED');
        }

        final project = await current.read(
          ApiQueries.projectsGet,
          models.ProjectsGetInput(id: id),
        );

        if (!canRead()) {
          throw StateError('PROJECT_DETAIL_SCOPE_CHANGED');
        }

        if (project.id != id) {
          throw const FormatException('PROJECT_RESPONSE_ID_MISMATCH');
        }

        return project;
      },
      builder: (context, project, reload) {
        Future<void> edit() async {
          if (editing.value == editorIdentity ||
              !context.mounted ||
              !session.authenticated ||
              session.binding != binding ||
              session.info?.can('manage:projects') != true) {
            return;
          }

          editing.value = editorIdentity;

          try {
            await showProjectEditor(context, project: project);
          } finally {
            if (context.mounted && editing.value == editorIdentity) {
              editing.value = null;
            }
          }

          if (!context.mounted || session.binding != binding) {
            return;
          }

          reload();
        }

        final address = project.address;
        final hasAttributes =
            address != null ||
            project.customerId != null ||
            project.responsibleProjectLeaderUserId != null ||
            project.orderReceivedAt != null;

        return ProjectOverviewLayout(
          project: project,
          editing: editing.value == editorIdentity,
          tabs: ProjectDetailTabs(
            id: project.id,
            tab: tab,
            canViewTools: session.info?.can('view:tools') == true,
            canViewRegieReports: session.info?.can('view:regieReports') == true,
          ),
          onEdit: session.info?.can('manage:projects') == true
              ? () {
                  unawaited(edit());
                }
              : null,
          child: tab == ProjectDetailTab.regieReports
              ? ProjectRegieReports(
                  key: ValueKey((binding, project.id)),
                  projectId: project.id,
                )
              : KeyedSubtree(
                  key: ValueKey((binding, project.id, project.modifiedAt)),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      if (hasAttributes) ...[
                        ProjectAttributes(project: project),
                        const _ProjectDivider(),
                      ],
                      ProjectRemarks(projectId: project.id),
                      const SizedBox(height: 16),
                      ProjectActivity(projectId: project.id),
                      const SizedBox(height: 16),
                      ProjectContacts(projectId: project.id),
                      const SizedBox(height: 16),
                      ProjectToolBookings(projectId: project.id),
                    ],
                  ),
                ),
        );
      },
    );
  }
}

class ProjectOverviewLayout extends StatelessWidget {
  const ProjectOverviewLayout({
    super.key,
    required this.project,
    required this.child,
    this.tabs,
    this.onEdit,
    this.editing = false,
  });

  final models.Project project;
  final Widget child;
  final Widget? tabs;
  final VoidCallback? onEdit;
  final bool editing;

  @override
  Widget build(BuildContext context) {
    final address = project.address;
    final finishedAt = project.finishedAt;
    final edit = editing ? null : onEdit;
    final colors = SsTheme.of(context);

    return CallbackShortcuts(
      bindings: {
        const SingleActivator(LogicalKeyboardKey.keyE, control: true): () {
          edit?.call();
        },
      },
      child: Focus(
        autofocus: true,
        child: ListView(
          padding: EdgeInsets.zero,
          children: [
            SsPageHeader(
              title: project.title,
              subtitle: address == null ? null : projectAddress(address),
              actions: onEdit == null
                  ? null
                  : Align(
                      alignment: AlignmentDirectional.centerEnd,
                      child: MenuAnchor(
                        style: MenuStyle(
                          backgroundColor: WidgetStatePropertyAll(
                            colors.surface,
                          ),
                          side: WidgetStatePropertyAll(
                            BorderSide(color: colors.border),
                          ),
                          shape: const WidgetStatePropertyAll(
                            RoundedRectangleBorder(),
                          ),
                        ),
                        menuChildren: [
                          MenuItemButton(
                            onPressed: edit,
                            leadingIcon: const SsIcon('edit', size: 16),
                            child: Text(text(context, 'Bearbeiten', 'Edit')),
                          ),
                        ],
                        builder: (context, controller, anchor) {
                          return SsIconButton(
                            icon: 'overflow-menu-vertical',
                            label: text(
                              context,
                              'Projektaktionen',
                              'Project actions',
                            ),
                            onPressed: editing
                                ? null
                                : () {
                                    if (controller.isOpen) {
                                      controller.close();
                                    } else {
                                      controller.open();
                                    }
                                  },
                          );
                        },
                      ),
                    ),
            ),
            if (finishedAt != null) ...[
              const SizedBox(height: 8),
              SsInfoCallout(
                icon: 'task-complete',
                child: Text(
                  text(
                    context,
                    'Projekt ist seit ${ssDateText(finishedAt.toLocal())} '
                        'abgeschlossen.',
                    'Project has been completed since '
                        '${ssDateText(finishedAt.toLocal())}.',
                  ),
                ),
              ),
            ],
            if (tabs != null) ...[
              const SizedBox(height: 12),
              tabs!,
            ],
            const SizedBox(height: 12),
            child,
          ],
        ),
      ),
    );
  }
}

class _ProjectDivider extends StatelessWidget {
  const _ProjectDivider();

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 12),
      child: Container(height: 1, color: SsTheme.of(context).border),
    );
  }
}
