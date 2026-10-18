import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart' show Material, MaterialType;
import 'package:flutter/widgets.dart';

import '../button.dart';
import '../progress.dart';
import '../surface.dart';
import 'text_field.dart';

class SsAutocompleteField<T extends Object> extends FormField<T> {
  SsAutocompleteField({
    super.key,
    required this.label,
    required this.loadOptions,
    required this.displayString,
    this.queryIdentity,
    this.onChanged,
    this.clearOnSelect = false,
    this.loadingText = 'Loading options',
    this.emptyText = 'No matches',
    this.failureText = 'Options could not be loaded.',
    this.selectionRequiredText = 'Choose an option from the list.',
    super.initialValue,
    super.validator,
    super.onSaved,
    super.enabled,
  }) : super(
         builder: (state) {
           return (state as _SsAutocompleteState<T>).buildField();
         },

       );

  final String label;
  final FutureOr<List<T>> Function(String query) loadOptions;
  final String Function(T value) displayString;
  final Object? queryIdentity;
  final ValueChanged<T?>? onChanged;
  final bool clearOnSelect;
  final String loadingText;
  final String emptyText;
  final String failureText;
  final String selectionRequiredText;

  @override
  FormFieldState<T> createState() {
    return _SsAutocompleteState<T>();
  }

}

class _SsAutocompleteState<T extends Object> extends FormFieldState<T> {
  int _resetGeneration = 0;
  bool _scopeResetPending = false;

  SsAutocompleteField<T> get field {
    return widget as SsAutocompleteField<T>;
  }

  @override
  void didUpdateWidget(covariant SsAutocompleteField<T> oldWidget) {
    super.didUpdateWidget(oldWidget);

    if (oldWidget.queryIdentity == field.queryIdentity) {
      return;
    }

    setValue(field.initialValue);
    _scopeResetPending = true;
    final identity = field.queryIdentity;

    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || field.queryIdentity != identity) {
        return;
      }

      // Reset notifies the owning Form, which must happen outside build.
      _scopeResetPending = false;
      super.reset();
    });

  }

  @override
  void reset() {
    _resetGeneration += 1;
    super.reset();
  }

  Widget buildField() {
    return _SsAutocompleteInput<T>(
      key: ValueKey((field.queryIdentity, _resetGeneration)),
      field: field,
      selectedValue: value,
      errorText: _scopeResetPending ? null : errorText,
      onSelected: (option) {
        didChange(option);
        field.onChanged?.call(option);

        if (field.clearOnSelect) {
          didChange(null);
        }

      },

      onQueryChanged: (query) {
        final selected = value;

        if (selected != null && query != field.displayString(selected)) {
          didChange(null);
          field.onChanged?.call(null);
        }

      },

    );
  }

}

class _SsAutocompleteInput<T extends Object> extends StatefulWidget {
  const _SsAutocompleteInput({
    super.key,
    required this.field,
    required this.selectedValue,
    required this.onSelected,
    required this.onQueryChanged,
    this.errorText,
  });

  final SsAutocompleteField<T> field;
  final T? selectedValue;
  final ValueChanged<T> onSelected;
  final ValueChanged<String> onQueryChanged;
  final String? errorText;

  @override
  State<_SsAutocompleteInput<T>> createState() {
    return _SsAutocompleteInputState<T>();
  }

}

