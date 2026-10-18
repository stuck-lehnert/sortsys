import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

import '../../ui/text.dart';
import 'planning_state.dart';
import 'planning_view.dart';

typedef PlanningLocationChange = Uri Function(PlanningState current);

class PlanningControls extends StatefulWidget {
  const PlanningControls({
    super.key,
    required this.state,
    required this.today,
    required this.rowMode,
    required this.onLocation,
    required this.onRowMode,
    this.onCreate,
    this.onAbsence,
    this.canManageAbsences = false,
    this.summary,
  });

  final PlanningState state;
  final DateTime today;
  final PlanningRowMode rowMode;
  final ValueChanged<PlanningLocationChange> onLocation;
  final ValueChanged<PlanningRowMode> onRowMode;
  final VoidCallback? onCreate;
  final VoidCallback? onAbsence;
  final bool canManageAbsences;
  final Widget? summary;

  @override
  State<PlanningControls> createState() {
    return _PlanningControlsState();
  }
}

class _PlanningControlsState extends State<PlanningControls> {
  final _date = GlobalKey<FormFieldState<DateTime>>();
  late final _search = TextEditingController(text: widget.state.search);

  @override
  void didUpdateWidget(covariant PlanningControls oldWidget) {
    super.didUpdateWidget(oldWidget);

    if (_search.text != widget.state.search) {
      _search.value = TextEditingValue(
        text: widget.state.search,
        selection: TextSelection.collapsed(offset: widget.state.search.length),
      );
    }

    final changedDay = oldWidget.state.focusDay != widget.state.focusDay;
    final changedQuery =
        oldWidget.state.uri.queryParameters['day'] !=
        widget.state.uri.queryParameters['day'];

    if (changedDay || changedQuery) {
      _date.currentState?.didChange(widget.state.focusDay);
    }
  }

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final colors = SsTheme.of(context);
    final state = widget.state;
    final week = state.view == PlanningView.week;
    final locale = Localizations.localeOf(context).languageCode;
    final isoWeek = planningIsoWeek(state.range.from);
    final number = isoWeek.number.toString().padLeft(2, '0');
    final period = week
        ? text(
            context,
            'KW $number ${isoWeek.year}',
            'Week $number ${isoWeek.year}',
          )
        : DateFormat.yMd(locale).format(state.focusDay);
    final periodControls = _periodControls(context, period, week);
    final viewControls = _viewControls(context);
    final create = widget.onCreate;
    final absence = widget.onAbsence;
    final summary = widget.summary;

