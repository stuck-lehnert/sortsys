import 'models.dart';

DateTime startOfDay(DateTime value) {
  return DateTime(value.year, value.month, value.day);
}

DateTime shiftDay(DateTime value, int by) {
  return DateTime(value.year, value.month, value.day + by);
}

DateTime monday(DateTime value) {
  return shiftDay(startOfDay(value), 1 - value.weekday);
}

bool periodsOverlap(DateTime from, DateTime to, DateTime start, DateTime end) {
  return from.isBefore(end) && to.isAfter(start);
}

final class DayEvent {
  DayEvent(this.item, this.start, this.end);

  final Deployment item;
  final double start;
  final double end;

  int lane = 0;
  int laneCount = 1;

  double get displayEnd => end > start + 40 ? end : start + 40;
}

final class DayLayout {
  DayLayout(this.from, this.to, this.events, this.ticks, this.minutes);

  final DateTime from;
  final DateTime to;
  final List<DayEvent> events;
  final List<(double, DateTime)> ticks;
  final double minutes;
}

DayLayout layoutDay(List<Deployment> source, DateTime day) {
  final from = startOfDay(day);
  final to = shiftDay(day, 1);
  final minutes = to.difference(from).inSeconds / 60;
  final seen = <String>{};
  final events = <DayEvent>[];

  for (final item in source) {
    final duplicate = !seen.add(item.id);
    final invalidPeriod = !item.to.isAfter(item.from);
    final outsideDay = !periodsOverlap(item.from, item.to, from, to);

    if (duplicate || invalidPeriod || outsideDay) {
      continue;
    }

    final start = item.from.isBefore(from)
        ? 0.0
        : item.from.difference(from).inSeconds / 60;
    final end = item.to.isAfter(to)
        ? minutes
        : item.to.difference(from).inSeconds / 60;

    events.add(DayEvent(item, start, end));
  }

  events.sort((first, second) {
    if (first.start != second.start) {
      return first.start.compareTo(second.start);
    }

    return first.item.id.compareTo(second.item.id);
  });

  _assignCollisionLanes(events);
  final ticks = <(double, DateTime)>[];

  for (var minute = 0.0; minute <= minutes; minute += 60) {
    ticks.add((minute, from.add(Duration(minutes: minute.toInt()))));
  }

  if (ticks.last.$1 != minutes) {
    ticks.add((minutes, to));
  }

  return DayLayout(from, to, events, ticks, minutes);
}

void _assignCollisionLanes(List<DayEvent> events) {
  var group = <DayEvent>[];
  var groupEnd = -1.0;

  for (final event in events) {
    if (event.start >= groupEnd) {
      _packGroup(group);
      group = [];
      groupEnd = -1;
    }

    group.add(event);
    if (event.displayEnd > groupEnd) {
      groupEnd = event.displayEnd;
    }
  }

  _packGroup(group);
}

void _packGroup(List<DayEvent> group) {
  final laneEnds = <double>[];

  for (final event in group) {
    var lane = laneEnds.indexWhere((end) => end <= event.start);
    if (lane < 0) {
      lane = laneEnds.length;
      laneEnds.add(event.displayEnd);
    } else {
      laneEnds[lane] = event.displayEnd;
    }

    event.lane = lane;
  }

  for (final event in group) {
    event.laneCount = laneEnds.length;
  }
}

bool deploymentOverlaps(List<Deployment> rows, Deployment target) {
  return rows.any((row) {
    return row.id != target.id &&
        row.userId == target.userId &&
        periodsOverlap(row.from, row.to, target.from, target.to);
  });
}
