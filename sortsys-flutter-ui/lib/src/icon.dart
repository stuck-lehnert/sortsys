import 'package:flutter/widgets.dart';
import 'package:flutter_svg/flutter_svg.dart';

import 'theme.dart';

const _carbonIconNames = {
  'archive',
  'contact',
  'customer',
  'delivery-note',
  'edit',
  'lock',
  'magic',
  'overflow-menu-vertical',
  'price-record',
  'product',
  'project',
  'regie-report',
  'resume',
  'task-complete',
  'tool',
  'trash-can',
  'user',
  'vendor',
};

const ssIconNames = {
  ..._carbonIconNames,
  'alert-triangle',
  'building',
  'calendar',
  'check',
  'chevron-down',
  'chevron-left',
  'chevron-right',
  'eye',
  'eye-off',
  'file-text',
  'file-type-pdf',
  'folder',
  'layout-dashboard',
  'logout',
  'menu-2',
  'moon',
  'package',
  'plus',
  'refresh',
  'robot',
  'search',
  'settings',
  'sun',
  'tools',
  'truck-delivery',
  'users',
  'x',
};

class SsIcon extends StatelessWidget {
  const SsIcon(
    this.name, {
    super.key,
    this.size = 20,
    this.color,
    this.semanticLabel,
  });

  final String name;
  final double size;
  final Color? color;
  final String? semanticLabel;

  @override
  Widget build(BuildContext context) {
    if (!ssIconNames.contains(name)) {
      throw ArgumentError.value(name, 'name', 'Unknown sortsys icon');
    }

    final family = _carbonIconNames.contains(name) ? 'carbon' : 'tabler';
    final assetName = name == 'user' && size == 16 ? 'user-16' : name;

    return SvgPicture.asset(
      'assets/icons/$family/$assetName.svg',
      package: 'sortsys_ui',
      width: size,
      height: size,
      colorFilter: ColorFilter.mode(
        color ?? IconTheme.of(context).color ?? SsTheme.of(context).text,
        BlendMode.srcIn,
      ),
      semanticsLabel: semanticLabel,
      excludeFromSemantics: semanticLabel == null,
    );
  }
}