    return Semantics(
      container: true,
      explicitChildNodes: true,
      label: text(context, 'Planung steuern', 'Planning controls'),
      child: Container(
        padding: const EdgeInsets.all(7.2),
        decoration: BoxDecoration(
          color: colors.surface.withValues(alpha: 0.7),
          border: Border.all(color: colors.border),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            LayoutBuilder(
              builder: (context, constraints) {
                final width = MediaQuery.sizeOf(context).width;
                final scale = MediaQuery.textScalerOf(context).scale(16) / 16;

                if (width <= 896 || scale > 1.4) {
                  return Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      periodControls,
                      const SizedBox(height: 5.6),
                      viewControls,
                    ],
                  );
                }

                return Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    periodControls,
                    const SizedBox(width: 9.6),
                    Expanded(child: viewControls),
                  ],
                );
              },
            ),
            const SizedBox(height: 5.6),
            Container(height: 1, color: colors.border),
            const SizedBox(height: 5.6),
            Wrap(
              spacing: 7.2,
              runSpacing: 5.6,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: [
                if (create != null)
                  SsButton(
                    size: SsButtonSize.small,
                    onPressed: create,
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        const SsIcon('plus', size: 16),
                        const SizedBox(width: 6.4),
                        Text(
                          text(context, 'Einsatz hinzufügen', 'Add assignment'),
                        ),
                      ],
                    ),
                  ),
                if (absence != null)
                  SsButton(
                    size: SsButtonSize.small,
                    kind: SsButtonKind.secondary,
                    onPressed: absence,
                    child: Text(
                      widget.canManageAbsences
                          ? text(
                              context,
                              'Abwesenheit eintragen',
                              'Add absence',
                            )
                          : text(
                              context,
                              'Abwesenheit beantragen',
                              'Request absence',
                            ),
                    ),
                  ),
                _toggle(
                  context,
                  state.showEmptyRows
                      ? text(context, 'Alle Zeilen', 'All rows')
                      : text(context, 'Nur belegte', 'Assigned only'),
                  state.showEmptyRows,
                  () {
                    widget.onLocation((current) {
                      return current.withEmptyRows(!current.showEmptyRows);
                    });
                  },
                ),
                if (week)
                  _toggle(
                    context,
                    state.showWeekend
                        ? text(context, 'Mit Wochenende', 'With weekend')
                        : text(context, 'Mo–Fr', 'Mon–Fri'),
                    state.showWeekend,
                    () {
                      widget.onLocation((current) {
                        return current.withWeekend(!current.showWeekend);
                      });
                    },
                  ),
                ?summary,
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _periodControls(BuildContext context, String period, bool week) {
    final colors = SsTheme.of(context);
    final dateWidth = MediaQuery.textScalerOf(context).scale(84) + 70;

    return Wrap(
      spacing: 7.2,
      runSpacing: 5.6,
      crossAxisAlignment: WrapCrossAlignment.center,
      children: [
        SsIconButton(
          icon: 'chevron-left',
          borderless: true,
          iconSize: 18,
          label: week
              ? text(context, 'Vorherige Woche', 'Previous week')
              : text(context, 'Vorheriger Tag', 'Previous day'),
          onPressed: () {
            widget.onLocation((current) {
              return current.shifted(-1);
            });
          },
        ),
        SizedBox(
          width: 104,
          child: Semantics(
            liveRegion: true,
            child: Text(
              period,
              textAlign: TextAlign.center,
              style: colors.body.copyWith(fontWeight: FontWeight.w700),
            ),
          ),
        ),
        SsIconButton(
          icon: 'chevron-right',
          borderless: true,
          iconSize: 18,
          label: week
              ? text(context, 'Nächste Woche', 'Next week')
              : text(context, 'Nächster Tag', 'Next day'),
          onPressed: () {
            widget.onLocation((current) {
              return current.shifted(1);
            });
          },
        ),
        SizedBox(
          width: dateWidth,
          child: SsDateField(
            key: _date,
            showLabel: false,
            label: text(context, 'Datum auswählen', 'Select date'),
            clearLabel: text(context, 'Datum löschen', 'Clear date'),
            initialValue: widget.state.focusDay,
            onChanged: (value) {
              if (value == null) {
                _date.currentState?.didChange(widget.today);
                widget.onLocation((current) {
                  return current.withoutDay();
                });

                return;
              }

              widget.onLocation((current) {
                return current.withDay(value);
              });
            },
          ),
        ),
        SsButton(
          size: SsButtonSize.small,
          kind: SsButtonKind.ghost,
          onPressed: () {
            widget.onLocation((current) {
              return current.withDay(widget.today);
            });
          },
          child: Text(text(context, 'Heute', 'Today')),
        ),
      ],
    );
  }

  Widget _viewControls(BuildContext context) {
    final state = widget.state;
    final projectRows = widget.rowMode == PlanningRowMode.project;

    return LayoutBuilder(
      builder: (context, constraints) {
        final searchWidth = math.min(352.0, constraints.maxWidth);

        return Wrap(
          alignment: WrapAlignment.end,
          spacing: 7.2,
          runSpacing: 5.6,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            _segment<PlanningView>(
              context,
              text(context, 'Zeitraum', 'Period'),
              state.view,
              [
                SsOption(
                  value: PlanningView.week,
                  label: text(context, 'Woche', 'Week'),
                ),
                SsOption(
                  value: PlanningView.day,
                  label: text(context, 'Tag', 'Day'),
                ),
              ],
              (value) {
                widget.onLocation((current) {
                  return current.withView(value);
                });
              },
            ),
            _segment<PlanningRowMode>(
              context,
              text(context, 'Zeilen', 'Rows'),
              widget.rowMode,
              [
                SsOption(
                  value: PlanningRowMode.project,
                  label: text(context, 'Projekte', 'Projects'),
                ),
                SsOption(
                  value: PlanningRowMode.user,
                  label: text(context, 'Mitarbeitende', 'Employees'),
                ),
              ],
              widget.onRowMode,
            ),
            SizedBox(
              width: searchWidth,
              child: Semantics(
                label: text(context, 'Planung durchsuchen', 'Search planning'),
                child: SsTextField(
                  controller: _search,
                  kind: SsTextFieldKind.search,
                  hint: projectRows
                      ? text(
                          context,
                          'Projekt oder Mitarbeiter suchen',
                          'Search project or employee',
                        )
                      : text(
                          context,
                          'Mitarbeiter oder Projekt suchen',
                          'Search employee or project',
                        ),
                  prefix: const SsIcon('search', size: 17),
                  suffix: state.search.isEmpty
                      ? null
                      : SsIconButton(
                          icon: 'x',
                          label: text(context, 'Suche löschen', 'Clear search'),
                          onPressed: () {
                            _search.clear();
                            widget.onLocation((current) {
                              return current.withSearch('');
                            });
                          },
                        ),
                  onChanged: (value) {
                    widget.onLocation((current) {
                      return current.withSearch(value);
                    });
                  },
                ),
              ),
            ),
          ],
        );
      },
    );
  }

  Widget _segment<T>(
    BuildContext context,
    String label,
    T value,
    List<SsOption<T>> options,
    ValueChanged<T> onChanged,
  ) {
    final colors = SsTheme.of(context);
    final buttons = <Widget>[];

    for (final option in options) {
      final selected = value == option.value;
      final first = buttons.isEmpty;

      buttons.add(
        Flexible(
          child: SsPressable(
            semanticLabel: option.label,
            selected: selected,
            onPressed: () {
              onChanged(option.value);
            },
            builder: (context, interaction) {
              final foreground = selected || interaction.hovered
                  ? colors.strongAccent
                  : colors.secondaryText;

              return Container(
                constraints: const BoxConstraints(minHeight: 28.8),
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                decoration: BoxDecoration(
                  color: selected ? colors.mutedSurface : null,
                  border: first
                      ? null
                      : Border(left: BorderSide(color: colors.border)),
                ),
                foregroundDecoration: BoxDecoration(
                  border: interaction.focused
                      ? Border.all(color: colors.strongAccent, width: 2)
                      : null,
                ),
                child: Center(
                  widthFactor: 1,
                  child: Text(
                    option.label,
                    style: colors.body.copyWith(
                      fontSize: 12.48,
                      color: foreground,
                      fontWeight: selected ? FontWeight.w600 : FontWeight.w400,
                    ),
                  ),
                ),
              );
            },
          ),
        ),
      );
    }

    return Semantics(
      container: true,
      explicitChildNodes: true,
      label: label,
      child: DecoratedBox(
        decoration: BoxDecoration(border: Border.all(color: colors.border)),
        child: Padding(
          padding: const EdgeInsets.all(1),
          child: IntrinsicHeight(
            child: Row(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: buttons,
            ),
          ),
        ),
      ),
    );
  }

  Widget _toggle(
    BuildContext context,
    String label,
    bool selected,
    VoidCallback onPressed,
  ) {
    final colors = SsTheme.of(context);

    return SsPressable(
      semanticLabel: label,
      selected: selected,
      onPressed: onPressed,
      builder: (context, interaction) {
        return Container(
          padding: const EdgeInsets.symmetric(horizontal: 8.96, vertical: 4.16),
          decoration: BoxDecoration(
            color: interaction.hovered
                ? colors.nestedSurfaceHover
                : colors.mutedSurface,
            border: Border.all(
              color: interaction.focused ? colors.strongAccent : colors.border,
            ),
          ),
          child: Text(
            label,
            style: colors.body.copyWith(
              fontSize: 12.48,
              fontWeight: FontWeight.w600,
              color: selected ? colors.strongAccent : colors.secondaryText,
            ),
          ),
        );
      },
    );
  }
}
