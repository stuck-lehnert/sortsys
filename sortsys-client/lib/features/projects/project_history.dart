import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

import '../../api/generated/api.g.dart';
import '../../api/generated/models.g.dart' as api_models;
import '../../api/model.dart';
import '../../state/session_controller.dart';
import '../../ui/query_view.dart';
import '../../ui/text.dart';

api_models.PersonalizationActivityListInput projectActivityInput(
  String projectId, {
  String? cursor,
  api_models.ActivityResourceType resourceType =
      api_models.ActivityResourceType.project,
}) {
  return RpcOptional.value(
    api_models.PersonalizationActivityListRequest(
      limit: const RpcOptional.value(50),
      resourceType: RpcOptional.value(resourceType),
      resourceId: RpcOptional.value(projectId),
      includeProjectContext: RpcOptional.value(
        resourceType == api_models.ActivityResourceType.project,
      ),
      cursor: cursor == null
          ? const RpcOptional.absent()
          : RpcOptional.value(cursor),
    ),
  );
}

class ProjectRemarks extends StatelessWidget {
  const ProjectRemarks({
    super.key,
    required this.projectId,
    this.resourceType = api_models.RemarksListRequestResourceType.project,
  });

  final String projectId;
  final api_models.RemarksListRequestResourceType resourceType;

  @override
  Widget build(BuildContext context) {
    final input = api_models.RemarksListInput(
      resourceType: resourceType,
      resourceId: projectId,
    );

    return QueryView<List<api_models.RemarksListResultItem>>(
      requestKey: ApiQueries.remarksList.path,
      identity: input,
      load: (session) {
        return session.read(ApiQueries.remarksList, input);
      },

      builder: (context, rows, reload) {
        final ordered = [...rows];
        ordered.sort((a, b) {
          return b.createdAt.compareTo(a.createdAt);
        });

        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              text(context, 'Vermerke', 'Notes'),
              style: SsTheme.of(context).label,
            ),
            const SizedBox(height: 12),
            if (ordered.isEmpty)
              Text(
                text(
                  context,
                  'Keine Vermerke vorhanden.',
                  'No notes available.',
                ),
              ),
            for (final remark in ordered)
              Padding(
                padding: const EdgeInsets.only(bottom: 12),
                child: SsSurface(
                  child: Padding(
                    padding: const EdgeInsets.all(12),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          ssDateText(remark.createdAt),
                          style: SsTheme.of(context).label,
                        ),
                        const SizedBox(height: 6),
                        Text(remark.body),
                      ],
                    ),
                  ),
                ),
              ),
          ],
        );
      },

    );
  }

}

class ProjectActivity extends StatefulWidget {
  const ProjectActivity({
    super.key,
    required this.projectId,
    this.resourceType = api_models.ActivityResourceType.project,
  });

  final String projectId;
  final api_models.ActivityResourceType resourceType;

  @override
  State<ProjectActivity> createState() {
    return _ProjectActivityState();
  }

}

class _ProjectActivityState extends State<ProjectActivity> {
  final List<api_models.ResourceActivity> _older = [];
  bool _expanded = false;
  bool _loading = false;
  bool _complete = false;
  Object? _error;

  Future<void> _loadOlder(String cursor) async {
    if (_loading || _complete) {
      return;
    }

    final session = context.read<SessionController>();
    final binding = session.binding;
    final projectId = widget.projectId;
    final resourceType = widget.resourceType;
    final input = projectActivityInput(
      projectId,
      cursor: cursor,
      resourceType: resourceType,
    );

    setState(() {
      _loading = true;
      _error = null;
    });

    try {
      final page = await session.read(
        ApiQueries.personalizationActivityList,
        input,
      );

      if (!mounted ||
          session.binding != binding ||
          widget.projectId != projectId ||
          widget.resourceType != resourceType) {
        return;
      }

      setState(() {
        _older.addAll(page);
        _complete = page.length < 50;
      });

    } catch (error) {
      if (mounted &&
          session.binding == binding &&
          widget.projectId == projectId &&
          widget.resourceType == resourceType) {
        setState(() {
          _error = error;
        });

      }

    } finally {
      if (mounted &&
          session.binding == binding &&
          widget.projectId == projectId &&
          widget.resourceType == resourceType) {
        setState(() {
          _loading = false;
        });

      }

    }

  }

  @override
  Widget build(BuildContext context) {
    final input = projectActivityInput(
      widget.projectId,
      resourceType: widget.resourceType,
    );

    return QueryView<List<api_models.ResourceActivity>>(
      requestKey: ApiQueries.personalizationActivityList.path,
      identity: input,
      load: (session) {
        return session.read(ApiQueries.personalizationActivityList, input);
      },

      builder: (context, rows, reload) {
        final unique = <String, api_models.ResourceActivity>{};

        for (final row in [...rows, ..._older]) {
          unique[row.id] = row;
        }

        final all = unique.values.toList(growable: false);
        final visible = _expanded ? all : all.take(6);
        final locale = Localizations.localeOf(context).languageCode;
        final format = DateFormat.yMd(locale).add_Hm();

        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              text(
                context,
                'Aktivität (${all.length})',
                'Activity (${all.length})',
              ),
              style: SsTheme.of(context).label,
            ),
            const SizedBox(height: 12),
            if (all.isEmpty)
              Text(
                text(
                  context,
                  'Noch keine Aktivität vorhanden.',
                  'No activity yet.',
                ),
              ),
            for (final item in visible)
              Padding(
                padding: const EdgeInsets.only(bottom: 12),
                child: SsSurface(
                  child: SsListTile(
                    title: Text(item.resourceTitle ?? item.title),
                    subtitle: Text(
                      [
                        format.format(item.occurredAt.toLocal()),
                        item.actorName,
                        item.description,
                      ].whereType<String>().join(' · '),
                    ),
                  ),
                ),
              ),
            if (all.length > 6)
              SsButton(
                kind: SsButtonKind.ghost,
                onPressed: () {
                  setState(() {
                    _expanded = !_expanded;
                  });

                },

                child: Text(
                  _expanded
                      ? text(context, 'Weniger anzeigen', 'Show less')
                      : text(context, 'Alle anzeigen', 'Show all'),
                ),
              ),
            if (_expanded && !_complete && rows.length >= 50 && all.isNotEmpty)
              SsButton(
                kind: SsButtonKind.secondary,
                onPressed: _loading
                    ? null
                    : () {
                        unawaited(_loadOlder(all.last.id));
                      },

                child: Text(
                  text(
                    context,
                    'Ältere Aktivitäten laden',
                    'Load older activity',
                  ),
                ),
              ),
            if (_loading) const Center(child: SsSpinner()),
            if (_error != null)
              Text(
                text(
                  context,
                  'Ältere Aktivitäten konnten nicht geladen werden.',
                  'Older activities could not be loaded.',
                ),
              ),
          ],
        );
      },

    );
  }

}
