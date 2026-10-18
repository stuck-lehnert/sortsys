import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';

import '../../api/generated/api.g.dart';
import '../../api/generated/models.g.dart' as api_models;
import '../../domain/models.dart';
import '../../ui/query_view.dart';
import '../../ui/tabler_icon.dart';
import '../../ui/text.dart';
import '../../state/session_controller.dart';

class AssignmentTile extends StatelessWidget {
  const AssignmentTile(
    this.item, {
    super.key,
    this.compact = false,
    this.conflict = false,
  });

  final Deployment item;
  final bool compact;
  final bool conflict;

  @override
  Widget build(BuildContext context) {
    final info = context.watch<SessionController>().info!;
    if (!info.can('view:projects')) {
      return _card(context, item.projectId);
    }

    final request = api_models.ProjectsGetInput(id: item.projectId);

    return QueryView(
      requestKey: ApiQueries.projectsGet.path,
      identity: request,
      load: (session) {
        return session.read(ApiQueries.projectsGet, request);
      },

      builder: (context, value, reload) {
        final project = Project(value);
        final title = project.id == item.projectId
            ? project.title
            : item.projectId;

        return _card(context, title);
      },
    );
  }

  Widget _card(BuildContext context, String title) {
    return Card(
      margin: const EdgeInsets.all(2),
      child: InkWell(
        onTap: () => _showDetails(context, title),
        child: Padding(
          padding: const EdgeInsets.all(8),
          child: _AssignmentContent(
            item: item,
            title: title,
            compact: compact,
            conflict: conflict,
          ),
        ),
      ),
    );
  }

  void _showDetails(BuildContext context, String title) {
    showDialog<void>(
      context: context,
      builder: (dialogContext) {
        return _AssignmentDetails(item: item, title: title, conflict: conflict);
      },
    );
  }
}

class _AssignmentContent extends StatelessWidget {
  const _AssignmentContent({
    required this.item,
    required this.title,
    required this.compact,
    required this.conflict,
  });

  final Deployment item;
  final String title;
  final bool compact;
  final bool conflict;

  @override
  Widget build(BuildContext context) {
    final locale = Localizations.localeOf(context).languageCode;
    final format = DateFormat.Hm(locale);
    final time = '${format.format(item.from)}–${format.format(item.to)}';
    final titleWidget = Text(
      title,
      maxLines: compact ? 2 : 4,
      overflow: TextOverflow.ellipsis,
    );

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: compact ? MainAxisSize.max : MainAxisSize.min,
      children: [
        Row(
          children: [
            Expanded(
              child: Text(
                time,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: Theme.of(context).textTheme.labelSmall,
              ),
            ),
            if (compact && conflict)
              const TablerIcon('alert-triangle', size: 16),
          ],
        ),
        if (compact) Expanded(child: titleWidget) else titleWidget,
        if (!compact && item.note != null) Text(item.note!),
        if (!compact && conflict) const TablerIcon('alert-triangle', size: 16),
      ],
    );
  }
}

class _AssignmentDetails extends StatelessWidget {
  const _AssignmentDetails({
    required this.item,
    required this.title,
    required this.conflict,
  });

  final Deployment item;
  final String title;
  final bool conflict;

  @override
  Widget build(BuildContext context) {
    final info = context.watch<SessionController>().info!;
    final locale = Localizations.localeOf(context).languageCode;
    final format = DateFormat.yMd(locale).add_Hm();
    final period = '${format.format(item.from)} – ${format.format(item.to)}';

    return AlertDialog(
      title: Text(title),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(period),
            if (conflict)
              Text(
                text(
                  context,
                  'Überschneidung mit einem weiteren Einsatz.',
                  'Overlaps another assignment.',
                ),
              ),
            if (item.note != null) Text(item.note!),
          ],
        ),
      ),
      actions: [
        if (info.can('view:projects'))
          TextButton(
            onPressed: () {
              Navigator.of(context).pop();
              context.go('/projects/${Uri.encodeComponent(item.projectId)}');
            },

            child: Text(text(context, 'Projekt öffnen', 'Open project')),
          ),
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: Text(text(context, 'Schließen', 'Close')),
        ),
      ],
    );
  }
}
