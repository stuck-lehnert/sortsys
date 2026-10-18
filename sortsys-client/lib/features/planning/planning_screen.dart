import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

import '../../api/generated/models.g.dart' as models;
import '../../domain/planning.dart';
import '../../state/session_controller.dart';
import '../../ui/text.dart';
import 'absence_editor.dart';
import 'deployment_editor.dart';
import 'planning_board.dart';
import 'planning_controller.dart';
import 'planning_controls.dart';
import 'planning_data.dart';
import 'planning_mode_controller.dart';
import 'planning_repository.dart';
import 'planning_state.dart';
import 'project_block_editor.dart';

export 'assignment_tile.dart' show AssignmentTile;

class PlanningScreen extends HookWidget {
  const PlanningScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final session = context.watch<SessionController>();
    final info = session.info;
    final binding = session.binding;
    final canViewAll = info?.can('view:projectDeployments') ?? false;
    final canViewUsers = info?.can('view:users') ?? false;
    final clock = useState(DateTime.now());
    final uri = GoRouterState.of(context).uri;
    final state = PlanningState(uri, today: clock.value);
    final range = state.range;
    final mode = useMemoized(PlanningModeController.new);
    final editorOpen = useRef(false);

    useEffect(() {
      final timer = Timer.periodic(const Duration(minutes: 1), (_) {
        clock.value = DateTime.now();
      });

      return timer.cancel;
    }, []);
    useEffect(() {
      unawaited(mode.restore());

      return mode.dispose;
    }, [mode]);
    useListenable(mode);

    final controller = useMemoized(() {
      final repository = PlanningRepository(
        identity: binding,
        currentUserId: info?.userId ?? '',
        canViewAll: canViewAll,
        canViewUsers: canViewUsers,
        read: session.read,
        isCurrent: () {
          final current = session.info;

          if (!session.authenticated ||
              session.binding != binding ||
              current == null) {
            return false;
          }

          return current.can('view:projectDeployments') == canViewAll &&
              current.can('view:users') == canViewUsers;
        },
      );

      return PlanningController(repository: repository, range: range);
    }, [binding, canViewAll, canViewUsers, range.from, range.toExclusive]);

    useEffect(() {
      if (info != null && session.authenticated) {
        unawaited(controller.refresh());
      }

      return controller.dispose;
    }, [controller]);
    useListenable(controller);

    if (info == null) {
      return const SizedBox.shrink();
    }

    final data = controller.data;
    final view = data == null
        ? null
        : PlanningViewData(
            data: data,
            state: state,
            rowMode: mode.mode,
            currentUserId: info.userId,
            currentUserName: info.displayName,
            canViewAll: canViewAll,
            unknownProject: text(
              context,
              'Unbekanntes Projekt',
              'Unknown project',
            ),
            unknownUser: text(context, 'Unbekannter Benutzer', 'Unknown user'),
          );
    final canEdit = info.can('manage:projectDeployments') && canViewAll;

    Future<void> openEditor({
      PlanningPreset? preset,
      PlannedDeployment? deployment,
    }) async {
      final currentView = view;
      final current = session.info;

      if (currentView == null ||
          !canEdit ||
          editorOpen.value ||
          !context.mounted ||
          session.binding != binding ||
          current?.can('manage:projectDeployments') != true ||
          current?.can('view:projectDeployments') != true) {
        return;
      }

      editorOpen.value = true;

      try {
        await showDeploymentEditor(
          context,
          view: currentView,
          preset: preset,
          deployment: deployment?.record,
        );
      } finally {
        editorOpen.value = false;
      }

      if (!context.mounted || session.binding != binding) {
        return;
      }

      await controller.reload();
    }

    Future<void> openAbsence() async {
      final currentView = view;

      if (currentView == null ||
          editorOpen.value ||
          !context.mounted ||
          !session.authenticated ||
          session.binding != binding) {
        return;
      }

      editorOpen.value = true;

      try {
        await showAbsenceEditor(context, view: currentView);
      } finally {
        editorOpen.value = false;
      }

      if (!context.mounted || session.binding != binding) {
        return;
      }

      await controller.reload();
    }

    Future<void> openBlock(
      models.ProjectsUnavailabilityListResultItem period,
    ) async {
      final currentView = view;
      final current = session.info;

      if (currentView == null ||
          !canEdit ||
          editorOpen.value ||
          !context.mounted ||
          !session.authenticated ||
          session.binding != binding ||
          current?.can('manage:projectDeployments') != true ||
          current?.can('view:projectDeployments') != true) {
        return;
      }

      editorOpen.value = true;

      try {
        await showProjectBlockEditor(
          context,
          view: currentView,
          baseline: period,
        );
      } finally {
        editorOpen.value = false;
      }

      if (!context.mounted || session.binding != binding) {
        return;
      }

      await controller.reload();
    }

    final headers = <Widget>[
      PlanningControls(
        state: state,
        today: startOfDay(clock.value),
        rowMode: mode.mode,
        canManageAbsences: info.can('manage:userVacations'),
        onAbsence: session.authenticated && view != null && !controller.loading
            ? () {
                unawaited(openAbsence());
              }
            : null,
        onCreate: canEdit && view != null && !controller.loading
            ? () {
                unawaited(openEditor());
              }
            : null,
        summary: controller.loading || view == null
            ? null
            : _PlanningSummary(view: view),
        onLocation: (change) {
          if (!session.authenticated || session.binding != binding) {
            return;
          }

          final router = GoRouter.of(context);
          final currentUri = router.routeInformationProvider.value.uri;
          final current = PlanningState(currentUri, today: clock.value);
          final next = change(current);

          unawaited(router.replace<void>(next.toString()));
        },
        onRowMode: (value) {
          unawaited(mode.select(value));
        },
      ),
    ];

