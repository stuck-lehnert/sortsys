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
import '../entities/entity_presentation.dart';

const projectReportPageSizes = [25, 50, 100];

models.RegieReportsListInput projectRegieReportsInput(String projectId) {
  return models.RegieReportsListInput(
    projectId: RpcOptional.value(projectId),
  );
}

final class ProjectReportPage {
  const ProjectReportPage({this.page = 0, this.pageSize = 25});

  final int page;
  final int pageSize;

  factory ProjectReportPage.fromUri(Uri uri) {
    final page = int.tryParse(uri.queryParameters['pageRegieReports'] ?? '');
    final size = int.tryParse(uri.queryParameters['pageSizeRegieReports'] ?? '');

    return ProjectReportPage(
      page: math.max(0, page ?? 0),
      pageSize: projectReportPageSizes.contains(size) ? size! : 25,
    );
  }

  Uri apply(Uri uri, {int? page, int? pageSize}) {
    final parameters = {
      for (final entry in uri.queryParametersAll.entries)
        entry.key: List<String>.of(entry.value),
    };
    final nextPage = page ?? this.page;
    final nextSize = pageSize ?? this.pageSize;
    parameters.remove('pageRegieReports');
    parameters.remove('pageSizeRegieReports');

    if (nextPage > 0) {
      parameters['pageRegieReports'] = ['$nextPage'];
    }

    if (projectReportPageSizes.contains(nextSize) && nextSize != 25) {
      parameters['pageSizeRegieReports'] = ['$nextSize'];
    }

    return uri.replace(queryParameters: parameters);
  }
}

typedef ProjectReportWeek = ({DateTime start, DateTime end, int year, int number});

ProjectReportWeek projectReportWeek(DateTime value) {
  final local = value.toLocal();
  final start = DateTime(local.year, local.month, local.day - local.weekday + 1);
  final end = DateTime(start.year, start.month, start.day + 6);
  final thursday = DateTime(start.year, start.month, start.day + 3);
  final januaryFourth = DateTime(thursday.year, 1, 4);
  final firstMonday = DateTime(
    januaryFourth.year,
    januaryFourth.month,
    januaryFourth.day - januaryFourth.weekday + 1,
  );
  final ordinal = DateTime.utc(start.year, start.month, start.day);
  final firstOrdinal = DateTime.utc(
    firstMonday.year, firstMonday.month, firstMonday.day,
  );
  final number = 1 + ordinal.difference(firstOrdinal).inDays ~/ 7;

  return (start: start, end: end, year: thursday.year, number: number);
}

class ProjectRegieReports extends HookWidget {
  const ProjectRegieReports({super.key, required this.projectId});

  final String projectId;

  @override
  Widget build(BuildContext context) {
    final session = context.watch<SessionController>();
    final binding = session.binding;
    final uri = GoRouterState.of(context).uri;
    final state = ProjectReportPage.fromUri(uri);
    final revision = useState(0);
    final allowed = session.authenticated &&
        session.info?.can('view:projects') == true &&
        session.info?.can('view:regieReports') == true;
    final request = useMemoized(() {
      if (!allowed) {
        return null;
      }

      return () async {
        final rows = await session.read(
          ApiQueries.regieReportsList,
          projectRegieReportsInput(projectId),
        );

        if (!session.authenticated || session.binding != binding ||
            session.info?.can('view:projects') != true ||
            session.info?.can('view:regieReports') != true) {
          throw StateError('PROJECT_REPORT_SCOPE_CHANGED');
        }

        if (rows.any((report) {
          return report.projectId != projectId;
        })) {
          throw const FormatException('PROJECT_REPORT_RESPONSE_MISMATCH');
        }

        return rows;
      }();
    }, [binding, projectId, allowed, revision.value]);
    final snapshot = useFuture(request, preserveState: false);

    if (!allowed) {
      return const EntityAccessDenied();
    }

    return ProjectRegieReportRows(
      rows: snapshot.data ?? const [],
      state: state,
      uri: uri,
      loading: snapshot.connectionState != ConnectionState.done,
      error: snapshot.error,
      onRetry: () {
        revision.value++;
      },
      onStateChanged: (next) {
        context.go(next.toString());
      },
      onSelected: (report) {
        context.go('/regieReports/${Uri.encodeComponent(report.id)}');
      },
    );
  }
}

class ProjectRegieReportRows extends StatelessWidget {
  const ProjectRegieReportRows({
    super.key,
    required this.rows,
    required this.state,
    required this.uri,
    required this.onStateChanged,
    required this.onSelected,
    this.loading = false,
    this.error,
    this.onRetry,
  });

  final List<models.RegieReport> rows;
  final ProjectReportPage state;
  final Uri uri;
  final ValueChanged<Uri> onStateChanged;
  final ValueChanged<models.RegieReport> onSelected;
  final bool loading;
  final Object? error;
  final VoidCallback? onRetry;

