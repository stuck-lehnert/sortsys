import 'package:flutter/widgets.dart';

import 'pressable.dart';
import 'theme.dart';

class SsOperationalTag extends StatelessWidget {
  const SsOperationalTag({
    super.key,
    required this.child,
    this.leading,
    this.onPressed,
    this.focusNode,
    this.enabled = true,
  });

  final Widget child;
  final Widget? leading;
  final VoidCallback? onPressed;
  final FocusNode? focusNode;
  final bool enabled;

  Widget _content(BuildContext context, SsInteraction interaction) {
    final colors = SsTheme.of(context);
    final foreground = Color.lerp(colors.text, colors.strongAccent, 0.86)!;
    final hovered = enabled && interaction.hovered;
    final background = hovered
        ? Color.lerp(colors.surface, colors.backgroundAccent, 0.56)!
        : Color.lerp(colors.surface, colors.accent, 0.30)!;
    final border = Color.lerp(colors.border, colors.accent, 0.78)!;
    final icon = leading;

    return CustomPaint(
      foregroundPainter: interaction.focused
          ? _OperationalTagFocusPainter(colors.accent)
          : null,
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: background,
          border: Border.all(color: border),
        ),
        child: Padding(
          padding: const EdgeInsets.symmetric(
            horizontal: 10.28,
            vertical: 6.76,
          ),
          child: DefaultTextStyle(
            style: colors.body.copyWith(
              color: foreground,
              fontSize: 12.48,
              fontWeight: FontWeight.w600,
              height: 1,
            ),
            child: icon == null
                ? child
                : Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      IconTheme(
                        data: IconThemeData(size: 14, color: foreground),
                        child: SizedBox(width: 14, height: 14, child: icon),
                      ),
                      const SizedBox(width: 5.44),
                      Flexible(child: child),
                    ],
                  ),
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    if (onPressed == null) {
      return _content(
        context,
        (hovered: false, focused: false, pressed: false),
      );
    }

    return SsPressable(
      onPressed: enabled ? onPressed : null,
      focusNode: focusNode,
      builder: _content,
    );
  }
}

class _OperationalTagFocusPainter extends CustomPainter {
  const _OperationalTagFocusPainter(this.color);

  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = 2;
    final rectangle = (Offset.zero & size).inflate(2);

    canvas.drawRect(rectangle, paint);
  }

  @override
  bool shouldRepaint(covariant _OperationalTagFocusPainter oldDelegate) {
    return oldDelegate.color != color;
  }
}