    if (!canViewAll) {
      headers.add(
        Text(
          text(
            context,
            'Du siehst deine eigenen Einsätze.',
            'You see your own assignments.',
          ),
          style: SsTheme.of(
            context,
          ).body.copyWith(color: SsTheme.of(context).secondaryText),
        ),
      );
    }

    if (mode.error != null) {
      headers.add(
        Semantics(
          liveRegion: true,
          child: Text(
            text(
              context,
              'Die Zeilenansicht konnte nicht geladen oder gespeichert werden.',
              'Could not load or save the row view.',
            ),
            style: SsTheme.of(context).label,
          ),
        ),
      );
    }

    final loadError = controller.error;
    final failures = controller.failures;

    if (loadError != null || failures.isNotEmpty) {
      final error = loadError ?? failures.values.first;
      headers.add(
        _PlanningFailure(
          error: error,
          onRetry: () {
            unawaited(controller.reload());
          },
        ),
      );
    }

    Widget board;

    if (controller.loading) {
      board = Center(
        child: SsSpinner(
          label: text(
            context,
            'Einsatzplanung wird geladen …',
            'Loading resource planning …',
          ),
        ),
      );
    } else if (view == null ||
        (failures.containsKey(PlanningSource.deployments) &&
            view.data.deployments.isEmpty)) {
      board = Center(
        child: Text(
          text(
            context,
            'Einsätze sind derzeit nicht verfügbar.',
            'Assignments are currently unavailable.',
          ),
        ),
      );
    } else {
      board = PlanningBoard(
        key: ValueKey((binding, state.view, mode.mode, range.from)),
        view: view,
        today: startOfDay(clock.value),
        onCreate: canEdit
            ? (preset) {
                unawaited(openEditor(preset: preset));
              }
            : null,
        onEdit: canEdit
            ? (deployment) {
                unawaited(openEditor(deployment: deployment));
              }
            : null,
        onEditBlock: canEdit
            ? (period) {
                unawaited(openBlock(period));
              }
            : null,
      );
    }

    final headerChildren = <Widget>[];

    for (final header in headers) {
      headerChildren.add(header);
      headerChildren.add(const SizedBox(height: 5.6));
    }

    return LayoutBuilder(
      builder: (context, constraints) {
        final scale = MediaQuery.textScalerOf(context).scale(16) / 16;

        if (scale > 1.4 || constraints.maxHeight < 420) {
          final boardHeight = math.max(260.0, constraints.maxHeight * 0.7);

          return SingleChildScrollView(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                ...headerChildren,
                SizedBox(height: boardHeight, child: board),
              ],
            ),
          );
        }

        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            ...headerChildren,
            Expanded(child: board),
          ],
        );
      },
    );
  }
}

class _PlanningFailure extends StatelessWidget {
  const _PlanningFailure({required this.error, required this.onRetry});

  final Object error;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final colors = SsTheme.of(context);

    return Semantics(
      liveRegion: true,
      child: Container(
        padding: const EdgeInsets.all(8),
        decoration: BoxDecoration(border: Border.all(color: colors.danger)),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              text(
                context,
                'Einsatzplanung konnte nicht vollständig geladen werden',
                'Resource planning could not be loaded completely',
              ),
              style: colors.label.copyWith(color: colors.danger),
            ),
            const SizedBox(height: 5.6),
            Text(errorText(context, error), style: colors.body),
            const SizedBox(height: 5.6),
            SsButton(
              size: SsButtonSize.small,
              kind: SsButtonKind.secondary,
              onPressed: onRetry,
              child: Text(text(context, 'Erneut versuchen', 'Try again')),
            ),
          ],
        ),
      ),
    );
  }
}

class _PlanningSummary extends StatelessWidget {
  const _PlanningSummary({required this.view});

  final PlanningViewData view;

  @override
  Widget build(BuildContext context) {
    final first = view.state.range.from;
    final last = view.state.visibleEndExclusive;
    final users = <String>{};
    var absenceCount = 0;

    for (final deployment in view.deployments) {
      if (periodsOverlap(deployment.from, deployment.to, first, last)) {
        users.add(deployment.record.userId);
      }
    }

    for (final absence in view.data.absences) {
      if (planningPeriodOverlaps(absence.from, absence.to, first, last)) {
        absenceCount++;
      }
    }

    final rowLabel = view.rowMode == PlanningRowMode.project
        ? text(context, 'Projekte', 'projects')
        : text(context, 'Mitarbeitende', 'employees');
    final metrics = <(int, String)>[
      (view.rows.length, rowLabel),
      (users.length, text(context, 'eingeplant', 'assigned')),
      if (absenceCount > 0)
        (absenceCount, text(context, 'Abwesenheiten', 'absences')),
    ];
    final colors = SsTheme.of(context);
    final children = <Widget>[];

    for (final metric in metrics) {
      final first = children.isEmpty;
      children.add(
        Container(
          padding: EdgeInsets.only(left: first ? 0 : 8.8),
          decoration: BoxDecoration(
            border: first
                ? null
                : Border(left: BorderSide(color: colors.border)),
          ),
          child: Text.rich(
            TextSpan(
              children: [
                TextSpan(
                  text: metric.$1.toString(),
                  style: TextStyle(
                    color: colors.text,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                TextSpan(text: ' ${metric.$2}'),
              ],
            ),
            style: colors.body.copyWith(
              fontSize: 13.12,
              color: colors.secondaryText,
            ),
          ),
        ),
      );
    }

    return Semantics(
      liveRegion: true,
      child: Wrap(spacing: 5.6, runSpacing: 5.6, children: children),
    );
  }
}
