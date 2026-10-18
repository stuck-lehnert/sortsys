import 'package:flutter/widgets.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

class TablerIcon extends StatelessWidget {
  const TablerIcon(this.name, {super.key, this.size = 22, this.color});

  final String name;
  final double size;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    return SsIcon(name, size: size, color: color);
  }
}
