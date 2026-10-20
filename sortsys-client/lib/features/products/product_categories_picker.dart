import 'package:flutter/material.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

import 'product_categories_matcher.dart';

class ProductCategoriesPicker extends StatefulWidget {
  const ProductCategoriesPicker({
    super.key,
    required this.label,
    required this.options,
    required this.selected,
    required this.queryIdentity,
    required this.onChanged,
    this.enabled = true,
    this.error,
  });

  final String label;
  final List<String> options;
  final List<String> selected;
  final Object queryIdentity;
  final ValueChanged<List<String>> onChanged;
  final bool enabled;
  final String? error;

  @override
  State<ProductCategoriesPicker> createState() {
    return _ProductCategoriesPickerState();
  }
}

class _ProductCategoriesPickerState extends State<ProductCategoriesPicker> {
  final _overlay = OverlayPortalController();
  final _link = LayerLink();
  final _anchor = GlobalKey();
  final _tapGroup = Object();
  final _controller = TextEditingController();
  final _focus = FocusNode();
  final _scroll = ScrollController(keepScrollOffset: false);

  String _query = '';
  int _ownerEpoch = 0;
  bool _closing = false;
  bool _refocusOnTap = false;

  List<String> get _matches {
    return matchProductCategories(
      options: widget.options,
      query: _query,
      selected: widget.selected,
    );
  }

  @override
  void initState() {
    super.initState();

    _focus.addListener(_focusChanged);
  }

  @override
  void didUpdateWidget(covariant ProductCategoriesPicker oldWidget) {
    super.didUpdateWidget(oldWidget);

    final changedOwner = oldWidget.queryIdentity != widget.queryIdentity;

    if (!changedOwner && oldWidget.enabled == widget.enabled) {
      return;
    }

    _ownerEpoch++;

    if (changedOwner) {
      _query = '';
      _controller.clear();
    }

    if (changedOwner || !widget.enabled) {
      _focus.unfocus();
    }

    // Hide outside build; stale options are immediately excluded below.
    _closing = true;
    final epoch = _ownerEpoch;

    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || epoch != _ownerEpoch) {
        return;
      }

