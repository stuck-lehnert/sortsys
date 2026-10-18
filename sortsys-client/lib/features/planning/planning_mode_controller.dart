import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'planning_state.dart';

final class PlanningModeController extends ChangeNotifier {
  PlanningModeController({
    Future<String?> Function()? read,
    Future<void> Function(String value)? write,
  }) : _read = read ?? _readStoredMode,
       _write = write ?? _writeStoredMode;

  final Future<String?> Function() _read;
  final Future<void> Function(String value) _write;
  Future<void> _pending = Future<void>.value();
  int _generation = 0;
  bool _disposed = false;

  PlanningRowMode mode = PlanningRowMode.project;
  Object? error;

  Future<void> restore() async {
    final generation = _generation;

    try {
      final stored = await _read();

      if (!_current(generation)) {
        return;
      }

      mode = stored == 'user' ? PlanningRowMode.user : PlanningRowMode.project;
      error = null;
    } catch (failure) {
      if (!_current(generation)) {
        return;
      }

      error = failure;
    }

    notifyListeners();
  }

  Future<void> select(PlanningRowMode value) {
    if (_disposed) {
      return Future<void>.value();
    }

    final generation = ++_generation;
    mode = value;
    error = null;

    notifyListeners();

    final request = _pending.then((_) async {
      if (!_current(generation)) {
        return;
      }

      try {
        await _write(value.name);
      } catch (failure) {
        if (!_current(generation)) {
          return;
        }

        error = failure;
        notifyListeners();
      }

    });
    _pending = request;

    return request;
  }

  bool _current(int generation) {
    return !_disposed && generation == _generation;
  }

  @override
  void dispose() {
    _disposed = true;
    _generation++;
    super.dispose();
  }
}

Future<String?> _readStoredMode() async {
  final preferences = SharedPreferencesAsync();

  final value = await preferences.getString(planningRowModeStorageKey);

  return value;
}

Future<void> _writeStoredMode(String value) async {
  final preferences = SharedPreferencesAsync();

  await preferences.setString(planningRowModeStorageKey, value);
}
