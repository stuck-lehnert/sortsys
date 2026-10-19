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
import 'project_editor.dart';
import 'project_history.dart';
import 'project_list_state.dart';
import 'project_related_sections.dart';
import 'project_tool_bookings.dart';

class ProjectOverviewScreen extends HookWidget {
  const ProjectOverviewScreen({super.key, required this.id});

  final String id;

  @override
  Widget build(BuildContext context) {
    final session = context.watch<SessionController>();
    final binding = session.binding;
    final editorIdentity = (binding: binding, projectId: id);
    final editing = useState<({String binding, String projectId})?>(null);

    if (session.info?.can('view:projects') != true) {
      return const EntityAccessDenied();
    }

    return QueryView<models.Project>(
      requestKey: ApiQueries.projectsGet.path,
      identity: id,
      load: (current) async {
        final project = await current.read(
          ApiQueries.projectsGet,
          models.ProjectsGetInput(id: id),
        );

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
          onEdit: session.info?.can('manage:projects') == true
              ? () {
                  unawaited(edit());
                }
              : null,
          child: KeyedSubtree(
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
    this.onEdit,
    this.editing = false,
  });

  final models.Project project;
  final Widget child;
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
                            child: Text(text(context, 'Bearbeiten', 'Edit')),
                          ),
                        ],
                        builder: (context, controller, anchor) {
                          return SsIconButton(
                            icon: 'chevron-down',
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
