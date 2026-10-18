import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../../domain/models.dart';
import '../../domain/planning.dart';
import '../../ui/text.dart';
import 'assignment_tile.dart';

class DayTimeline extends StatelessWidget {
  const DayTimeline({
    super.key,
    required this.source,
    required this.day,
    required this.now,
    required this.onReload,
  });

  static const _scale = 1.4;
  static const _labelWidth = 68.0;
  static const _eventLeft = 72.0;

  final List<Deployment> source;
  final DateTime day;
  final DateTime now;
  final VoidCallback onReload;

  @override
  Widget build(BuildContext context) {
    final layout = layoutDay(source, day);
    final defaultStart = DateTime(
      day.year,
      day.month,
      day.day,
      7,
    ).difference(layout.from).inMinutes.toDouble();
    final defaultEnd = DateTime(
      day.year,
      day.month,
      day.day,
      19,
    ).difference(layout.from).inMinutes.toDouble();
    final start = layout.events.fold(defaultStart, (earliest, event) {
      return event.start < earliest ? event.start : earliest;
    });
    final end = layout.events.fold(defaultEnd, (latest, event) {
      return event.displayEnd > latest ? event.displayEnd : latest;
    });

    return RefreshIndicator(
      onRefresh: () async {
        onReload();
      },

      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          if (source.isEmpty)
            Padding(
              padding: const EdgeInsets.only(bottom: 16),
              child: Text(
                text(
                  context,
                  'Keine Einsätze an diesem Tag.',
                  'No assignments on this day.',
                ),
              ),
            ),
          SizedBox(
            height: (end - start) * _scale + 40,
            child: LayoutBuilder(
              builder: (context, constraints) {
                return Stack(
                  children: _positions(
                    context,
                    layout,
                    start,
                    end,
                    constraints,
                  ),
                );
              },
            ),
          ),
        ],
      ),
    );
  }

  List<Widget> _positions(
    BuildContext context,
    DayLayout layout,
    double start,
    double end,
    BoxConstraints constraints,
  ) {
    final scheme = Theme.of(context).colorScheme;
    final locale = Localizations.localeOf(context).languageCode;
    final widgets = <Widget>[];

    for (final tick in layout.ticks) {
      if (tick.$1 < start || tick.$1 > end) {
        continue;
      }

      final label = tick.$1 == layout.minutes
          ? '24:00'
          : DateFormat.Hm(locale).format(tick.$2);

      widgets.add(
        Positioned(
          top: (tick.$1 - start) * _scale,
          left: 0,
          right: 0,
          child: Row(
            children: [
              SizedBox(
                width: _labelWidth,
                child: Text(
                  label,
                  style: Theme.of(context).textTheme.labelSmall,
                ),
              ),
              Expanded(child: Divider(color: scheme.outline)),
            ],
          ),
        ),
      );
    }

    final availableWidth = constraints.maxWidth - _eventLeft;
    for (final event in layout.events) {
      final laneWidth = availableWidth / event.laneCount;

      widgets.add(
        Positioned(
          top: (event.start - start) * _scale,
          left: _eventLeft + event.lane * laneWidth,
          width: laneWidth,
          height: (event.displayEnd - event.start) * _scale,
          child: AssignmentTile(
            event.item,
            compact: true,
            conflict: deploymentOverlaps(source, event.item),
          ),
        ),
      );
    }

    final today = startOfDay(now) == layout.from;
    final nowMinute = now.difference(layout.from).inSeconds / 60;
    if (today && nowMinute >= start && nowMinute <= end) {
      widgets.add(
        Positioned(
          top: (nowMinute - start) * _scale,
          left: 0,
          right: 0,
          child: IgnorePointer(
            child: Row(
              children: [
                SizedBox(
                  width: _labelWidth,
                  child: Text(
                    text(context, 'Jetzt', 'Now'),
                    style: TextStyle(color: scheme.primary),
                  ),
                ),
                Expanded(child: Divider(color: scheme.primary, thickness: 2)),
              ],
            ),
          ),
        ),
      );
    }

    return widgets;
  }
}
