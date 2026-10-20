import 'package:flutter/widgets.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

import '../../api/generated/api.g.dart';
import '../../api/generated/models.g.dart' as models;
import '../../state/session_controller.dart';
import '../../ui/query_view.dart';
import '../entities/entity_presentation.dart';
import 'vendor_edit_action.dart';

models.ProductsVendorsGetInput vendorDetailInput(String id) {
  if (id.isEmpty) {
    throw const FormatException('INVALID_VENDOR_ID');
  }

  return models.ProductsVendorsGetInput(id: id);
}

bool isVendorDetailLocation(Uri current, String id) {
  if (id.isEmpty) {
    return false;
  }

  final segments = current.pathSegments;

  return segments.length == 3 &&
      segments[0] == 'products' &&
      segments[1] == 'vendors' &&
      segments[2] == id;
}

String? vendorDeletedLocation(
  Uri current, {
  required String displayedId,
  required String acknowledgedId,
}) {
  if (acknowledgedId != displayedId ||
      !isVendorDetailLocation(current, displayedId)) {
    return null;
  }

  return '/products/vendors';
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
        return VendorDetailLayout(
          vendor: vendor,
          headerActions: VendorEditAction(
            vendor: vendor,
            isActive: () {
              if (!context.mounted) {
                return false;
              }

              return isVendorDetailLocation(
                GoRouter.of(context).routeInformationProvider.value.uri,
                vendor.id,
              );
            },
            onSaved: (updated) {
              reload();
            },
            onDeleted: (acknowledgedId) {
              if (!context.mounted ||
                  !session.authenticated ||
                  session.binding != binding ||
                  session.info?.can('view:productVendors') != true) {
                return;
              }

              final destination = vendorDeletedLocation(
                GoRouter.of(context).routeInformationProvider.value.uri,
                displayedId: vendor.id,
                acknowledgedId: acknowledgedId,
              );

              if (destination != null) {
                context.go(destination);
              }
            },
          ),
        );
      },
    );
  }
}

class VendorDetailLayout extends StatelessWidget {
  const VendorDetailLayout({
    super.key,
    required this.vendor,
    this.headerActions,
  });

  final models.ProductVendor vendor;
  final Widget? headerActions;

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: EdgeInsets.zero,
      children: [SsPageHeader(title: vendor.name, actions: headerActions)],
    );
  }
}
