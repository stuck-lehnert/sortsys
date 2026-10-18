import 'package:flutter/widgets.dart';

import 'theme.dart';

class SsPageHeader extends StatelessWidget {
  const SsPageHeader({
    super.key,
    required this.title,
    this.subtitle,
    this.actions,
  });

  final String title;
  final String? subtitle;
  final Widget? actions;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 1.6, bottom: 4),
      child: LayoutBuilder(
        builder: (context, constraints) {
          final colors = SsTheme.of(context);
          final scale = MediaQuery.textScalerOf(context).scale(14) / 14;
          final compact = constraints.maxWidth < 640 || scale > 1.4;
          final viewport = MediaQuery.sizeOf(context).width;
          final fontSize = (17.6 + viewport * 0.0045).clamp(20.0, 24.8);
          final heading = Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                title,
                style: colors.heading.copyWith(
                  fontSize: fontSize,
                  letterSpacing: -0.015 * fontSize,
                ),
              ),
              if (subtitle != null && subtitle!.isNotEmpty) ...[
                const SizedBox(height: 2.56),
                Text(
                  subtitle!,
                  style: colors.body.copyWith(
                    color: colors.secondaryText,
                    fontSize: 13.76,
                    height: 1.35,
                  ),
                ),
              ],
            ],
          );
          final controls = actions;

          if (controls == null) {
            return heading;
          }

          if (compact) {
            return Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [heading, const SizedBox(height: 8), controls],
            );
          }

          return Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(child: heading),
              const SizedBox(width: 12),
              ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 320),
                child: controls,
              ),
            ],
          );
        },
      ),
    );
  }
}
