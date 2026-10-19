import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:provider/provider.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

import '../../state/session_controller.dart';
import '../../ui/text.dart';
import '../vendors/session_vendor_create_dialog.dart';
import 'product_detail_layout.dart';
import 'product_edit_action.dart';
import 'product_read_repository.dart';
import 'product_price_history.dart';
import 'product_price_chart.dart';
import 'product_price_dialog.dart';
import 'product_price_form_reads.dart';
import 'product_price_write_coordinator.dart';
import 'secure_product_price_receipts.dart';
import 'session_product_price_access.dart';

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
      if (openingPrice.value || !canRecordPrice()) {
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

    return ProductDetailLayout(
      key: ValueKey((binding, id)),
      product: product,
      editAction: session.info?.can('manage:products') == true
          ? ProductEditAction(
              product: product,
              onSaved: (record) {
                if (pageCurrent() && record.id == id) {
                  revision.value++;
                  priceRevision.value++;
                }
              },
            )
          : null,
      headerActions: canRecordPrice()
          ? SsButton(
              key: const ValueKey('product-record-price'),
              kind: SsButtonKind.ghost,
              onPressed: openingPrice.value ? null : () {
                unawaited(recordPrice());
              },
              child: Text(text(context, 'Preis verzeichnen', 'Record price')),
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
  }
}
