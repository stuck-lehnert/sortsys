import 'package:flutter/widgets.dart';

import 'theme.dart';

enum SsTagTone { neutral, green, red, magenta, cyan, outline }

enum SsTagSize { medium, small }

class SsTag extends StatelessWidget {
  const SsTag({
    super.key,
    required this.child,
    this.tone = SsTagTone.neutral,
    this.size = SsTagSize.medium,
  });

  final Widget child;
  final SsTagTone tone;
  final SsTagSize size;

  @override
  Widget build(BuildContext context) {
    final colors = SsTheme.of(context);
    final (background, border, foreground) = switch (tone) {
      SsTagTone.outline => (
        colors.mutedSurface.withValues(alpha: 0.88),
        colors.border,
        colors.text,
      ),
      SsTagTone.neutral => (
        _mix(colors.surface, colors.secondaryText, 0.18),
        _mix(colors.border, colors.secondaryText, 0.46),
        colors.text,
      ),
      SsTagTone.green => (
        _mix(colors.surface, colors.success, 0.30),
        _mix(colors.border, colors.success, 0.74),
        _mix(colors.text, colors.success, 0.86),
      ),
      SsTagTone.red => (
        _mix(colors.surface, colors.danger, 0.26),
        _mix(colors.border, colors.danger, 0.78),
        _mix(colors.text, colors.danger, 0.90),
      ),
      SsTagTone.magenta => (
        _mix(colors.surface, const Color(0xff7b54c8), 0.30),
        _mix(colors.border, const Color(0xff7b54c8), 0.78),
        _mix(colors.text, const Color(0xff6e43bc), 0.88),
      ),
      SsTagTone.cyan => (
        _mix(colors.surface, colors.accent, 0.30),
        _mix(colors.border, colors.accent, 0.78),
        _mix(colors.text, colors.strongAccent, 0.86),
      ),
    };
    final small = size == SsTagSize.small;
    final padding = EdgeInsets.symmetric(
      horizontal: small ? 7.68 : 9.28,
      vertical: small ? 4.64 : 5.76,
    );

    return DecoratedBox(
      decoration: BoxDecoration(
        color: background,
        border: Border.all(color: border),
      ),
      child: Padding(
        padding: padding + const EdgeInsets.all(1),
        child: DefaultTextStyle(
          style: colors.body.copyWith(
            color: foreground,
            fontSize: small ? 11.52 : 12.48,
            fontWeight: FontWeight.w600,
            height: 1,
          ),
          child: child,
        ),
      ),
    );
  }
}

Color _mix(Color background, Color tint, double weight) {
  return Color.lerp(background, tint, weight)!;
}
