import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

import '../../api/generated/models.g.dart' as models;
import '../../domain/planning.dart';
import '../../ui/text.dart';
import 'planning_data.dart';
import 'planning_state.dart';
import 'planning_view.dart';

final class PlanningPreset {
  const PlanningPreset({required this.day, this.userId, this.projectId});

  final DateTime day;
  final String? userId;
  final String? projectId;
}

class PlanningBoard extends StatefulWidget {
  const PlanningBoard({
    super.key,
    required this.view,
    required this.today,
    this.onCreate,
    this.onEdit,
    this.onEditBlock,
  });

  final PlanningViewData view;
  final DateTime today;
  final ValueChanged<PlanningPreset>? onCreate;
  final ValueChanged<PlannedDeployment>? onEdit;
  final ValueChanged<models.ProjectsUnavailabilityListResultItem>? onEditBlock;

  @override
  State<PlanningBoard> createState() {
    return _PlanningBoardState();
  }
}

class _PlanningBoardState extends State<PlanningBoard> {
  final _horizontal = ScrollController(keepScrollOffset: false);
  final _vertical = ScrollController(keepScrollOffset: false);

  @override
  void dispose() {
    _horizontal.dispose();
    _vertical.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final colors = SsTheme.of(context);

    return DecoratedBox(
      decoration: BoxDecoration(border: Border.all(color: colors.border)),
      child: widget.view.state.view == PlanningView.day
          ? _dayBoard(context)
          : _weekBoard(context),
    );
  }

  Widget _weekBoard(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final colors = SsTheme.of(context);
        final view = widget.view;
        final days = view.state.days;
        final heading = view.rowMode == PlanningRowMode.project
            ? text(context, 'Projekt', 'Project')
            : text(context, 'Benutzer', 'User');
        final compact = MediaQuery.sizeOf(context).width <= 896;
        final labelLimit = compact ? 152.0 : 224.0;
        var labelWidth = _measure(context, heading, colors.body).width + 8;

        for (final row in [...view.rows, ...view.absenceRows]) {
          final width =
              _measure(
                context,
                row.label,
                colors.body.copyWith(
                  fontSize: 13.12,
                  fontWeight: FontWeight.w600,
                ),
              ).width +
              8;
          labelWidth = math.max(labelWidth, width);
        }

        labelWidth = labelWidth.clamp(56.0, labelLimit).toDouble();
        final timeWidth = _measure(
          context,
          '00:00-23:59',
          _timeStyle(colors),
        ).width;
        final actionWidth = widget.onCreate == null ? 0.0 : 24.0;
        final minimumDay = math.max(108.0, timeWidth + 28 + actionWidth);
        final width = math.max(
          constraints.maxWidth,
          labelWidth + days.length * minimumDay,
        );
        final dayWidth = (width - labelWidth) / days.length;
        final headerHeight = _headerHeight(context, days, dayWidth);
        final header = _rowShell(
          context,
          labelWidth: labelWidth,
          label: heading,
          header: true,
          child: SizedBox(
            height: headerHeight,
            child: Row(
              children: [
                SizedBox(width: labelWidth),
                for (final day in days)
                  SizedBox(width: dayWidth, child: _dayHeading(context, day)),
              ],
            ),
          ),
        );
        final rows = <Widget>[];

        if (view.rows.isEmpty) {
          rows.add(
            Padding(
              padding: const EdgeInsets.all(13.6),
              child: Text(
                view.state.normalizedSearch.isEmpty
                    ? text(
                        context,
                        'Keine Einsätze im gewählten Zeitraum.',
                        'No assignments in the selected period.',
                      )
                    : text(
                        context,
                        'Keine passenden Einträge.',
                        'No matching entries.',
                      ),
              ),
            ),
          );
        }

        for (final row in view.rows) {
          rows.add(_weekRow(context, row, days, labelWidth, dayWidth));
        }

        if (view.absenceRows.isNotEmpty) {
          rows.add(
            Container(
              color: colors.mutedSurface,
              padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 7.2),
              child: Text(
                text(context, 'Abwesenheiten', 'Absences').toUpperCase(),
                style: colors.label.copyWith(
                  fontSize: 12,
                  fontWeight: FontWeight.w700,
                  letterSpacing: 0.64,
                ),
              ),
            ),
          );

          for (final row in view.absenceRows) {
            rows.add(
              _weekRow(
                context,
                row,
                days,
                labelWidth,
                dayWidth,
                absenceOnly: true,
              ),
            );
          }

        }

