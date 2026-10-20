import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

import '../../state/session_controller.dart';
import '../../ui/text.dart';
import '../vendors/session_vendor_create_dialog.dart';
import 'product_detail_layout.dart';
import 'product_detail_location.dart';
import 'product_detail_menu.dart';
import 'product_edit_action.dart';
import 'product_read_repository.dart';
import 'product_price_history.dart';
import 'product_price_chart.dart';
import 'product_price_dialog.dart';
import 'product_price_form_reads.dart';
import 'product_price_write_coordinator.dart';
import 'secure_product_price_receipts.dart';
import 'session_product_price_access.dart';
import 'session_product_categories_dialog.dart';

class ProductDetailScreen extends HookWidget {
  const ProductDetailScreen({super.key, required this.id});

  final String id;

  @override
  Widget build(BuildContext context) {
    final session = context.watch<SessionController>();
    final binding = session.binding;
    final owner = useRef(id);
    final mounted = useRef(true);
    final revision = useState(0);
    final priceRevision = useState(0);
    final openingPrice = useState(false);
    final openingCategories = useState(false);
    owner.value = id;

    useEffect(() {
      return () {
        mounted.value = false;
      };
    }, const []);

    final allowed = session.authenticated &&
        session.info?.can('view:products') == true;
    final pricesAllowed = session.info?.can('view:productPriceRecords') == true;
    final repository = ProductReadRepository(
      productId: id,
      read: session.read,
      isCurrent: () {
        return mounted.value &&
            owner.value == id &&
            session.authenticated &&
            session.binding == binding;
      },
      can: (permission) {
        return session.info?.can(permission) == true;
      },
    );
    final future = useMemoized(() {
      if (!allowed) {
        return null;
      }

      return repository.get();
    }, [binding, id, allowed, revision.value]);
    final snapshot = useFuture(future, preserveState: false);
    final product = snapshot.data;
    final priceFuture = useMemoized(() {
      if (!allowed || !pricesAllowed || product == null) {
        return null;
      }

      return repository.priceRecords();
    }, [binding, id, allowed, pricesAllowed, product?.id, priceRevision.value]);
    final prices = useFuture(priceFuture, preserveState: false);

    if (!allowed) {
      return Center(
        child: Text(text(context, 'Keine Berechtigung', 'No permission')),
      );
    }

    if (snapshot.hasError) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(text(
              context,
              'Produkt konnte nicht geladen werden.',
              'Product could not be loaded.',
            )),
            const SizedBox(height: 8),
            SsButton(
              kind: SsButtonKind.secondary,
              onPressed: () {
                revision.value++;
              },
              child: Text(text(context, 'Erneut laden', 'Reload')),
            ),
          ],
        ),
      );
    }

    if (product == null) {
      return const Center(child: SsSpinner());
    }

    bool pageCurrent() {
      return mounted.value &&
          owner.value == id &&
          session.authenticated &&
          session.binding == binding;
    }

    bool canRecordPrice() {
      return pageCurrent() &&
          session.info?.can('view:products') == true &&
          session.info?.can('view:productPriceRecords') == true &&
          session.info?.can('manage:productPriceRecords') == true;
    }

    Future<void> recordPrice() async {
      if (openingPrice.value ||
          openingCategories.value ||
          !canRecordPrice() ||
          ModalRoute.of(context)?.isCurrent != true) {
        return;
      }

      var dialogActive = true;
      openingPrice.value = true;

      bool formCurrent() {
        return dialogActive && pageCurrent();
      }

      try {
        final access = sessionProductPriceWriteAccess(
          session,
          productId: id,
          isActive: formCurrent,
        );
        final coordinator = ProductPriceWriteCoordinator(
          access: access,
          receipts: SecureProductPriceReceipts(),
        );
        final reads = ProductPriceFormReads(
          productId: id,
          read: session.read,
          isCurrent: formCurrent,
          can: (permission) {
            return session.info?.can(permission) == true;
          },
        );
        final record = await showProductPriceDialog(
          context,
          product: product,
          coordinator: coordinator,
          queryIdentity: (binding, id),
          isCurrent: formCurrent,
          canCreate: canRecordPrice,
          loadVendors: reads.vendors,
          createVendor: (query) {
            return showSessionVendorCreateDialog(
              context,
              session,
              initialQuery: query,
              isActive: formCurrent,
            );
          },
          canCreateVendor: () {
            return formCurrent() &&
                session.info?.can('view:productVendors') == true &&
                session.info?.can('manage:productVendors') == true;
          },
          changes: session,
        );

        if (record != null && pageCurrent()) {
          priceRevision.value++;
        }
      } finally {
        dialogActive = false;

        if (mounted.value) {
          openingPrice.value = false;
        }
      }
    }

    bool canEditCategories() {
      return pageCurrent() &&
          session.info?.can('view:products') == true &&
          session.info?.can('manage:products') == true;
    }

    Future<void> editCategories() async {
      if (openingCategories.value ||
          openingPrice.value ||
          !canEditCategories() ||
          ModalRoute.of(context)?.isCurrent != true) {
        return;
      }

      final router = GoRouter.of(context);
      final location = router.routeInformationProvider.value.uri;

      if (!isProductDetailLocation(location, id)) {
        return;
      }

      var dialogActive = true;
      openingCategories.value = true;

      bool formCurrent() {
        return dialogActive &&
            pageCurrent() &&
            session.info?.can('view:products') == true &&
            router.routeInformationProvider.value.uri == location;
      }

      try {
        final record = await showSessionProductCategoriesDialog(
          context,
          session,
          product: product,
          isActive: formCurrent,
        );

        if (record != null && record.id == id && formCurrent()) {
          revision.value++;
        }
      } finally {
        dialogActive = false;

        if (mounted.value) {
          openingCategories.value = false;
        }
      }
    }

    return ProductEditAction(
      product: product,
      enabled: !openingPrice.value && !openingCategories.value,
      isActive: pageCurrent,
      onSaved: (record) {
        if (pageCurrent() && record.id == id) {
          revision.value++;
          priceRevision.value++;
        }
      },
      builder: (context, edit, busy) {
        VoidCallback? recordPriceAction;
        VoidCallback? editCategoriesAction;

        if (canRecordPrice()) {
          recordPriceAction = () {
            unawaited(recordPrice());
          };
        }

        if (canEditCategories()) {
          editCategoriesAction = () {
            unawaited(editCategories());
          };
        }

        return ProductDetailLayout(
          key: ValueKey((binding, id)),
          product: product,
          headerActions:
              edit != null ||
                  recordPriceAction != null ||
                  editCategoriesAction != null
              ? ProductDetailMenu(
                  onRecordPrice: recordPriceAction,
                  onEditCategories: editCategoriesAction,
                  onEdit: edit,
                  busy: busy,
                )
              : null,
          priceRecords: prices.data ?? const [],
          priceError: prices.error,
          priceHistory: prices.data?.isNotEmpty == true
              ? ProductPriceHistory(
                  productId: id,
                  baseUnit: product.baseUnit,
                  records: prices.data!,
                  chart: ProductPriceChart(
                    records: sortedProductPrices(prices.data!),
                    baseUnit: product.baseUnit,
                  ),
                )
              : null,
          onRetryPrices: () {
            priceRevision.value++;
          },
        );
      },
    );
  }
}
