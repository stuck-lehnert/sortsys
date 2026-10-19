import 'package:flutter/widgets.dart';
import 'package:provider/provider.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

import '../../api/generated/api.g.dart';
import '../../api/generated/models.g.dart' as models;
import '../../state/session_controller.dart';
import '../../ui/query_view.dart';
import '../entities/entity_presentation.dart';

models.ProductsVendorsGetInput vendorDetailInput(String id) {
  if (id.isEmpty) {
    throw const FormatException('INVALID_VENDOR_ID');
  }

  return models.ProductsVendorsGetInput(id: id);
}

class VendorDetailScreen extends StatelessWidget {
  const VendorDetailScreen({super.key, required this.id});

  final String id;

  @override
  Widget build(BuildContext context) {
    final session = context.watch<SessionController>();
    final binding = session.binding;

    if (!session.authenticated ||
        session.info?.can('view:productVendors') != true) {
      return const EntityAccessDenied();
    }

    return QueryView<models.ProductVendor>(
      requestKey: ApiQueries.productsVendorsGet.path,
      identity: id,
      load: (current) async {
        void checkScope() {
          if (!current.authenticated ||
              current.binding != binding ||
              current.info?.can('view:productVendors') != true) {
            throw StateError('VENDOR_DETAIL_SCOPE_CHANGED');
          }
        }

        checkScope();

        final vendor = await current.read(
          ApiQueries.productsVendorsGet,
          vendorDetailInput(id),
        );
        checkScope();

        if (vendor.id != id) {
          throw const FormatException('VENDOR_RESPONSE_ID_MISMATCH');
        }

        return vendor;
      },
      builder: (context, vendor, reload) {
        return VendorDetailLayout(vendor: vendor);
      },
    );
  }
}

class VendorDetailLayout extends StatelessWidget {
  const VendorDetailLayout({super.key, required this.vendor});

  final models.ProductVendor vendor;

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: EdgeInsets.zero,
      children: [SsPageHeader(title: vendor.name)],
    );
  }
}