class _SsAutocompleteInputState<T extends Object>
    extends State<_SsAutocompleteInput<T>> {
  final _focusNode = FocusNode();
  final _measureKey = GlobalKey();
  late final TextEditingController _controller;
  int _requestEpoch = 0;
  Timer? _debounce;
  Completer<bool>? _debounceWait;
  bool _loading = false;
  bool _failed = false;
  bool _empty = false;

  SsAutocompleteField<T> get field {
    return widget.field;
  }

  @override
  void initState() {
    super.initState();

    final initial = widget.selectedValue;
    _controller = TextEditingController(
      text: initial == null ? '' : field.displayString(initial),
    );
  }

  @override
  void didUpdateWidget(covariant _SsAutocompleteInput<T> oldWidget) {
    super.didUpdateWidget(oldWidget);

    if (oldWidget.field.enabled && !field.enabled) {
      _requestEpoch += 1;
      _cancelDebounce();
      _loading = false;
    }

  }

  void _cancelDebounce() {
    _debounce?.cancel();
    _debounce = null;

    final waiting = _debounceWait;
    _debounceWait = null;

    if (waiting != null && !waiting.isCompleted) {
      waiting.complete(false);
    }

  }

  @override
  void dispose() {
    _requestEpoch += 1;
    _cancelDebounce();
    _controller.dispose();
    _focusNode.dispose();
    super.dispose();
  }

  Future<Iterable<T>> _options(TextEditingValue query) async {
    final epoch = ++_requestEpoch;
    _cancelDebounce();

    if (!field.enabled) {
      return const [];
    }

    final waiting = Completer<bool>();
    _debounceWait = waiting;
    _debounce = Timer(const Duration(milliseconds: 250), () {
      _debounce = null;
      _debounceWait = null;
      waiting.complete(true);
    });

    setState(() {
      _loading = true;
      _failed = false;
      _empty = false;
    });

    final shouldLoad = await waiting.future;

    if (!shouldLoad || !mounted || epoch != _requestEpoch || !field.enabled) {
      return const [];
    }

    try {
      final options = await field.loadOptions(query.text);

      if (!mounted || epoch != _requestEpoch) {
        return const [];
      }

      setState(() {
        _loading = false;
        _empty = options.isEmpty;
      });

      return options;
    } catch (_) {
      if (mounted && epoch == _requestEpoch) {
        setState(() {
          _loading = false;
          _failed = true;
        });

      }

      return const [];
    }

  }

  @override
  Widget build(BuildContext context) {
    return RawAutocomplete<T>(
      textEditingController: _controller,
      focusNode: _focusNode,
      displayStringForOption: field.displayString,
      optionsBuilder: _options,
      onSelected: (option) {
        if (!field.enabled) {
          return;
        }

        widget.onSelected(option);

        if (field.clearOnSelect) {
          _controller.clear();
        }

      },

      fieldViewBuilder: (context, controller, focusNode, submit) {
        return SizedBox(
          key: _measureKey,
          child: SsTextField(
            label: field.label,
            controller: controller,
            focusNode: focusNode,
            enabled: field.enabled,
            error: widget.errorText ?? (_failed ? field.failureText : null),
            helper: _empty ? field.emptyText : null,
            suffix: _loading
                ? Center(
                    widthFactor: 1,
                    child: SsSpinner(size: 16, label: field.loadingText),
                  )
                : null,
            onChanged: widget.onQueryChanged,
            validator: (query) {
              if (widget.selectedValue == null &&
                  query != null &&
                  query.trim().isNotEmpty) {
                return field.selectionRequiredText;
              }

              return null;
            },

            onSubmitted: (_) {
              submit();
            },

          ),
        );
      },

      optionsViewBuilder: (context, select, options) {
        final box =
            _measureKey.currentContext?.findRenderObject() as RenderBox?;
        final width = box?.size.width ?? 280;

        return Align(
          alignment: AlignmentDirectional.topStart,
          child: Material(
            type: MaterialType.transparency,
            child: SizedBox(
              width: width,
              child: SsSurface(
                child: _OptionsList<T>(
                  options: options.toList(growable: false),
                  displayString: field.displayString,
                  onSelected: select,
                ),
              ),
            ),
          ),
        );
      },

    );
  }

}

class _OptionsList<T extends Object> extends StatefulWidget {
  const _OptionsList({
    required this.options,
    required this.displayString,
    required this.onSelected,
  });

  final List<T> options;
  final String Function(T) displayString;
  final ValueChanged<T> onSelected;

  @override
  State<_OptionsList<T>> createState() {
    return _OptionsListState<T>();
  }

}

class _OptionsListState<T extends Object> extends State<_OptionsList<T>> {
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
    final textScale = MediaQuery.textScalerOf(context).scale(14) / 14;
    final extent = math.max(44.0, 24 + 20 * textScale);

    if (highlighted != _lastHighlighted) {
      _lastHighlighted = highlighted;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted || !_scroll.hasClients) {
          return;
        }

        final top = highlighted * extent;
        final bottom = top + extent;
        final viewport = _scroll.position.viewportDimension;
        final desired = top < _scroll.offset
            ? top
            : math.max(_scroll.offset, bottom - viewport);
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

            child: Text(
              widget.displayString(option),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
          );
        },

      ),
    );
  }

}
