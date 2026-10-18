import 'package:flutter/widgets.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

import '../../state/session_controller.dart';
import '../../ui/text.dart';

class ProductAreaShell extends StatelessWidget {
  const ProductAreaShell({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    final session = context.watch<SessionController>();
    final path = GoRouterState.of(context).uri.path;
    final tabs = <SsTab<String>>[
      if (session.info?.can('view:products') == true)
        SsTab(value: '/products', label: text(context, 'Produkte', 'Products')),
      if (session.info?.can('view:deliveryNotes') == true)
        SsTab(
          value: '/products/deliveryNotes',
          label: text(context, 'Lieferscheine', 'Delivery notes'),
        ),
      if (session.info?.can('view:productVendors') == true)
        SsTab(
          value: '/products/vendors',
          label: text(context, 'Händler', 'Vendors'),
        ),
    ];
    var selected = '/products';

    if (path == '/products/vendors' || path.startsWith('/products/vendors/')) {
      selected = '/products/vendors';
    } else if (path == '/products/deliveryNotes' ||
        path.startsWith('/products/deliveryNotes/')) {
      selected = '/products/deliveryNotes';
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        SsTabs(
          tabs: tabs,
          value: selected,
          onChanged: (path) {
            context.go(path);
          },
        ),
        Expanded(child: child),
      ],
    );
  }
}
