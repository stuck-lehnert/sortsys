import 'dart:async';
import 'dart:ui' show SemanticsRole;

import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';

import 'pressable.dart';
import 'theme.dart';

class SsTab<T extends Object> {
  const SsTab({required this.value, required this.label});

  final T value;
  final String label;
}

class SsTabs<T extends Object> extends StatefulWidget {
  const SsTabs({
    super.key,
    required this.tabs,
    required this.value,
    required this.onChanged,
  });

  final List<SsTab<T>> tabs;
  final T? value;
  final ValueChanged<T> onChanged;

  @override
  State<SsTabs<T>> createState() {
    return _SsTabsState<T>();
  }
}

class _SsTabsState<T extends Object> extends State<SsTabs<T>> {
  final _focusNodes = <T, FocusNode>{};
  final _keys = <T, GlobalKey>{};

  @override
  void initState() {
    super.initState();

    _syncTabs();
  }

  @override
  void didUpdateWidget(covariant SsTabs<T> oldWidget) {
    super.didUpdateWidget(oldWidget);

    _syncTabs();
  }

  void _syncTabs() {
    final values = widget.tabs.map((tab) {
      return tab.value;
    }).toSet();

    final removed = _focusNodes.keys
        .where((value) {
          return !values.contains(value);
        })
        .toList(growable: false);

    for (final value in removed) {
      _focusNodes.remove(value)?.dispose();
      _keys.remove(value);
    }

    for (final tab in widget.tabs) {
      _focusNodes.putIfAbsent(tab.value, () {
        return FocusNode();
      });

      _keys.putIfAbsent(tab.value, () {
        return GlobalKey();
      });
    }

    final hasSelection = values.contains(widget.value);

    for (var index = 0; index < widget.tabs.length; index += 1) {
      final value = widget.tabs[index].value;
      final reachable = hasSelection ? value == widget.value : index == 0;

      _focusNodes[value]!.skipTraversal = !reachable;
    }
  }

  @override
  void dispose() {
    for (final focus in _focusNodes.values) {
      focus.dispose();
    }

    super.dispose();
  }

  void _selectIndex(int index) {
    if (widget.tabs.isEmpty) {
      return;
    }

    final normalized = index % widget.tabs.length;
    final value = widget.tabs[normalized].value;

    _focusNodes[value]?.requestFocus();

    if (value != widget.value) {
      widget.onChanged(value);
    }

    WidgetsBinding.instance.addPostFrameCallback((_) {
      final tabContext = _keys[value]?.currentContext;

      if (mounted && tabContext != null) {
        unawaited(Scrollable.ensureVisible(tabContext));
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final colors = SsTheme.of(context);

    return Padding(
      padding: const EdgeInsets.only(bottom: 9.6),
      child: DecoratedBox(
        decoration: BoxDecoration(
          border: Border(bottom: BorderSide(color: colors.border)),
        ),
        child: Padding(
          padding: const EdgeInsets.only(bottom: 6.6),
          child: SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: Semantics(
              role: SemanticsRole.tabBar,
              container: true,
              explicitChildNodes: true,
              child: Row(
                children: [
                  for (
                    var index = 0;
                    index < widget.tabs.length;
                    index += 1
                  ) ...[
                    if (index != 0) const SizedBox(width: 6.4),
                    _tab(context, widget.tabs[index], index),
                  ],
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _tab(BuildContext context, SsTab<T> tab, int index) {
    final colors = SsTheme.of(context);
    final selected = tab.value == widget.value;

    return MergeSemantics(
      child: CallbackShortcuts(
        bindings: {
          const SingleActivator(LogicalKeyboardKey.arrowRight): () {
            _selectIndex(index + 1);
          },

          const SingleActivator(LogicalKeyboardKey.arrowLeft): () {
            _selectIndex(index - 1);
          },

          const SingleActivator(LogicalKeyboardKey.home): () {
            _selectIndex(0);
          },

          const SingleActivator(LogicalKeyboardKey.end): () {
            _selectIndex(widget.tabs.length - 1);
          },
        },
        child: Semantics(
          role: SemanticsRole.tab,
          selected: selected,
          child: SsPressable(
            key: _keys[tab.value],
            focusNode: _focusNodes[tab.value],
            selected: selected,
            onPressed: () {
              _selectIndex(index);
            },

            builder: (context, state) {
              Color? background;

              if (selected) {
                background = Color.lerp(colors.surface, colors.accent, 0.16);
              } else if (state.hovered) {
                background = colors.mutedSurface;
              }

              return DecoratedBox(
                decoration: BoxDecoration(
                  color: background,
                  border: Border.all(
                    color: selected
                        ? Color.lerp(colors.border, colors.accent, 0.30)!
                        : const Color(0x00000000),
                  ),
                  boxShadow: state.focused
                      ? [
                          BoxShadow(
                            color: colors.accent.withValues(alpha: 0.36),
                            spreadRadius: 3,
                          ),
                        ]
                      : const [],
                ),
                child: Padding(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 13.48,
                    vertical: 8.04,
                  ),
                  child: Text(
                    tab.label,
                    style: colors.body.copyWith(
                      fontSize: 14.4,
                      fontWeight: FontWeight.w600,
                      color: selected ? colors.text : colors.secondaryText,
                    ),
                  ),
                ),
              );
            },
          ),
        ),
      ),
    );
  }
}
