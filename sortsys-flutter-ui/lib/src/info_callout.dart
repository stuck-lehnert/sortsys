import 'package:flutter/widgets.dart';

import 'icon.dart';
import 'theme.dart';

class SsInfoCallout extends StatelessWidget {
  const SsInfoCallout({super.key, required this.child, this.icon});

  final Widget child;
  final String? icon;

  @override
  Widget build(BuildContext context) {
    final colors = SsTheme.of(context);
    final borderColor = Color.lerp(colors.border, colors.accent, 0.4)!;
    final background = Color.lerp(colors.surface, colors.accent, 0.08)!;
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
        style: colors.body.copyWith(fontSize: 14.08),
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
                    child: SsIcon(
                      icon!,
                      size: 15,
                      color: colors.strongAccent,
                    ),
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
