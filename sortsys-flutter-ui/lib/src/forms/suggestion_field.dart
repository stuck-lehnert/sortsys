import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart' show Material, MaterialType;
import 'package:flutter/widgets.dart';

import '../button.dart';
import '../surface.dart';
import 'text_field.dart';

typedef SsSuggestionMatcher =
    Iterable<String> Function(List<String> options, String query);

class SsSuggestionField extends StatefulWidget {
  const SsSuggestionField({
    super.key,
    required this.label,
    required this.controller,
    required this.queryIdentity,
    required this.loadSuggestions,
    this.matchSuggestions,
    this.isCurrent,
    this.focusNode,
    this.enabled = true,
    this.validator,
    this.onSaved,
    this.onChanged,
  });

  final String label;
  final TextEditingController controller;
  final Object queryIdentity;
  final Future<List<String>> Function() loadSuggestions;
  final SsSuggestionMatcher? matchSuggestions;
  final bool Function()? isCurrent;
  final FocusNode? focusNode;
  final bool enabled;
  final FormFieldValidator<String>? validator;
  final FormFieldSetter<String>? onSaved;
  final ValueChanged<String>? onChanged;

  @override
  State<SsSuggestionField> createState() {
    return _SsSuggestionFieldState();
  }
}

class _SsSuggestionFieldState extends State<SsSuggestionField> {
  final _localFocus = FocusNode();
  final _measureKey = GlobalKey();
  late Future<List<String>> _prepared;
  Timer? _debounce;
  Completer<bool>? _waiting;
  int _scope = 0;
  int _request = 0;

  @override
  void initState() {
    super.initState();
    _prepare();
  }

  @override
  void didUpdateWidget(covariant SsSuggestionField oldWidget) {
    super.didUpdateWidget(oldWidget);

    if (oldWidget.queryIdentity != widget.queryIdentity ||
        oldWidget.controller != widget.controller ||
        oldWidget.enabled != widget.enabled ||
        oldWidget.matchSuggestions != widget.matchSuggestions) {
      _scope++;
      _cancelDebounce();
      _prepare();
    }
  }

  bool get _current {
    return mounted && widget.enabled && (widget.isCurrent?.call() ?? true);
  }

  void _prepare() {
    if (!_current) {
      _prepared = Future.value(const []);

      return;
    }

    // Suggestions are optional; failed preparation must not reject free text.
    _prepared = Future<List<String>>.sync(widget.loadSuggestions).then(
      (options) {
        return List<String>.unmodifiable(options);
      },
      onError: (Object error, StackTrace stack) {
        return <String>[];
      },
    );
  }

  void _cancelDebounce() {
    _debounce?.cancel();
    _debounce = null;

    final waiting = _waiting;
    _waiting = null;

    if (waiting != null && !waiting.isCompleted) {
      waiting.complete(false);
    }
  }

  Future<Iterable<String>> _options(TextEditingValue value) async {
    final request = ++_request;
    final scope = _scope;
    final prepared = _prepared;
    final matcher = widget.matchSuggestions;

    // Custom matchers own normalization and must receive the raw query.
    final query = matcher == null
        ? value.text.trim().toLowerCase()
        : value.text;

    _cancelDebounce();

    if (!_current || query.isEmpty) {
      return const [];
    }

    final waiting = Completer<bool>();
    _waiting = waiting;
    _debounce = Timer(const Duration(milliseconds: 250), () {
      _debounce = null;
      _waiting = null;
      waiting.complete(true);
    });

    if (!await waiting.future || !_current) {
      return const [];
    }

    final options = await prepared;

    if (!_current || scope != _scope || request != _request) {
      return const [];
    }

    if (matcher != null) {
      return List<String>.unmodifiable(matcher(options, query));
    }

    return options
        .where((option) {
          return option.toLowerCase().contains(query);
        })
        .toList(growable: false);
  }

  @override
  void dispose() {
    _scope++;
    _cancelDebounce();
    _localFocus.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final focus = widget.focusNode ?? _localFocus;
    final scope = _scope;

    return RawAutocomplete<String>(
      key: ValueKey((_scope, focus)),
      textEditingController: widget.controller,
      focusNode: focus,
      optionsBuilder: _options,
      onSelected: (option) {
        if (_current && scope == _scope) {
          widget.onChanged?.call(option);
        }
      },
      fieldViewBuilder: (context, controller, focusNode, submit) {
        return SizedBox(
          key: _measureKey,
          child: SsTextField(
            label: widget.label,
            controller: controller,
            focusNode: focusNode,
            enabled: _current,
            validator: widget.validator,
            onSaved: widget.onSaved,
            onChanged: (value) {
              if (_current && scope == _scope) {
                widget.onChanged?.call(value);
              }
            },
            onSubmitted: (value) {
              if (_current && scope == _scope) {
                submit();
              }
            },
          ),
        );
      },
      optionsViewBuilder: (context, select, options) {
        final box =
            _measureKey.currentContext?.findRenderObject() as RenderBox?;

        return Align(
          alignment: AlignmentDirectional.topStart,
          child: Material(
            type: MaterialType.transparency,
            child: SizedBox(
              width: box?.size.width ?? 280,
              child: SsSurface(
                child: _SuggestionOptions(
                  options: options.toList(growable: false),
                  onSelected: (option) {
                    if (!_current || scope != _scope) {
                      return;
                    }

                    select(option);
                  },
                ),
              ),
            ),
          ),
        );
      },
    );
  }
}

class _SuggestionOptions extends StatefulWidget {
  const _SuggestionOptions({required this.options, required this.onSelected});

  final List<String> options;
  final ValueChanged<String> onSelected;

  @override
  State<_SuggestionOptions> createState() {
    return _SuggestionOptionsState();
  }
}

class _SuggestionOptionsState extends State<_SuggestionOptions> {
  final _scroll = ScrollController();
  int _lastHighlighted = -1;

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final highlighted = AutocompleteHighlightedOption.of(context);
    final scale = MediaQuery.textScalerOf(context).scale(14) / 14;
    final extent = math.max(44.0, 24 + 20 * scale);

    if (highlighted != _lastHighlighted) {
      _lastHighlighted = highlighted;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted || !_scroll.hasClients) {
          return;
        }

        final top = highlighted * extent;
        final bottom = top + extent;
        final desired = top < _scroll.offset
            ? top
            : math.max(
                _scroll.offset,
                bottom - _scroll.position.viewportDimension,
              );
        final offset = desired.clamp(0.0, _scroll.position.maxScrollExtent);
        _scroll.jumpTo(offset);
      });
    }

    return ConstrainedBox(
      constraints: const BoxConstraints(maxHeight: 280),
      child: ListView.builder(
        controller: _scroll,
        shrinkWrap: true,
        itemExtent: extent,
        padding: EdgeInsets.zero,
        itemCount: widget.options.length,
        itemBuilder: (context, index) {
          final option = widget.options[index];

          return SsButton(
            kind: SsButtonKind.ghost,
            selected: index == highlighted,
            alignment: AlignmentDirectional.centerStart,
            onPressed: () {
              widget.onSelected(option);
            },
            child: Text(option, maxLines: 1, overflow: TextOverflow.ellipsis),
          );
        },
      ),
    );
  }
}
