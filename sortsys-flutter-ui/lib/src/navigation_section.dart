import 'dart:math' as math;

import 'package:flutter/widgets.dart';

import 'icon.dart';
import 'pressable.dart';
import 'theme.dart';

class SsNavigationSection extends StatefulWidget {
  const SsNavigationSection({
    super.key,
    required this.label,
    required this.icon,
    required this.children,
    this.active = false,
    this.initiallyExpanded = false,
  });

  final String label;
  final String icon;
  final List<Widget> children;
  final bool active;
  final bool initiallyExpanded;

  @override
  State<SsNavigationSection> createState() {
    return _SsNavigationSectionState();
  }
}

class _SsNavigationSectionState extends State<SsNavigationSection> {
  late bool _expanded;

  @override
  void initState() {
    super.initState();

    _expanded = widget.active || widget.initiallyExpanded;
  }

  @override
  void didUpdateWidget(covariant SsNavigationSection oldWidget) {
    super.didUpdateWidget(oldWidget);

    if (widget.active && !oldWidget.active) {
      _expanded = true;
    }
  }

  @override
  Widget build(BuildContext context) {
    final colors = SsTheme.of(context);

    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Semantics(
          expanded: _expanded,
          child: SsPressable(
            onPressed: () {
              setState(() {
                _expanded = !_expanded;
              });
            },

            builder: (context, state) {
              return DecoratedBox(
                decoration: BoxDecoration(
                  color: state.hovered ? colors.mutedSurface : null,
                  border: state.focused
                      ? Border.all(color: colors.accent)
                      : null,
                ),
                child: Padding(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 10.56,
                    vertical: 8.8,
                  ),
                  child: DefaultTextStyle(
                    style: colors.body,
                    child: Row(
                      children: [
                        SsIcon(widget.icon),
                        const SizedBox(width: 8.8),
                        Expanded(
                          child: Text(
                            widget.label,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                        const SizedBox(width: 8.8),
                        SsIcon(
                          _expanded ? 'chevron-down' : 'chevron-right',
                          size: 16,
                          color: colors.text.withValues(alpha: 0.62),
                        ),
                      ],
                    ),
                  ),
                ),
              );
            },
          ),
        ),
        if (_expanded)
          Padding(
            padding: const EdgeInsetsDirectional.only(start: 11.2),
            child: CustomPaint(
              painter: _NavigationGuide(colors.border),
              child: Padding(
                padding: const EdgeInsetsDirectional.only(start: 5.8),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: widget.children,
                ),
              ),
            ),
          ),
      ],
    );
  }
}

class _NavigationGuide extends CustomPainter {
  const _NavigationGuide(this.color);

  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = color
      ..strokeWidth = 1;
    var top = 0.0;

    while (top < size.height) {
      canvas.drawLine(
        Offset(0.5, top),
        Offset(0.5, math.min(top + 3, size.height)),
        paint,
      );
      top += 6;
    }
  }

  @override
  bool shouldRepaint(_NavigationGuide oldDelegate) {
    return color != oldDelegate.color;
  }
}
