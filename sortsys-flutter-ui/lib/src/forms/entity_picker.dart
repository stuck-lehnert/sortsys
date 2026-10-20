import 'dart:async';

import 'package:flutter/widgets.dart';

import 'autocomplete_field.dart';

class SsEntityPicker<T extends Object> extends StatefulWidget {
  const SsEntityPicker({
    super.key,
    required this.label,
    required this.queryIdentity,
    required this.loadOptions,
    required this.displayString,
    required this.onSelected,
    required this.createLabel,
    this.onCreate,
    this.canCreateQuery,
    this.focusNode,
    this.enabled = true,
    this.loadingText = 'Loading options',
    this.emptyText = 'No matches',
    this.failureText = 'Options could not be loaded.',
    this.selectionRequiredText = 'Choose an option from the list.',
    this.createFailureText = 'The creation dialog could not be completed.',
  });

  final String label;
  final Object queryIdentity;
  final FutureOr<List<T>> Function(String query) loadOptions;
  final String Function(T value) displayString;
  final ValueChanged<T> onSelected;
  final String Function(String query) createLabel;
  final Future<T?> Function(String query)? onCreate;
  final bool Function(String query)? canCreateQuery;
  final FocusNode? focusNode;
  final bool enabled;
  final String loadingText;
  final String emptyText;
  final String failureText;
  final String selectionRequiredText;
  final String createFailureText;

  @override
  State<SsEntityPicker<T>> createState() {
    return _SsEntityPickerState<T>();
  }
}

class _SsEntityPickerState<T extends Object> extends State<SsEntityPicker<T>> {
  final _localFocus = FocusNode();
  int _scopeEpoch = 0;
  int _operation = 0;
  int _generation = 0;
  bool _creating = false;
  bool _failed = false;
  String _restoreQuery = '';

  FocusNode get _focus {
    return widget.focusNode ?? _localFocus;
  }

  @override
  void didUpdateWidget(covariant SsEntityPicker<T> oldWidget) {
    super.didUpdateWidget(oldWidget);

    if (widget.queryIdentity != oldWidget.queryIdentity) {
      _scopeEpoch++;
      _operation++;
      _generation++;
      _creating = false;
      _failed = false;
      _restoreQuery = '';
    } else if ((oldWidget.enabled && !widget.enabled) ||
        (oldWidget.onCreate != null && widget.onCreate == null)) {
      _scopeEpoch++;
    }
  }

  @override
  void dispose() {
    _scopeEpoch++;
    _operation++;
    _localFocus.dispose();
    super.dispose();
  }

  Future<List<_EntityChoice<T>>> _load(String query) async {
    final epoch = _scopeEpoch;
    final options = List<T>.of(await widget.loadOptions(query));

    if (!mounted || epoch != _scopeEpoch || !widget.enabled || _creating) {
      return [];
    }

    final normalized = query.trim().toLowerCase();
    final exact = options.any((option) {
      return widget.displayString(option).trim().toLowerCase() == normalized;
    });
    final choices = <_EntityChoice<T>>[
      for (final option in options) _ExistingEntity<T>(option),
    ];

    if (widget.onCreate != null &&
        normalized.isNotEmpty &&
        !exact &&
        (widget.canCreateQuery?.call(query) ?? true)) {
      choices.add(_CreateEntity<T>(query.trim()));
    }

    return List.unmodifiable(choices);
  }

  String _display(_EntityChoice<T> choice) {
    return switch (choice) {
      _ExistingEntity<T>(:final value) => widget.displayString(value),
      _CreateEntity<T>(:final query) => widget.createLabel(query),
    };
  }

  void _select(_EntityChoice<T>? choice) {
    if (!widget.enabled || _creating || choice == null) {
      return;
    }

    switch (choice) {
      case _ExistingEntity<T>(:final value):
        widget.onSelected(value);
      case _CreateEntity<T>(:final query):
        unawaited(_create(query));
    }
  }

  Future<void> _create(String query) async {
    final create = widget.onCreate;

    if (create == null ||
        !widget.enabled ||
        _creating ||
        !(widget.canCreateQuery?.call(query) ?? true)) {
      return;
    }

    final epoch = _scopeEpoch;
    final operation = ++_operation;
    T? created;
    var failed = false;
    setState(() {
      _creating = true;
      _failed = false;
    });

    try {
      // Callers return only a verified created entity, never a guessed ID.
      created = await create(query);
    } catch (_) {
      failed = true;
    }

    if (!mounted || operation != _operation) {
      return;
    }

    final accept = epoch == _scopeEpoch &&
        widget.enabled && widget.onCreate != null;
    setState(() {
      _creating = false;
      _failed = accept && failed;
      _restoreQuery = accept && created != null ? '' : query;
      _generation++;
    });

    // Consumer/navigation errors must not be treated as failed creation.
    if (accept && created != null) {
      widget.onSelected(created);

      return;
    }

    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && operation == _operation && widget.enabled) {
        _focus.requestFocus();
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        SsAutocompleteField<_EntityChoice<T>>(
          label: widget.label,
          queryIdentity: (widget.queryIdentity, _generation),
          initialQuery: _restoreQuery,
          focusNode: _focus,
          enabled: widget.enabled && !_creating,
          clearOnSelect: true,
          loadOptions: _load,
          displayString: _display,
          onChanged: _select,
          loadingText: widget.loadingText,
          emptyText: widget.emptyText,
          failureText: widget.failureText,
          selectionRequiredText: widget.selectionRequiredText,
        ),
        if (_failed) ...[
          const SizedBox(height: 8),
          Text(widget.createFailureText),
        ],
      ],
    );
  }
}

sealed class _EntityChoice<T extends Object> {
  const _EntityChoice();
}

final class _ExistingEntity<T extends Object> extends _EntityChoice<T> {
  const _ExistingEntity(this.value);

  final T value;
}

final class _CreateEntity<T extends Object> extends _EntityChoice<T> {
  const _CreateEntity(this.query);

  final String query;
}
