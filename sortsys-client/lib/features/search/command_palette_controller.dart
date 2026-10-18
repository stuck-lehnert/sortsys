import 'dart:async';

import 'package:flutter/foundation.dart';

import 'global_search.dart';

enum PaletteGroup { recent, work, create, navigate, admin, results }

final class PaletteCommand {
  const PaletteCommand({
    required this.id,
    required this.label,
    required this.description,
    required this.icon,
    required this.group,
    required this.role,
    this.href,
  });

  final String id;
  final String label;
  final String description;
  final String icon;
  final PaletteGroup group;
  final String role;
  final String? href;

  bool matches(String query) {
    final haystack = '$label $description $id'.toLowerCase();
    final words = query.trim().toLowerCase().split(RegExp(r'\s+'));

    return words.every(haystack.contains);
  }
}

final class PaletteEntry {
  PaletteEntry.command(PaletteCommand value, {bool recent = false})
    : id = '${recent ? 'recent' : 'action'}:${value.id}',
      title = value.label,
      icon = value.icon,
      group = recent ? PaletteGroup.recent : value.group,
      command = value,
      hit = null;

  PaletteEntry.hit(SearchHit value)
    : id = '${value.resource.name}:${value.id}',
      title = value.title,
      icon = value.resource.icon,
      group = PaletteGroup.results,
      command = null,
      hit = value;

  final String id;
  final String title;
  final String icon;
  final PaletteGroup group;
  final PaletteCommand? command;
  final SearchHit? hit;
}

class CommandPaletteController extends ChangeNotifier {
  CommandPaletteController({
    required this.repository,
    required List<PaletteCommand> commands,
  }) : commands = List.unmodifiable(commands);

  final GlobalSearchRepository repository;
  final List<PaletteCommand> commands;
  Timer? _debounce;
  int _generation = 0;
  bool _disposed = false;
  String _query = '';
  List<String> _recent = const [];
  List<SearchHit> _hits = const [];
  int _activeIndex = 0;
  bool _searching = false;
  Object? _failure;
  Map<SearchResource, Object> _sourceFailures = const {};

  String get query {
    return _query;
  }

  int get activeIndex {
    return _activeIndex;
  }

  bool get searching {
    return _searching;
  }

  bool get hasFailure {
    return _failure != null || _sourceFailures.isNotEmpty;
  }

  String get _normalized {
    return _query.trim().toLowerCase();
  }

  bool get commandOnly {
    return _normalized.startsWith('>');
  }

  String get commandQuery {
    if (commandOnly) {
      return _normalized.substring(1).trim();
    }

    return _normalized;
  }

  List<PaletteEntry> get entries {
    final visible = commands
        .where((command) {
          return repository.can(command.role);
        })
        .toList(growable: false);
    final byId = {for (final command in visible) command.id: command};
    final recent = <PaletteCommand>[];

    if (commandQuery.isEmpty) {
      for (final id in _recent) {
        final command = byId[id];

        if (command != null) {
          recent.add(command);
        }
      }
    }

    final recentIds = recent.map((command) {
      return command.id;
    }).toSet();

    return List.unmodifiable([
      for (final command in recent) PaletteEntry.command(command, recent: true),
      for (final command in visible)
        if (!recentIds.contains(command.id) && command.matches(commandQuery))
          PaletteEntry.command(command),
      if (!commandOnly)
        for (final hit in _hits)
          if (repository.can(hit.resource.role)) PaletteEntry.hit(hit),
    ]);
  }

  PaletteEntry? get activeEntry {
    final available = entries;

    if (available.isEmpty) {
      return null;
    }

    return available[_activeIndex.clamp(0, available.length - 1)];
  }

  Future<void> loadRecentActions() async {
    try {
      final ids = await repository.recentActionIds();

      if (_disposed || !repository.isCurrent()) {
        return;
      }

      _recent = ids;
      _activeIndex = 0;

      notifyListeners();
    } catch (_) {
      // Optional usage history must not prevent commands or entity search.
    }
  }

  void setQuery(String value) {
    if (_disposed || _query == value) {
      return;
    }

    _debounce?.cancel();
    _generation += 1;
    _query = value;
    _activeIndex = 0;
    _hits = const [];
    _failure = null;
    _sourceFailures = const {};
    _searching = _normalized.isNotEmpty && !commandOnly;

    if (_searching) {
      final generation = _generation;
      final search = _normalized;

      _debounce = Timer(const Duration(milliseconds: 180), () {
        unawaited(_search(search, generation));
      });
    }

    notifyListeners();
  }

  Future<void> _search(String query, int generation) async {
    try {
      final result = await repository.search(query);

      if (!_accepts(generation)) {
        return;
      }

      _hits = result.hits;
      _sourceFailures = result.failures;
      _searching = false;
      _activeIndex = 0;

      notifyListeners();
    } catch (error) {
      if (!_accepts(generation)) {
        return;
      }

      _failure = error;
      _searching = false;

      notifyListeners();
    }
  }

  bool _accepts(int generation) {
    return !_disposed && generation == _generation && repository.isCurrent();
  }

  void moveActive(int delta) {
    if (_disposed) {
      return;
    }

    final count = entries.length;

    if (count == 0) {
      return;
    }

    _activeIndex = (_activeIndex + delta) % count;

    notifyListeners();
  }

  void activateIndex(int index) {
    if (_disposed || index < 0 || index >= entries.length) {
      return;
    }

    _activeIndex = index;

    notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _generation += 1;
    _debounce?.cancel();

    super.dispose();
  }
}