        return Scrollbar(
          controller: _vertical,
          notificationPredicate: (notification) {
            return notification.metrics.axis == Axis.vertical;
          },
          child: Scrollbar(
            controller: _horizontal,
            notificationPredicate: (notification) {
              return notification.metrics.axis == Axis.horizontal;
            },
            child: SingleChildScrollView(
              controller: _horizontal,
              scrollDirection: Axis.horizontal,
              child: SizedBox(
                width: width,
                height: constraints.maxHeight,
                child: CustomScrollView(
                  controller: _vertical,
                  key: ValueKey((
                    view.data.identity,
                    view.state.range.from,
                    view.rowMode,
                  )),
                  slivers: [
                    SliverPersistentHeader(
                      pinned: true,
                      delegate: _PlanningHeader(headerHeight, header),
                    ),
                    SliverToBoxAdapter(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: rows,
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        );
      },
    );
  }

  Widget _weekRow(
    BuildContext context,
    PlanningRow row,
    List<DateTime> days,
    double labelWidth,
    double dayWidth, {
    bool absenceOnly = false,
  }) {
    final colors = SsTheme.of(context);
    final background = absenceOnly
        ? Color.lerp(colors.surface, colors.accent, 0.05)!
        : colors.mutedSurface;
    final cells = <Widget>[SizedBox(width: labelWidth)];

    for (final day in days) {
      final end = shiftDay(day, 1);
      final cell = widget.view.cell(row.id, day, end, absenceOnly: absenceOnly);
      final today = _sameDay(day, widget.today);
      final fill = today
          ? Color.lerp(colors.surface, colors.accent, 0.1)!
          : (absenceOnly ? background : colors.surface);
      final side = today
          ? Color.lerp(colors.border, colors.strongAccent, 0.55)!
          : colors.border;

      cells.add(
        Container(
          width: dayWidth,
          padding: const EdgeInsets.all(4),
          decoration: BoxDecoration(
            color: fill,
            border: Border(
              top: BorderSide(color: colors.border),
              left: BorderSide(color: side),
            ),
          ),
          child: _cell(
            context,
            row,
            cell,
            day,
            end,
            week: true,
            absenceOnly: absenceOnly,
          ),
        ),
      );
    }

    return KeyedSubtree(
      key: ValueKey((absenceOnly, row.id)),
      child: _rowShell(
        context,
        labelWidth: labelWidth,
        label: row.label,
        background: background,
        child: IntrinsicHeight(
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: cells,
          ),
        ),
      ),
    );
  }

  Widget _rowShell(
    BuildContext context, {
    required double labelWidth,
    required String label,
    required Widget child,
    bool header = false,
    Color? background,
  }) {
    final colors = SsTheme.of(context);

    return Stack(
      clipBehavior: Clip.none,
      children: [
        child,
        Positioned(
          left: 0,
          top: 0,
          bottom: 0,
          width: labelWidth,
          child: AnimatedBuilder(
            animation: _horizontal,
            builder: (context, child) {
              final offset = _horizontal.hasClients ? _horizontal.offset : 0.0;

              return Transform.translate(
                offset: Offset(offset, 0),
                child: child,
              );
            },
            child: Container(
              padding: const EdgeInsets.all(4),
              decoration: BoxDecoration(
                color: background ?? colors.mutedSurface,
                border: Border(
                  top: BorderSide(
                    color: header ? Colors.transparent : colors.border,
                  ),
                ),
              ),
              child: Semantics(
                header: header,
                child: Tooltip(
                  message: label,
                  child: Text(
                    label,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: colors.body.copyWith(
                      fontSize: header ? 16 : 13.12,
                      fontWeight: header ? FontWeight.w700 : FontWeight.w600,
                      height: header ? 1.2 : 1.3,
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ],
    );
  }

  Widget _dayBoard(BuildContext context) {
    final view = widget.view;
    final from = view.state.range.from;
    final to = view.state.range.toExclusive;

    if (view.rows.isEmpty) {
      return SingleChildScrollView(
        child: Padding(
          padding: const EdgeInsets.all(13.6),
          child: Text(
            text(
              context,
              'Keine Einsätze im gewählten Zeitraum.',
              'No assignments in the selected period.',
            ),
          ),
        ),
      );
    }

    return ListView.builder(
      controller: _vertical,
      itemCount: view.rows.length,
      itemBuilder: (context, index) {
        final row = view.rows[index];
        final cell = view.cell(row.id, from, to);
        final colors = SsTheme.of(context);
        final create = widget.onCreate;
        final heading = Row(
          children: [
            Expanded(
              child: Text(
                row.label,
                style: colors.body.copyWith(fontWeight: FontWeight.w600),
              ),
            ),
            if (create != null)
              SsIconButton(
                icon: 'plus',
                label: text(context, 'Einsatz hinzufügen', 'Add assignment'),
                onPressed: () {
                  create(_preset(row.id, from));
                },
              ),
          ],
        );
        final contents = _cell(context, row, cell, from, to, week: false);

        return Container(
          padding: const EdgeInsets.all(6.4),
          decoration: BoxDecoration(
            border: index == 0
                ? null
                : Border(top: BorderSide(color: colors.border)),
          ),
          child: LayoutBuilder(
            builder: (context, constraints) {
              if (MediaQuery.sizeOf(context).width <= 896) {
                return Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [heading, const SizedBox(height: 8), contents],
                );
              }

              final labelWidth = (constraints.maxWidth * 0.25)
                  .clamp(192.0, 256.0)
                  .toDouble();

              return Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  SizedBox(width: labelWidth, child: heading),
                  const SizedBox(width: 8),
                  Expanded(child: contents),
                ],
              );
            },
          ),
        );
      },
    );
  }

  Widget _cell(
    BuildContext context,
    PlanningRow row,
    PlanningCell cell,
    DateTime from,
    DateTime to, {
    required bool week,
    bool absenceOnly = false,
  }) {
    final colors = SsTheme.of(context);
    final create = absenceOnly ? null : widget.onCreate;
    final children = <Widget>[];

    for (final absence in cell.absences) {
      final label = planningAbsenceLabel(context, absence);
      final title = [
        label,
        row.label,
        '${_date(context, absence.from)} - ${_date(context, absence.to)}',
        if (absence.note != null) absence.note!,
      ].join('\n');
      children.add(
        _marker(
          context,
          label,
          title,
          Color.lerp(colors.surface, colors.accent, 0.14)!,
        ),
      );
    }

    for (final block in cell.blocks) {
      final label = text(
        context,
        'Gesperrt: ${block.reason}',
        'Unavailable: ${block.reason}',
      );
      final edit = widget.onEditBlock;
      children.add(
        _marker(
          context,
          label,
          [
            label,
            '${_date(context, block.from)} - ${_date(context, block.to)}',
            if (block.note != null) block.note!,
          ].join('\n'),
          Color.lerp(colors.surface, _warning(colors), 0.16)!,
          onPressed: edit == null
              ? null
              : () {
                  edit(block);
                },
        ),
      );
    }

    for (final segment in cell.deployments) {
      children.add(_deployment(context, segment, from, to, week: week));
    }

    if (cell.isEmpty) {
      if (create == null) {
        return ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 32),
          child: Text(
            week ? '–' : text(context, 'Kein Einsatz', 'No assignment'),
            style: colors.body.copyWith(color: colors.secondaryText),
          ),
        );
      }

      return _addAction(context, row, from, empty: true);
    }

    if (!week) {
      return Wrap(spacing: 6.4, runSpacing: 6.4, children: children);
    }

    final entries = <Widget>[];

    for (final child in children) {
      if (entries.isNotEmpty) {
        entries.add(const SizedBox(height: 3.2));
      }

      entries.add(child);
    }

    return ConstrainedBox(
      constraints: const BoxConstraints(minHeight: 32),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              mainAxisSize: MainAxisSize.min,
              children: entries,
            ),
          ),
          if (create != null) ...[
            const SizedBox(width: 3.2),
            SizedBox(
              width: 24,
              child: _addAction(context, row, from, empty: false),
            ),
          ],
        ],
      ),
    );
  }

