import 'dart:async';

import 'package:flutter/foundation.dart';

import 'planning_data.dart';
import 'planning_repository.dart';
import 'planning_state.dart';
import 'planning_view.dart';

final class PlanningController extends ChangeNotifier {
  PlanningController({
    required PlanningRepository repository,
    required PlanningRange range,
  }) : this._(repository, range);

  PlanningController._(this.repository, this._range);

  final PlanningRepository repository;
  PlanningRange _range;
  Timer? _timer;
  Future<void>? _inFlight;
  int _generation = 0;
  bool _disposed = false;

  PlanningData? data;
  Map<PlanningSource, Object> failures = const {};
  Object? error;
  bool loading = true;
  bool refreshing = false;

  void setRange(PlanningRange value) {
    final sameStart = _range.from.isAtSameMomentAs(value.from);
    final sameEnd = _range.toExclusive.isAtSameMomentAs(value.toExclusive);

    if (_disposed || (sameStart && sameEnd)) {
      return;
    }

    _generation++;
    _range = value;
    _timer?.cancel();
    data = null;
    failures = const {};
    error = null;
    loading = true;
    notifyListeners();

    if (_inFlight == null) {
      unawaited(refresh());
    }
  }

  Future<void> refresh() {
    final active = _inFlight;

    if (_disposed || active != null) {
      return active ?? Future<void>.value();
    }

    _timer?.cancel();
    refreshing = true;
    final request = _pull(_generation, _range);
    _inFlight = request;

    return request;
  }

  Future<void> reload() async {
    final active = _inFlight;

    if (active != null) {
      await active;
    }

    if (_disposed || !repository.isCurrent()) {
      return;
    }

    await refresh();
  }

  Future<void> _pull(int generation, PlanningRange range) async {
    PlanningLoad? result;
    Object? failure;

    try {
      result = await repository.load(range, previous: data);
    } catch (error) {
      failure = error;
    }

    if (_disposed) {
      return;
    }

    _inFlight = null;

    if (generation != _generation) {
      unawaited(refresh());

      return;
    }

    if (!repository.isCurrent()) {
      data = null;
      failures = const {};
      error = failure ?? StateError('STALE_PLANNING_SCOPE');
      loading = false;
      refreshing = false;
      notifyListeners();

      return;
    }

    if (result != null) {
      data = result.data;
      failures = result.failures;
    }

    error = failure;
    loading = false;
    refreshing = false;
    notifyListeners();
    _scheduleNextPull();
  }

  void _scheduleNextPull() {
    _timer?.cancel();

    // A listener may dispose this controller while handling the last result.
    if (_disposed || !repository.isCurrent()) {
      return;
    }

    _timer = Timer(planningPullInterval, () {
      unawaited(refresh());
    });
  }

  @override
  void dispose() {
    _disposed = true;
    _generation++;
    _timer?.cancel();
    super.dispose();
  }
}
