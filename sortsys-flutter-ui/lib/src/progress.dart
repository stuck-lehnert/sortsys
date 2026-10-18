import 'dart:math' as math;

import 'package:flutter/widgets.dart';

import 'theme.dart';

class SsSpinner extends StatefulWidget {
  const SsSpinner({super.key, this.size = 18, this.label = 'Loading'});

  final double size;
  final String label;

  @override
  State<SsSpinner> createState() {
    return _SsSpinnerState();
  }

}

class _SsSpinnerState extends State<SsSpinner>
    with SingleTickerProviderStateMixin {
  late final _rotation = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 900),
  )..repeat();

  @override
  void dispose() {
    _rotation.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final colors = SsTheme.of(context);

    return Semantics(
      label: widget.label,
      liveRegion: true,
      child: SizedBox.square(
        dimension: widget.size,
        child: AnimatedBuilder(
          animation: _rotation,
          builder: (context, child) {
            return Transform.rotate(
              angle: _rotation.value * 2 * math.pi,
              child: child,
            );
          },

          child: CustomPaint(painter: _SpinnerPainter(colors.accent)),
        ),
      ),
    );
  }

}

class _SpinnerPainter extends CustomPainter {
  _SpinnerPainter(this.color);

  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final bounds = Offset.zero & size;
    final outline = Paint()
      ..color = color.withValues(alpha: 0.35)
      ..style = PaintingStyle.stroke
      ..strokeWidth = 2;
    final active = Paint()
      ..color = color
      ..strokeWidth = 2;
    final inset = bounds.deflate(1);

    canvas.drawRect(inset, outline);
    canvas.drawLine(inset.topLeft, inset.topRight, active);
  }

  @override
  bool shouldRepaint(_SpinnerPainter oldDelegate) {
    return oldDelegate.color != color;
  }

}