  Widget _deployment(
    BuildContext context,
    PlanningSegment segment,
    DateTime from,
    DateTime to, {
    required bool week,
  }) {
    final colors = SsTheme.of(context);
    final item = segment.deployment;
    final projectRows = widget.view.rowMode == PlanningRowMode.project;
    final label = projectRows ? item.userLabel : item.projectLabel;
    final id = projectRows ? item.record.userId : item.record.projectId;
    final hue = planningColorHue(id).toDouble();
    final color = HSLColor.fromAHSL(
      1,
      hue,
      projectRows ? 0.56 : 0.68,
      projectRows ? 0.42 : 0.44,
    ).toColor();
    final time = planningSegmentTime(segment, from, to);
    final warnings = [
      for (final absence in segment.absences)
        planningAbsenceLabel(context, absence),
      for (final block in segment.blocks)
        text(
          context,
          'Projekt gesperrt: ${block.reason}',
          'Project unavailable: ${block.reason}',
        ),
    ];
    final note = item.record.note;
    final title = [
      label,
      '${_date(context, segment.from)} $time',
      ...warnings,
      if (note != null && note.isNotEmpty) note,
    ].join('\n');
    final edit = widget.onEdit;

    return _interactive(
      context,
      title,
      edit == null
          ? null
          : () {
              edit(item);
            },
      (interaction) {
        var fill = colors.mutedSurface;

        if (segment.hasWarning) {
          fill = Color.lerp(colors.surface, _warning(colors), 0.14)!;
        }

        if (interaction.hovered) {
          fill = colors.nestedSurfaceHover;
        }

        final border = segment.hasWarning
            ? Color.lerp(colors.border, _warning(colors), 0.5)!
            : colors.border;

        return Container(
          padding: EdgeInsets.symmetric(
            horizontal: week ? 5.6 : 7.2,
            vertical: week ? 2.4 : 3.2,
          ),
          decoration: BoxDecoration(
            color: fill,
            border: Border(
              left: BorderSide(color: color, width: 4.48),
              top: BorderSide(color: border),
              right: BorderSide(color: border),
              bottom: BorderSide(color: border),
            ),
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                label,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: colors.body.copyWith(fontSize: 13.28, height: 1.25),
              ),
              const SizedBox(height: 1.6),
              Text(
                '$time${segment.hasWarning ? '  !' : ''}',
                style: _timeStyle(colors),
              ),
              if (note != null && note.isNotEmpty) ...[
                const SizedBox(height: 1.6),
                Text(
                  note,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: colors.body.copyWith(
                    fontSize: 11.52,
                    height: 1.25,
                    color: colors.secondaryText,
                  ),
                ),
              ],
            ],
          ),
        );
      },
    );
  }

  Widget _marker(
    BuildContext context,
    String label,
    String title,
    Color fill, {
    VoidCallback? onPressed,
  }) {
    final colors = SsTheme.of(context);

    return _interactive(context, title, onPressed, (interaction) {
      return Container(
        padding: const EdgeInsets.symmetric(horizontal: 7.2, vertical: 3.2),
        decoration: BoxDecoration(
          color: interaction.hovered ? colors.nestedSurfaceHover : fill,
          border: Border.all(color: colors.border),
        ),
        child: Text(
          label,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: colors.body.copyWith(fontSize: 12.48, height: 1.25),
        ),
      );
    });
  }

  Widget _interactive(
    BuildContext context,
    String title,
    VoidCallback? action,
    Widget Function(SsInteraction state) build,
  ) {
    if (action == null) {
      return Tooltip(
        message: title,
        child: Semantics(
          label: title,
          excludeSemantics: true,
          child: build((hovered: false, focused: false, pressed: false)),
        ),
      );
    }

    return Tooltip(
      message: title,
      child: SsPressable(
        semanticLabel: title,
        onPressed: action,
        builder: (context, state) {
          return DecoratedBox(
            position: DecorationPosition.foreground,
            decoration: BoxDecoration(
              border: state.focused
                  ? Border.all(
                      color: SsTheme.of(context).strongAccent,
                      width: 2,
                    )
                  : null,
            ),
            child: build(state),
          );
        },
      ),
    );
  }

  Widget _addAction(
    BuildContext context,
    PlanningRow row,
    DateTime day, {
    required bool empty,
  }) {
    final colors = SsTheme.of(context);
    final create = widget.onCreate;
    final label = empty
        ? text(context, 'Einsatz einplanen', 'Assign deployment')
        : text(context, 'Weiteren Einsatz einplanen', 'Add another assignment');

    return SsPressable(
      semanticLabel: '$label: ${row.label}, ${_date(context, day)}',
      onPressed: create == null
          ? null
          : () {
              create(_preset(row.id, day));
            },
      builder: (context, interaction) {
        final compact = MediaQuery.sizeOf(context).width <= 896;
        var opacity = 0.55;

        if (empty) {
          opacity = compact ? 0.65 : 0.15;
        }

        if (interaction.hovered || interaction.focused) {
          opacity = 0.8;
        }

        return Container(
          height: empty ? 32 : 24,
          color: interaction.hovered
              ? colors.accent.withValues(alpha: 0.08)
              : null,
          alignment: Alignment.center,
          child: Opacity(
            opacity: opacity,
            child: SsIcon(
              'plus',
              size: empty ? 15 : 14,
              color: colors.strongAccent,
            ),
          ),
        );
      },
    );
  }

  PlanningPreset _preset(String rowId, DateTime day) {
    if (widget.view.rowMode == PlanningRowMode.user) {
      return PlanningPreset(day: day, userId: rowId);
    }

    return PlanningPreset(day: day, projectId: rowId);
  }

  Widget _dayHeading(BuildContext context, DateTime day) {
    final colors = SsTheme.of(context);
    final locale = Localizations.localeOf(context).languageCode;
    final today = _sameDay(day, widget.today);

    return Container(
      padding: const EdgeInsets.all(4),
      decoration: BoxDecoration(
        color: today
            ? Color.lerp(colors.surface, colors.accent, 0.1)
            : colors.mutedSurface,
        border: Border(left: BorderSide(color: colors.border)),
      ),
      child: Semantics(
        header: true,
        child: Wrap(
          spacing: 6.4,
          children: [
            Text(
              DateFormat.E(locale).format(day),
              style: colors.body.copyWith(fontWeight: FontWeight.w700),
            ),
            Text(
              _date(context, day),
              style: colors.body.copyWith(
                fontSize: 12.16,
                color: colors.secondaryText,
                fontWeight: FontWeight.w500,
              ),
            ),
          ],
        ),
      ),
    );
  }

  double _headerHeight(
    BuildContext context,
    List<DateTime> days,
    double width,
  ) {
    final colors = SsTheme.of(context);
    final locale = Localizations.localeOf(context).languageCode;
    var height = _measure(context, 'Project', colors.body).height;

    for (final day in days) {
      final weekday = _measure(
        context,
        DateFormat.E(locale).format(day),
        colors.body.copyWith(fontWeight: FontWeight.w700),
      );
      final date = _measure(
        context,
        _date(context, day),
        colors.body.copyWith(fontSize: 12.16),
      );
      final fits = weekday.width + 6.4 + date.width <= width - 8;
      final lineHeight = fits
          ? math.max(weekday.height, date.height)
          : weekday.height + date.height;
      height = math.max(height, lineHeight);
    }

    return height + 8;
  }
}

