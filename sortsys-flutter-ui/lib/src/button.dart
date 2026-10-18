import 'package:flutter/material.dart' show Tooltip;
import 'package:flutter/widgets.dart';

import 'icon.dart';
import 'pressable.dart';
import 'theme.dart';

enum SsButtonKind { primary, secondary, ghost, danger }

enum SsButtonSize { regular, small }

class SsButton extends StatelessWidget {
  const SsButton({
    super.key,
    required this.child,
    this.onPressed,
    this.kind = SsButtonKind.primary,
    this.size = SsButtonSize.regular,
    this.selected = false,
    this.padding = const EdgeInsets.symmetric(
      horizontal: 11.84,
      vertical: 6.08,
    ),
    this.alignment = Alignment.center,
    this.semanticLabel,
    this.focusNode,
  });

  final Widget child;
  final VoidCallback? onPressed;
  final SsButtonKind kind;
  final SsButtonSize size;
  final bool selected;
  final EdgeInsetsGeometry padding;
  final AlignmentGeometry alignment;
  final String? semanticLabel;
  final FocusNode? focusNode;

  @override
  Widget build(BuildContext context) {
    final colors = SsTheme.of(context);
    final small = size == SsButtonSize.small;
    const regularPadding = EdgeInsets.symmetric(
      horizontal: 11.84,
      vertical: 6.08,
    );
    const smallPadding = EdgeInsets.symmetric(horizontal: 8.96, vertical: 4.16);
    final contentPadding = small && padding == regularPadding
        ? smallPadding
        : padding;

    return SsPressable(
      onPressed: onPressed,
      focusNode: focusNode,
      semanticLabel: semanticLabel,
      selected: selected ? true : null,
      builder: (context, state) {
        final paint = _buttonPaint(colors, kind, state);
        final background = selected
            ? Color.alphaBlend(
                colors.accent.withValues(alpha: 0.14),
                paint.background,
              )
            : paint.background;
        final ring = kind == SsButtonKind.primary
            ? colors.strongAccent.withValues(alpha: 0.62)
            : colors.accent.withValues(alpha: 0.36);

        return Opacity(
          opacity: onPressed == null ? 0.58 : 1,
          child: DecoratedBox(
            decoration: BoxDecoration(
              color: background,
              border: Border.all(color: paint.border),
              boxShadow: state.focused
                  ? [BoxShadow(color: ring, spreadRadius: 3)]
                  : const [],
            ),
            child: ConstrainedBox(
              constraints: BoxConstraints(minHeight: small ? 27.52 : 32),
              child: Padding(
                padding: contentPadding.add(const EdgeInsets.all(1)),
                child: Align(
                  alignment: alignment,
                  widthFactor: 1,
                  heightFactor: 1,
                  child: IconTheme(
                    data: IconThemeData(color: paint.foreground, size: 20),
                    child: DefaultTextStyle(
                      style: colors.body.copyWith(
                        color: paint.foreground,
                        fontSize: small ? 12.48 : 14.08,
                        height: 1.1,
                        fontWeight: FontWeight.w600,
                      ),
                      child: child,
                    ),
                  ),
                ),
              ),
            ),
          ),
        );
      },
    );
  }
}

typedef _ButtonPaint = ({Color background, Color border, Color foreground});

_ButtonPaint _buttonPaint(
  SsColors colors,
  SsButtonKind kind,
  SsInteraction state,
) {
  final hover = state.hovered;
  final pressed = state.pressed;
  final backgroundAccent = colors.brightness == Brightness.dark
      ? const Color(0xff1a1a1a)
      : const Color(0xfff3f7fc);
  var background = colors.mutedSurface;
  var border = colors.border;
  var foreground = colors.text;

  if (kind == SsButtonKind.primary) {
    background = Color.lerp(colors.accent, colors.strongAccent, 0.88)!;
    border = Color.lerp(const Color(0xff0b2d5c), colors.strongAccent, 0.78)!;
    foreground = colors.onAccent;

    if (hover || pressed) {
      border = Color.lerp(
        const Color(0xff082349),
        colors.strongAccent,
        pressed ? 0.75 : 0.84,
      )!;
      background = pressed
          ? Color.lerp(const Color(0xff082349), colors.strongAccent, 0.84)!
          : Color.lerp(colors.strongAccent, colors.accent, 0.55)!;
    }
  } else if (kind == SsButtonKind.danger) {
    background = Color.lerp(
      colors.surface,
      colors.danger,
      hover ? 0.18 : 0.14,
    )!;
    border = Color.lerp(colors.border, colors.danger, hover ? 0.60 : 0.45)!;
    foreground = Color.lerp(colors.text, colors.danger, 0.78)!;
  } else {
    if (kind == SsButtonKind.secondary) {
      background = Color.lerp(colors.surface, backgroundAccent, 0.58)!;
      border = Color.lerp(colors.border, colors.accent, hover ? 0.48 : 0.30)!;
    } else {
      background = const Color(0x00000000);

      if (hover) {
        border = Color.lerp(colors.border, colors.accent, 0.32)!;
        foreground = Color.lerp(colors.text, colors.strongAccent, 0.70)!;
      }
    }

    if (hover || pressed) {
      background = Color.lerp(
        colors.surface,
        backgroundAccent,
        pressed ? 0.82 : 0.75,
      )!;
    }
  }

  if (state.focused && kind != SsButtonKind.primary) {
    border = Color.lerp(colors.border, colors.accent, 0.56)!;
  }

  return (background: background, border: border, foreground: foreground);
}

class SsIconButton extends StatelessWidget {
  const SsIconButton({
    super.key,
    required this.icon,
    required this.label,
    this.onPressed,
    this.focusNode,
    this.borderless = false,
    this.iconSize = 20,
    this.tooltip,
  });

  final String icon;
  final String label;
  final VoidCallback? onPressed;
  final FocusNode? focusNode;
  final bool borderless;
  final double iconSize;
  final String? tooltip;

  @override
  Widget build(BuildContext context) {
    final colors = SsTheme.of(context);

    return Tooltip(
      message: tooltip ?? label,
      decoration: BoxDecoration(color: colors.text),
      textStyle: colors.body.copyWith(color: colors.surface, fontSize: 12),
      child: SsPressable(
        onPressed: onPressed,
        focusNode: focusNode,
        semanticLabel: label,
        builder: (context, state) {
          final paint = _buttonPaint(colors, SsButtonKind.ghost, state);

          return Opacity(
            opacity: onPressed == null ? 0.58 : 1,
            child: DecoratedBox(
              decoration: BoxDecoration(
                color: paint.background,
                border: Border.all(
                  color: borderless && !state.focused
                      ? const Color(0x00000000)
                      : paint.border,
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
              child: ConstrainedBox(
                constraints: const BoxConstraints(
                  minWidth: 28.8,
                  minHeight: 28.8,
                ),
                child: Padding(
                  padding: const EdgeInsets.all(2.6),
                  child: Center(
                    widthFactor: 1,
                    heightFactor: 1,
                    child: SsIcon(
                      icon,
                      size: iconSize,
                      color: paint.foreground,
                    ),
                  ),
                ),
              ),
            ),
          );
        },
      ),
    );
  }
}
