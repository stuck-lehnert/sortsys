import 'dart:math' as math;

import 'package:flutter/widgets.dart';

import 'theme.dart';

class SsAttributeList extends StatelessWidget {
  const SsAttributeList({super.key, required this.children});

  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    if (children.isEmpty) {
      return const SizedBox.shrink();
    }

    return LayoutBuilder(
      builder: (context, constraints) {
        const gap = 8.8;
        const minimumWidth = 208.0;
        final width = constraints.hasBoundedWidth
            ? constraints.maxWidth
            : MediaQuery.sizeOf(context).width;
        final fittingColumns = ((width + gap) / (minimumWidth + gap)).floor();
        final columns = math.max(1, math.min(children.length, fittingColumns));

        return SizedBox(
          width: width,
          child: Table(
            defaultVerticalAlignment:
                TableCellVerticalAlignment.intrinsicHeight,
            columnWidths: {
              for (var column = 1; column < columns * 2 - 1; column += 2)
                column: const FixedColumnWidth(gap),
            },
            children: [
              for (var start = 0; start < children.length; start += columns)
                TableRow(
                  children: [
                    for (var column = 0; column < columns; column++) ...[
                      if (column > 0) const SizedBox(width: gap),
                      Padding(
                        padding: EdgeInsets.only(top: start == 0 ? 0 : gap),
                        child: start + column < children.length
                            ? children[start + column]
                            : const SizedBox.shrink(),
                      ),
                    ],
                  ],
                ),
            ],
          ),
        );
      },
    );
  }
}

class SsAttribute extends StatelessWidget {
  const SsAttribute({super.key, required this.label, required this.child});

  final String label;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final colors = SsTheme.of(context);

    return DecoratedBox(
      decoration: BoxDecoration(
        color: colors.nestedSurface,
        border: Border.all(color: colors.border),
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(
          vertical: 9.92,
          horizontal: 11.52,
        ).add(const EdgeInsets.all(1)),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              label.toUpperCase(),
              semanticsLabel: label,
              style: colors.body.copyWith(
                color: colors.secondaryText,
                fontSize: 12,
                fontWeight: FontWeight.w600,
                letterSpacing: 0.66,
              ),
            ),
            const SizedBox(height: 4),
            DefaultTextStyle(
              style: colors.body.copyWith(
                fontSize: 15.2,
                fontWeight: FontWeight.w500,
              ),
              child: child,
            ),
          ],
        ),
      ),
    );
  }
}