      _closing = false;
      _overlay.hide();
    });
  }

  @override
  void dispose() {
    _ownerEpoch++;
    _focus.removeListener(_focusChanged);
    _focus.dispose();
    _controller.dispose();
    _scroll.dispose();

    super.dispose();
  }

  void _focusChanged() {
    if (_focus.hasFocus) {
      _open();
    }
  }

  void _open() {
    if (!mounted || !widget.enabled || _closing || _matches.isEmpty) {
      return;
    }

    _overlay.show();
  }

  void _changeQuery(String value, int epoch) {
    if (!mounted || !widget.enabled || epoch != _ownerEpoch || _closing) {
      return;
    }

    setState(() {
      _query = value;
    });

    if (_matches.isEmpty) {
      _overlay.hide();
      return;
    }

    _open();
  }

  void _toggle(String category, int epoch, String query) {
    if (!mounted ||
        !widget.enabled ||
        epoch != _ownerEpoch ||
        query != _query ||
        !_matches.contains(category)) {
      return;
    }

    final selected = widget.selected;
    final next = selected.contains(category)
        ? selected.where((value) {
            return value != category;
          }).toList()
        : [...selected, category];
    final refocus = _refocusOnTap;
    _refocusOnTap = false;

    widget.onChanged(List<String>.unmodifiable(next));

    if (mounted && refocus) {
      _focus.requestFocus();
    }
  }

  Widget _check(SsColors colors, bool selected) {
    return ExcludeSemantics(
      child: Container(
        width: 16,
        height: 16,
        alignment: Alignment.center,
        decoration: BoxDecoration(
          border: Border.all(
            color: selected
                ? Color.lerp(colors.border, colors.accent, 0.66)!
                : Color.lerp(colors.border, colors.strongBorder, 0.82)!,
          ),
          color: selected
              ? Color.lerp(colors.surface, colors.accent, 0.16)
              : colors.surface,
        ),
        child: Text(
          selected ? '✓' : '',
          textScaler: TextScaler.noScaling,
          style: colors.body.copyWith(
            color: Color.lerp(colors.text, colors.strongAccent, 0.8),
            fontSize: 12.16,
            height: 1,
            fontWeight: FontWeight.w700,
          ),
        ),
      ),
    );
  }

  Widget _option(String category, int index, SsColors colors) {
    final selected = widget.selected.contains(category);
    final epoch = _ownerEpoch;
    final query = _query;

    return Semantics(
      key: ValueKey(('product-category-option', index, category)),
      selected: selected,
      enabled: widget.enabled,
      child: Listener(
        onPointerDown: (_) {
          if (mounted && epoch == _ownerEpoch && widget.enabled) {
            _refocusOnTap = _focus.hasFocus;
          }
        },
        child: TextButton(
          onPressed: widget.enabled
              ? () {
                  _toggle(category, epoch, query);
                }
              : null,
          style: ButtonStyle(
            foregroundColor: WidgetStatePropertyAll(colors.text),
            textStyle: WidgetStatePropertyAll(colors.body),
            minimumSize: const WidgetStatePropertyAll(Size.zero),
            tapTargetSize: MaterialTapTargetSize.shrinkWrap,
            padding: const WidgetStatePropertyAll(
              EdgeInsets.symmetric(horizontal: 7.04, vertical: 6.08),
            ),
            shape: const WidgetStatePropertyAll(RoundedRectangleBorder()),
            side: WidgetStateProperty.resolveWith((states) {
              if (states.contains(WidgetState.focused)) {
                return BorderSide(
                  color: colors.accent.withValues(alpha: 0.36),
                  width: 2,
                );
              }

              return BorderSide.none;
            }),
            overlayColor: WidgetStateProperty.resolveWith((states) {
              if (states.contains(WidgetState.hovered)) {
                return colors.backgroundAccent.withValues(alpha: 0.44);
              }

              return Colors.transparent;
            }),
          ),
          child: Row(
            children: [
              _check(colors, selected),
              const SizedBox(width: 6.4),
              Expanded(child: Text(category, textAlign: TextAlign.left)),
            ],
          ),
        ),
      ),
    );
  }

  Widget _popup(BuildContext context) {
    final box = _anchor.currentContext?.findRenderObject();
    final options = _matches;

    if (_closing ||
        !widget.enabled ||
        options.isEmpty ||
        box is! RenderBox ||
        !box.hasSize) {
      return const SizedBox.shrink();
    }

    final colors = SsTheme.of(context);

    return Positioned.fill(
      child: Stack(
        children: [
          Positioned(
            left: 0,
            top: 0,
            child: CompositedTransformFollower(
              link: _link,
              targetAnchor: Alignment.bottomLeft,
              followerAnchor: Alignment.topLeft,
              offset: const Offset(0, 4),
              showWhenUnlinked: false,
              child: TapRegion(
                groupId: _tapGroup,
                child: Material(
                  type: MaterialType.transparency,
                  child: ConstrainedBox(
                    constraints: const BoxConstraints(maxHeight: 208),
                    child: Container(
                      key: const ValueKey('product-category-options'),
                      width: box.size.width,
                      decoration: BoxDecoration(
                        color: colors.surface,
                        border: Border.all(color: colors.border),
                      ),
                      child: SingleChildScrollView(
                        controller: _scroll,
                        primary: false,
                        padding: const EdgeInsets.all(3.52),
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: [
                            for (var index = 0; index < options.length; index++)
                              _option(options[index], index, colors),
                          ],
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _chip(String category, int index, double width, SsColors colors) {
    return Container(
      key: ValueKey(('product-category-chip', index, category)),
      constraints: BoxConstraints(maxWidth: width),
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3.2),
      decoration: BoxDecoration(
        border: Border.all(
          color: Color.lerp(colors.border, colors.accent, 0.34)!,
        ),
        color: Color.lerp(colors.surface, colors.accent, 0.14),
      ),
      child: Text(category, style: colors.body.copyWith(fontSize: 12.48)),
    );
  }

  @override
  Widget build(BuildContext context) {
    final colors = SsTheme.of(context);
    final epoch = _ownerEpoch;

    return LayoutBuilder(
      builder: (context, constraints) {
        return SsFieldLabel(
          label: widget.label,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              OverlayPortal(
                controller: _overlay,
                overlayChildBuilder: _popup,
                child: CompositedTransformTarget(
                  key: _anchor,
                  link: _link,
                  child: TapRegion(
                    groupId: _tapGroup,
                    onTapOutside: (_) {
                      _overlay.hide();
                    },
                    child: Listener(
                      onPointerDown: (_) {
                        _open();
                      },
                      child: SsTextField(
                        key: ValueKey(widget.queryIdentity),
                        controller: _controller,
                        focusNode: _focus,
                        enabled: widget.enabled,
                        error: widget.error,
                        onChanged: (value) {
                          _changeQuery(value, epoch);
                        },
                      ),
                    ),
                  ),
                ),
              ),
              if (widget.selected.isNotEmpty) ...[
                const SizedBox(height: 5.12),
                Wrap(
                  spacing: 4.8,
                  runSpacing: 4.8,
                  children: [
                    for (var index = 0; index < widget.selected.length; index++)
                      _chip(
                        widget.selected[index],
                        index,
                        constraints.maxWidth,
                        colors,
                      ),
                  ],
                ),
              ],
            ],
          ),
        );
      },
    );
  }
}
