import 'package:flutter/widgets.dart';

import 'icon.dart';
import 'theme.dart';

enum SsCalloutKind { info, warning, error }

class SsInfoCallout extends StatelessWidget {
  const SsInfoCallout({
    super.key,
    required this.child,
    this.icon,
    this.kind = SsCalloutKind.info,
  });

  final Widget child;
  final String? icon;
  final SsCalloutKind kind;

  @override
  Widget build(BuildContext context) {
    final colors = SsTheme.of(context);
    final warning = kind == SsCalloutKind.warning;
    final error = kind == SsCalloutKind.error;
    final accent = error
        ? colors.danger
        : warning
        ? colors.warning
        : colors.accent;
    final borderColor = Color.lerp(
      colors.border,
      accent,
      error
          ? 0.46
          : warning
          ? 0.55
          : 0.4,
    )!;
    final background = Color.lerp(
      colors.surface,
      accent,
      error
          ? 0.1
          : warning
          ? 0.09
          : 0.08,
    )!;
    final iconColor = error
        ? Color.lerp(colors.text, accent, 0.78)!
        : warning
        ? Color.lerp(colors.text, accent, 0.85)!
        : colors.strongAccent;
    final textColor = error
        ? Color.lerp(colors.text, accent, 0.76)!
        : colors.body.color;
    final borderSide = BorderSide(color: borderColor);

    return Container(
      decoration: BoxDecoration(
        color: background,
        border: BorderDirectional(
          start: BorderSide(color: borderColor, width: 4),
          top: borderSide,
          end: borderSide,
          bottom: borderSide,
        ),
      ),
      padding: const EdgeInsets.symmetric(horizontal: 10.88, vertical: 9.6),
      child: DefaultTextStyle(
        style: colors.body.copyWith(fontSize: 14.08, color: textColor),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (icon != null) ...[
              Padding(
                padding: const EdgeInsets.only(top: 1.28),
                child: SizedBox.square(
                  dimension: 16,
                  child: Align(
                    alignment: AlignmentDirectional.topStart,
                    child: SsIcon(icon!, size: 15, color: iconColor),
                  ),
                ),
              ),
              const SizedBox(width: 8.8),
            ],
            Expanded(child: child),
          ],
        ),
      ),
    );
  }
}
