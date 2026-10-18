import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

import '../../api/generated/api.g.dart';
import '../../api/generated/models.g.dart' as api_models;
import '../../api/model.dart';
import '../../domain/models.dart';
import '../../state/session_controller.dart';
import '../../ui/query_view.dart';
import '../../ui/tabler_icon.dart';
import '../../ui/text.dart';
import '../entities/catalog.dart';

class HomeScreen extends StatelessWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final info = context.watch<SessionController>().info!;

    const request = RpcOptional.value(
      api_models.PersonalizationActivityListRequest(
        limit: RpcOptional.value(25),
        latestPerResource: RpcOptional.value(true),
      ),
    );

    return ListView(
      padding: EdgeInsets.zero,
      children: [
        Text(
          text(context, 'Übersicht', 'Overview'),
          style: SsTheme.of(context).heading,
        ),
        const SizedBox(height: 8),
        Text(info.displayName),
        const SizedBox(height: 24),
        _WorkspaceCards(info: info),
        const SizedBox(height: 24),
        Text(
          text(context, 'Letzte Aktivitäten', 'Recent activity'),
          style: Theme.of(context).textTheme.titleLarge,
        ),
        const SizedBox(height: 12),
        SizedBox(
          height: 420,
          child: QueryView(
            requestKey: ApiQueries.personalizationActivityList.path,
            identity: request,
            load: (session) {
              return session.read(
                ApiQueries.personalizationActivityList,
                request,
              );
            },

            builder: (context, value, reload) {
              return _ActivityList(rows: value, onReload: reload);
            },
          ),
        ),
      ],
    );
  }
}

class _WorkspaceCards extends StatelessWidget {
  const _WorkspaceCards({required this.info});

  final SessionInfo info;

  @override
  Widget build(BuildContext context) {
    final available = entityCatalog.where((spec) {
      return info.can(spec.role);
    });

    return Wrap(
      spacing: 12,
      runSpacing: 12,
      children: [
        _WorkspaceCard(
          title: text(context, 'Einsatzplanung', 'Resource planning'),
          subtitle: text(context, 'Tag und Woche', 'Day and week'),
          icon: 'calendar',
          path: '/planning',
        ),
        for (final spec in available)
          _WorkspaceCard(
            title: text(context, spec.de, spec.en),
            icon: spec.icon,
            path: '/${spec.key}',
          ),
      ],
    );
  }
}

class _WorkspaceCard extends StatelessWidget {
  const _WorkspaceCard({
    required this.title,
    required this.icon,
    required this.path,
    this.subtitle,
  });

  final String title;
  final String icon;
  final String path;
  final String? subtitle;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: 230,
      child: SsSurface(
        child: SsListTile(
          leading: TablerIcon(icon),
          title: Text(title),
          subtitle: subtitle == null ? null : Text(subtitle!),
          onTap: () {
            context.go(path);
          },
        ),
      ),
    );
  }
}

class _ActivityList extends StatelessWidget {
  const _ActivityList({required this.rows, required this.onReload});

  final List<api_models.ResourceActivity> rows;
  final VoidCallback onReload;

  @override
  Widget build(BuildContext context) {
    if (rows.isEmpty) {
      return Center(
        child: Text(
          text(context, 'Keine Aktivitäten vorhanden.', 'No activity yet.'),
        ),
      );
    }

    return RefreshIndicator(
      onRefresh: () async {
        onReload();
      },

      child: ListView.builder(
        itemCount: rows.length,
        itemBuilder: (context, index) {
          return _ActivityRow(row: rows[index]);
        },
      ),
    );
  }
}

class _ActivityRow extends StatelessWidget {
  const _ActivityRow({required this.row});

  final api_models.ResourceActivity row;

  @override
  Widget build(BuildContext context) {
    final locale = Localizations.localeOf(context).languageCode;
    final title = row.resourceTitle ?? row.title;
    final occurred = DateFormat.yMd(
      locale,
    ).add_Hm().format(row.occurredAt.toLocal());
    final details = [
      row.description,
      row.actorName,
      occurred,
    ].whereType<String>().join(' · ');

    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: SsSurface(
        child: SsListTile(title: Text(title), subtitle: Text(details)),
      ),
    );
  }
}
