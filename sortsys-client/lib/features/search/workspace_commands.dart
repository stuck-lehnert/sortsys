import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';

import '../../api/generated/api.g.dart';
import '../../api/generated/models.g.dart' as models;
import '../../api/model.dart';
import '../../state/session_controller.dart';
import '../../ui/text.dart';
import '../projects/project_editor.dart';
import 'command_palette_controller.dart';

List<PaletteCommand> workspaceCommands(BuildContext context) {
  return [
    PaletteCommand(
      id: 'projects.create',
      label: text(context, 'Projekt erstellen', 'Create project'),
      description: text(
        context,
        'Neues Projekt im Projektstamm anlegen.',
        'Create a new project.',
      ),
      icon: 'building',
      group: PaletteGroup.create,
      role: 'manage:projects',
    ),
    PaletteCommand(
      id: 'deployments.open',
      label: text(context, 'Einsatzplanung öffnen', 'Open resource planning'),
      description: text(
        context,
        'Projektzuweisungen und Abwesenheiten planen.',
        'Plan project assignments and absences.',
      ),
      icon: 'calendar',
      group: PaletteGroup.navigate,
      role: 'view:projectDeployments',
      href: '/deployments',
    ),
  ];
}

Future<void> runWorkspaceCommand(
  BuildContext context,
  PaletteCommand command,
) async {
  final session = context.read<SessionController>();
  final binding = session.binding;

  bool isCurrent() {
    return session.authenticated &&
        session.binding == binding &&
        session.info?.can(command.role) == true;
  }

  if (!isCurrent()) {
    return;
  }

  unawaited(_recordCommand(session, command));

  switch (command.id) {
    case 'projects.create':
      final id = await showProjectEditor(context);

      if (!context.mounted || id == null || !isCurrent()) {
        return;
      }

      context.go('/projects/${Uri.encodeComponent(id)}');
    case 'deployments.open':
      context.go('/deployments');
    default:
      throw StateError('UNKNOWN_WORKSPACE_COMMAND');
  }
}

Future<void> _recordCommand(
  SessionController session,
  PaletteCommand command,
) async {
  final href = command.href;
  final input = models.PersonalizationActionsAppendInput(
    actionId: command.id,
    label: command.label,
    href: href == null ? const RpcOptional.absent() : RpcOptional.value(href),
  );

  try {
    await session.write(ApiMutations.personalizationActionsAppend, input);
  } catch (_) {
    // Usage history is best effort and is never replayed.
  }
}
