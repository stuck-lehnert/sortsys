import 'package:flutter/widgets.dart';

import 'pressable.dart';
import 'theme.dart';

class SsLink extends StatelessWidget {
  const SsLink({
    super.key,
    required this.child,
    this.onPressed,
    this.uri,
    this.semanticLabel,
  });

  final Widget child;
  final VoidCallback? onPressed;
  final Uri? uri;
  final String? semanticLabel;

  @override
  Widget build(BuildContext context) {
    final colors = SsTheme.of(context);
    final inherited = DefaultTextStyle.of(context).style;

    return SsPressable(
      isLink: true,
      linkUrl: uri,
      semanticLabel: semanticLabel,
      onPressed: onPressed,
      builder: (context, interaction) {
        var opacity = 1.0;

        if (onPressed == null) {
          opacity = 0.58;
        } else if (interaction.hovered) {
          opacity = 0.8;
        }

        return Opacity(
          opacity: opacity,
          child: DecoratedBox(
            decoration: BoxDecoration(
              boxShadow: interaction.focused
                  ? [
                      BoxShadow(
                        color: colors.accent.withValues(alpha: 0.36),
                        spreadRadius: 2,
                      ),
                    ]
                  : const [],
            ),
            child: DefaultTextStyle(
              style: inherited.copyWith(
                color: onPressed == null
                    ? colors.secondaryText
                    : colors.strongAccent,
                decoration: TextDecoration.none,
              ),
              child: child,
            ),
          ),
        );
      },
    );
  }
}