  Widget _state(BuildContext context) {
    if (error != null) {
      return Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(text(context, 'Einträge konnten nicht geladen werden.',
              'Entries could not be loaded.')),
          if (onRetry != null) ...[
            const SizedBox(height: 8),
            SsButton(
              kind: SsButtonKind.secondary,
              onPressed: onRetry,
              child: Text(text(context, 'Erneut laden', 'Reload')),
            ),
          ],
        ],
      );
    }

    if (loading) {
      return Wrap(
        spacing: 8,
        crossAxisAlignment: WrapCrossAlignment.center,
        children: [
          const SsSpinner(),
          Text(text(context, 'Einträge werden geladen …', 'Loading entries …')),
        ],
      );
    }

    return Text(text(context, 'Keine Einträge vorhanden.', 'No entries available.'));
  }

  @override
  Widget build(BuildContext context) {
    final lastPage = math.max(0, (rows.length - 1) ~/ state.pageSize);
    final page = state.page.clamp(0, lastPage).toInt();
    final visible = loading || error != null
        ? const <models.RegieReport>[]
        : rows.skip(page * state.pageSize).take(state.pageSize);
    final colors = SsTheme.of(context);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (!loading && error == null && rows.isNotEmpty) ...[
          SsPagination(
            totalItems: rows.length,
            page: page + 1,
            pageSize: state.pageSize,
            pageSizes: projectReportPageSizes,
            backwardText: text(context, 'Zurück', 'Previous'),
            forwardText: text(context, 'Weiter', 'Next'),
            itemsPerPageText: text(context, 'Zeilen pro Seite', 'Rows per page'),
            itemRangeText: (first, last, total) {
              return text(context, 'Zeile $first–$last von $total',
                  'Rows $first–$last of $total');
            },
            pageRangeText: (current, total) {
              return text(context, 'Seite $current von $total',
                  'Page $current of $total');
            },
            onPage: (page) {
              onStateChanged(state.apply(uri, page: page - 1));
            },
            onPageSize: (size) {
              onStateChanged(state.apply(uri, page: 0, pageSize: size));
            },
          ),
          const SizedBox(height: 8),
        ],
        DecoratedBox(
          decoration: BoxDecoration(
            color: colors.surface.withValues(alpha: 0.2),
            border: Border.all(color: colors.border),
          ),
          child: Padding(
            padding: const EdgeInsets.all(9),
            child: visible.isEmpty
                ? Semantics(liveRegion: true, child: _state(context))
                : Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      for (final report in visible)
                        Padding(
                          key: ValueKey(report.id),
                          padding: const EdgeInsets.only(bottom: 8),
                          child: ProjectRegieReportCard(
                            report: report, onSelected: onSelected,
                          ),
                        ),
                    ],
                  ),
          ),
        ),
      ],
    );
  }
}

class ProjectRegieReportCard extends StatelessWidget {
  const ProjectRegieReportCard({
    super.key, required this.report, required this.onSelected,
  });

  final models.RegieReport report;
  final ValueChanged<models.RegieReport> onSelected;

  @override
  Widget build(BuildContext context) {
    final week = projectReportWeek(report.day);
    final german = Localizations.localeOf(context).languageCode == 'de';
    final date = DateFormat(german ? 'dd.MM.yyyy' : 'MM/dd/yyyy');
    final start = date.format(week.start);
    final end = date.format(week.end);
    final location = '/regieReports/${Uri.encodeComponent(report.id)}';

    return SsSurface(
      padding: const EdgeInsets.all(9.6),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          DefaultTextStyle(
            style: SsTheme.of(context).body.copyWith(fontWeight: FontWeight.w600),
            child: SsLink(
              uri: Uri.parse(location),
              onPressed: () {
                onSelected(report);
              },
              child: Text(
                text(context, 'Regiebericht #${report.autoId}',
                    'Time-and-material report #${report.autoId}'),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
            ),
          ),
          SsAttributeList(children: [
            SsAttribute(
              label: 'Kalenderwoche',
              child: Text('KW ${week.number}/${week.year}'),
            ),
            SsAttribute(
              label: text(context, 'Zeitraum', 'Period'),
              child: Text(text(context, '$start bis $end', '$start to $end')),
            ),
            if (report.summary?.isNotEmpty == true)
              SsAttribute(label: 'Zusammenfassung', child: Text(report.summary!)),
            SsAttribute(
              label: text(context, 'Arbeitszeit', 'Working time'),
              child: Text(text(context, '${report.workHours.length} Einträge',
                  '${report.workHours.length} entries')),
            ),
            SsAttribute(
              label: text(context, 'Produkte', 'Products'),
              child: Text(text(context, '${report.products.length} Einträge',
                  '${report.products.length} entries')),
            ),
          ]),
        ],
      ),
    );
  }
}