String planningAbsenceLabel(
  BuildContext context,
  models.UsersVacationsListResultItem absence,
) {
  String label;

  if (absence.type == models.UsersVacationsListResultItemType.vacation) {
    label = text(context, 'Urlaub', 'Leave');
  } else {
    final custom = absence.label?.trim() ?? '';
    label = custom.isEmpty
        ? text(context, 'Sonstige Abwesenheit', 'Other absence')
        : custom;
  }

  if (absence.status == models.UsersVacationsListResultItemStatus.requested) {
    return text(context, '$label beantragt', '$label requested');
  }

  return label;
}

Color _warning(SsColors colors) {
  return colors.brightness == Brightness.dark
      ? const Color(0xffe9b26e)
      : const Color(0xffc87415);
}

TextStyle _timeStyle(SsColors colors) {
  return TextStyle(
    fontFamily: 'monospace',
    fontSize: 11.2,
    height: 1.25,
    color: colors.secondaryText,
  );
}

String _date(BuildContext context, DateTime value) {
  final locale = Localizations.localeOf(context).languageCode;

  return DateFormat.yMd(locale).format(value.toLocal());
}

bool _sameDay(DateTime left, DateTime right) {
  return left.year == right.year &&
      left.month == right.month &&
      left.day == right.day;
}

Size _measure(BuildContext context, String value, TextStyle style) {
  final painter = TextPainter(
    text: TextSpan(text: value, style: style),
    textDirection: Directionality.of(context),
    textScaler: MediaQuery.textScalerOf(context),
    maxLines: 1,
  );

  painter.layout();
  final size = painter.size;
  painter.dispose();

  return size;
}

class _PlanningHeader extends SliverPersistentHeaderDelegate {
  _PlanningHeader(this.height, this.child);

  final double height;
  final Widget child;

  @override
  double get minExtent {
    return height;
  }

  @override
  double get maxExtent {
    return height;
  }

  @override
  Widget build(
    BuildContext context,
    double shrinkOffset,
    bool overlapsContent,
  ) {
    return child;
  }

  @override
  bool shouldRebuild(covariant _PlanningHeader oldDelegate) {
    return height != oldDelegate.height || child != oldDelegate.child;
  }
}
