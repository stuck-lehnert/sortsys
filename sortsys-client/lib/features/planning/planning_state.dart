import '../../domain/planning.dart';
import 'planning_view.dart';

enum PlanningRowMode { project, user }

const planningRowModeStorageKey = 'sortsys.deployments.rowMode';
const planningPullInterval = Duration(seconds: 3);

final class PlanningState {
  PlanningState(this.uri, {required DateTime today})
    : focusDay =
          parsePlanningDate(uri.queryParameters['day']) ?? startOfDay(today);

  final Uri uri;
  final DateTime focusDay;

  PlanningView get view {
    if (uri.queryParameters['view'] == 'day') {
      return PlanningView.day;
    }

    return PlanningView.week;
  }

  bool get showEmptyRows {
    return uri.queryParameters['all'] == 'yes';
  }

  bool get showWeekend {
    return uri.queryParameters['weekend'] == 'yes';
  }

  String get search {
    return uri.queryParameters['q'] ?? '';
  }

  String get normalizedSearch {
    return search.trim().toLowerCase();
  }

  PlanningRange get range {
    return planningViewRange(focusDay, view);
  }

  DateTime get visibleEndExclusive {
    final currentRange = range;

    if (view == PlanningView.week && !showWeekend) {
      return shiftDay(currentRange.from, 5);
    }

    return currentRange.toExclusive;
  }

  List<DateTime> get days {
    var count = 1;

    if (view == PlanningView.week) {
      count = showWeekend ? 7 : 5;
    }

    final first = range.from;

    return List.unmodifiable([
      for (var index = 0; index < count; index++) shiftDay(first, index),
    ]);
  }

  Uri withDay(DateTime value) {
    return _change('day', planningDateText(value));
  }

  Uri withoutDay() {
    return _change('day', null);
  }

  Uri withView(PlanningView value) {
    return _change('view', value.name);
  }

  Uri withSearch(String value) {
    return _change('q', value.isEmpty ? null : value);
  }

  Uri withEmptyRows(bool value) {
    return _change('all', value ? 'yes' : null);
  }

  Uri withWeekend(bool value) {
    return _change('weekend', value ? 'yes' : null);
  }

  Uri shifted(int direction) {
    final distance = view == PlanningView.week ? 7 : 1;
    final target = shiftDay(focusDay, distance * direction);

    return withDay(target);
  }

  Uri _change(String name, String? value) {
    final parameters = <String, Object>{...uri.queryParametersAll};

    if (value == null) {
      parameters.remove(name);
    } else {
      parameters[name] = value;
    }

    return uri.replace(queryParameters: parameters);
  }
}

DateTime? parsePlanningDate(String? value) {
  final match = RegExp(
    r'^(\d{4})-(\d{2})-(\d{2})$',
  ).firstMatch(value?.trim() ?? '');

  if (match == null) {
    return null;
  }

  final year = int.parse(match.group(1)!);
  final month = int.parse(match.group(2)!);
  final day = int.parse(match.group(3)!);
  final result = DateTime(year, month, day);
  final matches =
      result.year == year && result.month == month && result.day == day;

  // JavaScript's numeric Date constructor interprets years 0–99 as 1900–1999.
  // The Webapp rejects them when validating the resulting civil date.
  if (year < 100 || !matches) {
    return null;
  }

  return result;
}

String planningDateText(DateTime value) {
  final year = value.year.toString().padLeft(4, '0');
  final month = value.month.toString().padLeft(2, '0');
  final day = value.day.toString().padLeft(2, '0');

  return '$year-$month-$day';
}

String planningTimeText(DateTime value) {
  final hours = value.hour.toString().padLeft(2, '0');
  final minutes = value.minute.toString().padLeft(2, '0');

  return '$hours:$minutes';
}

DateTime? combinePlanningDateAndTime(String date, String time) {
  final day = parsePlanningDate(date);
  final match = RegExp(r'^(\d{2}):(\d{2})$').firstMatch(time.trim());

  if (day == null || match == null) {
    return null;
  }

  final hours = int.parse(match.group(1)!);
  final minutes = int.parse(match.group(2)!);

  if (hours > 23 || minutes > 59) {
    return null;
  }

  return DateTime(day.year, day.month, day.day, hours, minutes);
}

({int year, int number}) planningIsoWeek(DateTime value) {
  final civil = DateTime.utc(value.year, value.month, value.day);
  final thursday = civil.add(Duration(days: 4 - civil.weekday));
  final yearStart = DateTime.utc(thursday.year);
  final week = thursday.difference(yearStart).inDays ~/ 7 + 1;

  return (year: thursday.year, number: week);
}
