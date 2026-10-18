import 'package:flutter/widgets.dart';

import 'pressable.dart';
import 'theme.dart';

class SsSurface extends StatelessWidget {
  const SsSurface({
    super.key,
    required this.child,
    this.padding = EdgeInsets.zero,
  });

  final Widget child;
  final EdgeInsetsGeometry padding;

  @override
  Widget build(BuildContext context) {
    final colors = SsTheme.of(context);

    return DecoratedBox(
      decoration: BoxDecoration(
        color: colors.surface,
        border: Border.all(color: colors.border),
      ),
      child: Padding(
        padding: padding.add(const EdgeInsets.all(1)),
        child: child,
      ),
    );
  }
}

class SsListTile extends StatelessWidget {
  const SsListTile({
    super.key,
    required this.title,
    this.subtitle,
    this.leading,
    this.trailing,
    this.onTap,
    this.selected = false,
  });

  final Widget title;
  final Widget? subtitle;
  final Widget? leading;
  final Widget? trailing;
  final VoidCallback? onTap;
  final bool selected;

  @override
  Widget build(BuildContext context) {
    final colors = SsTheme.of(context);
    final content = Row(
      crossAxisAlignment: CrossAxisAlignment.center,
      children: [
        if (leading != null) ...[leading!, const SizedBox(width: 8.8)],
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              DefaultTextStyle(style: colors.body, child: title),
              if (subtitle != null) ...[
                const SizedBox(height: 3),
                DefaultTextStyle(
                  style: colors.body.copyWith(
                    color: colors.secondaryText,
                    fontSize: 13,
                  ),
                  child: subtitle!,
                ),
              ],
            ],
          ),
        ),
        if (trailing != null) ...[const SizedBox(width: 8.8), trailing!],
      ],
    );

    if (onTap == null) {
      return Padding(padding: const EdgeInsets.all(9.6), child: content);
    }

    return SsPressable(
      onPressed: onTap,
      selected: selected ? true : null,
      builder: (context, state) {
        Color? background;

        if (selected) {
          background = Color.lerp(colors.surface, colors.accent, 0.14);
        } else if (state.hovered || state.pressed) {
          background = colors.mutedSurface;
        }

        return DecoratedBox(
          decoration: BoxDecoration(
            color: background,
            boxShadow: state.focused
                ? [
                    BoxShadow(
                      color: colors.accent.withValues(alpha: 0.36),
                      spreadRadius: 2,
                    ),
                  ]
                : const [],
          ),
          child: Padding(padding: const EdgeInsets.all(9.6), child: content),
        );
      },
    );
  }
}

class SsBadge extends StatelessWidget {
  const SsBadge({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    final colors = SsTheme.of(context);

    return DecoratedBox(
      decoration: BoxDecoration(
        color: colors.mutedSurface,
        border: Border.all(color: colors.border),
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
        child: DefaultTextStyle(
          style: colors.body.copyWith(
            fontSize: 12.48,
            fontWeight: FontWeight.w600,
          ),
          child: child,
        ),
      ),
    );
  }
}
