import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';

import 'icon.dart';
import 'pressable.dart';
import 'theme.dart';

class SsPagination extends StatelessWidget {
  const SsPagination({
    super.key,
    required this.totalItems,
    required this.page,
    required this.pageSize,
    required this.onPage,
    required this.onPageSize,
    this.pageSizes = const [25, 50, 100],
    this.itemsPerPageText = 'Items per page',
    this.backwardText = 'Previous',
    this.forwardText = 'Next',
    this.itemRangeText,
    this.pageRangeText,
  });

  final int totalItems;
  final int page;
  final int pageSize;
  final List<int> pageSizes;
  final ValueChanged<int> onPage;
  final ValueChanged<int> onPageSize;
  final String itemsPerPageText;
  final String backwardText;
  final String forwardText;
  final String Function(int from, int to, int total)? itemRangeText;
  final String Function(int page, int total)? pageRangeText;

  @override
  Widget build(BuildContext context) {
    if (pageSize <= 0 || totalItems < 0) {
      throw ArgumentError('INVALID_PAGINATION_RANGE');
    }

    final colors = SsTheme.of(context);
    final totalPages = math.max(1, (totalItems / pageSize).ceil());
    final safePage = page.clamp(1, totalPages);
    final from = totalItems == 0 ? 0 : (safePage - 1) * pageSize + 1;
    final to = math.min(totalItems, safePage * pageSize);
    final summary =
        itemRangeText?.call(from, to, totalItems) ?? '$from-$to / $totalItems';
    final pageSummary =
        pageRangeText?.call(safePage, totalPages) ?? '$safePage / $totalPages';
    final controls = Wrap(
      spacing: 6.4,
      runSpacing: 6.4,
      crossAxisAlignment: WrapCrossAlignment.center,
      children: [
        Wrap(
          spacing: 4.16,
          runSpacing: 4.16,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            Text(itemsPerPageText),
            _PageSizeMenu(
              value: pageSize,
              options: pageSizes,
              label: itemsPerPageText,
              onChanged: onPageSize,
            ),
          ],
        ),
        _PageButton(
          label: backwardText,
          onPressed: safePage == 1
              ? null
              : () {
                  onPage(safePage - 1);
                },
        ),
        Text(pageSummary),
        _PageButton(
          label: forwardText,
          onPressed: safePage == totalPages
              ? null
              : () {
                  onPage(safePage + 1);
                },
        ),
      ],
    );

    return DefaultTextStyle(
      style: colors.body.copyWith(fontSize: 13.12, color: colors.secondaryText),
      child: DecoratedBox(
        decoration: BoxDecoration(border: Border.all(color: colors.border)),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 10.28, vertical: 9),
          child: LayoutBuilder(
            builder: (context, constraints) {
              final scale =
                  MediaQuery.textScalerOf(context).scale(13.12) / 13.12;

              if (constraints.maxWidth < 720 || scale > 1.4) {
                return Wrap(
                  spacing: 12,
                  runSpacing: 12,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [Text(summary), controls],
                );
              }

              return Row(
                children: [
                  Text(summary),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Align(
                      alignment: AlignmentDirectional.centerEnd,
                      heightFactor: 1,
                      child: controls,
                    ),
                  ),
                ],
              );
            },
          ),
        ),
      ),
    );
  }
}

class _PageButton extends StatelessWidget {
  const _PageButton({required this.label, required this.onPressed});

  final String label;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    final colors = SsTheme.of(context);

    return SsPressable(
      onPressed: onPressed,
      builder: (context, state) {
        final highlighted = state.hovered || state.pressed;
        final background = highlighted
            ? Color.lerp(colors.surface, colors.mutedSurface, 0.66)
            : Color.alphaBlend(
                colors.mutedSurface.withValues(alpha: 0.88),
                colors.surface,
              );

        return Opacity(
          opacity: onPressed == null ? 0.58 : 1,
          child: DecoratedBox(
            decoration: BoxDecoration(
              color: background,
              border: Border.all(
                color: highlighted
                    ? Color.lerp(colors.border, colors.accent, 0.32)!
                    : colors.border,
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
                horizontal: 8.2,
                vertical: 4.2,
              ),
              child: Text(label, style: colors.body.copyWith(fontSize: 13.12)),
            ),
          ),
        );
      },
    );
  }
}

class _PageSizeMenu extends StatefulWidget {
  const _PageSizeMenu({
    required this.value,
    required this.options,
    required this.label,
    required this.onChanged,
  });

  final int value;
  final List<int> options;
  final String label;
  final ValueChanged<int> onChanged;

  @override
  State<_PageSizeMenu> createState() {
    return _PageSizeMenuState();
  }
}

class _PageSizeMenuState extends State<_PageSizeMenu> {
  Future<void> _choose() async {
    final target = context.findRenderObject();
    final overlay = Overlay.of(context).context.findRenderObject();

    if (target is! RenderBox || overlay is! RenderBox) {
      return;
    }

    final colors = SsTheme.of(context);
    final topLeft = target.localToGlobal(Offset.zero, ancestor: overlay);
    final rect = topLeft & target.size;
    final position = RelativeRect.fromRect(rect, Offset.zero & overlay.size);

    final selected = await showMenu<int>(
      context: context,
      position: position,
      initialValue: widget.value,
      color: colors.surface,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
      shape: Border.all(color: colors.border),
      constraints: const BoxConstraints(minWidth: 64, maxWidth: 160),
      items: [
        for (final size in widget.options)
          PopupMenuItem(
            value: size,
            height: 32,
            padding: const EdgeInsets.symmetric(horizontal: 8),
            child: Text('$size', style: colors.body.copyWith(fontSize: 13.12)),
          ),
      ],
    );

    if (!mounted || selected == null || !widget.options.contains(selected)) {
      return;
    }

    widget.onChanged(selected);
  }

  @override
  Widget build(BuildContext context) {
    final colors = SsTheme.of(context);

    return SsPressable(
      semanticLabel: '${widget.label}: ${widget.value}',
      onPressed: () {
        unawaited(_choose());
      },

      builder: (context, state) {
        return DecoratedBox(
          decoration: BoxDecoration(
            color: colors.surface,
            border: Border.all(color: colors.border),
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
            padding: const EdgeInsets.symmetric(horizontal: 4.2, vertical: 2.6),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  '${widget.value}',
                  style: colors.body.copyWith(fontSize: 13.12),
                ),
                const SizedBox(width: 2),
                const SsIcon('chevron-down', size: 12),
              ],
            ),
          ),
        );
      },
    );
  }
}
