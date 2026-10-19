import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/api.g.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/api/procedure.dart';
import 'package:sortsys_client/features/products/product_price_dialog.dart';
import 'package:sortsys_client/features/products/product_price_receipt.dart';
import 'package:sortsys_client/features/products/product_price_rpc_access.dart';
import 'package:sortsys_client/features/products/product_price_write_coordinator.dart';
import 'package:sortsys_client/features/vendors/vendor_dialog.dart';
import 'package:sortsys_client/features/vendors/vendor_receipt.dart';
import 'package:sortsys_client/features/vendors/vendor_rpc_access.dart';
import 'package:sortsys_client/features/vendors/vendor_write_coordinator.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

void main() {
  setUpAll(() async {
    final fonts = FontLoader('packages/sortsys_ui/Ubuntu');

    for (final weight in ['Regular', 'Medium', 'Bold']) {
      fonts.addFont(
        rootBundle.load(
          'packages/sortsys_ui/assets/fonts/ubuntu/Ubuntu-$weight.ttf',
        ),
      );
    }

    await fonts.load();
  });

  testWidgets(
    'price picker creates through the real vendor dialog and selects after verified readback',
    (tester) async {
      final fixture = _Fixture();
      final readGate = Completer<void>();
      fixture.vendorReadGate = readGate;
      addTearDown(() {
        if (!readGate.isCompleted) {
          readGate.complete();
        }
      });

      await _pump(tester, fixture);
      await tester.enterText(_input('Total price (EUR)'), '12,50');
      await tester.enterText(_input('Quantity'), '2');
      await _openVendor(tester);

      expect(
        tester.widget<TextField>(_input('Name *')).controller?.text,
        'Fresh Vendor',
      );
      await tester.enterText(_input('Description'), ' note ');
      await tester.tap(find.widgetWithText(SsButton, 'Create'));
      await _waitFor(tester, () {
        return fixture.vendorReads == 1;
      });

      expect(find.byType(VendorDialog), findsOneWidget);
      expect(
        find.byKey(const ValueKey('product-price-vendor-clear')),
        findsNothing,
      );

      fixture.vendorReadGate!.complete();
      await _waitFor(tester, () {
        return find.byType(VendorDialog).evaluate().isEmpty;
      });

      expect(fixture.vendorWrites, 1);
      expect(fixture.vendorReads, 1);
      expect(fixture.vendorInput?.name, 'Fresh Vendor');
      expect(fixture.vendorInput?.description.valueOrNull, 'note');
      expect(fixture.lookups, contains('fresh vendor'));
      expect(
        find.byKey(const ValueKey('product-price-vendor-clear')),
        findsOneWidget,
      );
      expect(
        tester.widget<TextField>(_input('Total price (EUR)')).controller?.text,
        '12,50',
      );
      expect(
        tester.widget<TextField>(_input('Quantity')).controller?.text,
        '2',
      );

      await tester.tap(find.widgetWithText(SsButton, 'Save'));
      await _waitFor(tester, () {
        return fixture.saved.isNotEmpty;
      });
      await tester.pumpAndSettle();

      expect(fixture.priceWrites, 1);
      expect(fixture.priceInput?.pricePerBaseUnit, 6.25);
      expect(fixture.priceInput?.vendorId.isAbsent, isTrue);
      expect(fixture.saved.single.id, 'price');
      expect(fixture.vendorStore.encoded, isNull);
      expect(fixture.priceStore.encoded, isNull);
      expect(find.byType(ProductPriceDialog), findsNothing);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'price picker cancellation restores the query and preserves unsaved price fields',
    (tester) async {
      final fixture = _Fixture();
      await _pump(tester, fixture);
      await tester.enterText(_input('Total price (EUR)'), '25');
      await _openVendor(tester);
      await tester.tap(
        find.descendant(
          of: find.byType(VendorDialog),
          matching: find.widgetWithText(SsButton, 'Cancel'),
        ),
      );
      await tester.pumpAndSettle();

      expect(fixture.vendorWrites, 0);
      expect(fixture.priceWrites, 0);
      expect(
        tester.widget<TextField>(_input('Vendors')).controller?.text,
        'Fresh Vendor',
      );
      expect(
        tester.widget<TextField>(_input('Total price (EUR)')).controller?.text,
        '25',
      );
      expect(
        find.byKey(const ValueKey('product-price-vendor-clear')),
        findsNothing,
      );
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'price picker create action follows live vendor permissions without losing price fields',
    (tester) async {
      final fixture = _Fixture();
      fixture.permissions.remove('manage:productVendors');
      await _pump(tester, fixture);
      await tester.enterText(_input('Total price (EUR)'), '18');
      await _search(tester);

      expect(find.text('Create vendor: Fresh Vendor'), findsNothing);

      fixture.permissions.add('manage:productVendors');
      fixture.changes.value++;
      await tester.pumpAndSettle();
      await _search(tester);

      expect(find.text('Create vendor: Fresh Vendor'), findsOneWidget);
      expect(
        tester.widget<TextField>(_input('Total price (EUR)')).controller?.text,
        '18',
      );

      fixture.permissions.remove('view:productVendors');
      fixture.changes.value++;
      await tester.pumpAndSettle();

      expect(find.text('Create vendor: Fresh Vendor'), findsNothing);
      expect(fixture.vendorWrites, 0);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'price picker never selects or replays an unacknowledged vendor creation',
    (tester) async {
      final fixture = _Fixture();
      fixture.loseVendorAcknowledgement = true;
      await _pump(tester, fixture);
      await _openVendor(tester);
      await tester.tap(find.widgetWithText(SsButton, 'Create'));
      await _waitFor(tester, () {
        return find
            .textContaining('server acknowledgement is missing')
            .evaluate()
            .isNotEmpty;
      });

      expect(fixture.vendorWrites, 1);
      expect(fixture.vendorReads, 0);
      expect(
        find.byKey(const ValueKey('product-price-vendor-clear')),
        findsNothing,
      );
      expect(find.text('Verify with read-only request'), findsNothing);

      await tester.tap(
        find.descendant(
          of: find.byType(VendorDialog),
          matching: find.widgetWithText(SsButton, 'Cancel'),
        ),
      );
      await tester.pumpAndSettle();
      await _openVendor(tester);

      expect(
        tester
            .widget<SsButton>(find.widgetWithText(SsButton, 'Create'))
            .onPressed,
        isNull,
      );
      expect(fixture.vendorWrites, 1);
      expect(fixture.vendorStore.encoded, isNotNull);
      expect(fixture.priceWrites, 0);
      expect(tester.takeException(), isNull);
    },
  );
}

Finder _input(String label) {
  return find
      .descendant(
        of: find.widgetWithText(SsFieldLabel, label),
        matching: find.byType(TextField),
      )
      .first;
}

Future<void> _search(WidgetTester tester) async {
  await tester.enterText(_input('Vendors'), ' Fresh Vendor ');
  await tester.pump(const Duration(milliseconds: 300));
  await tester.pumpAndSettle();
}

Future<void> _openVendor(WidgetTester tester) async {
  await _search(tester);
  await tester.tap(find.text('Create vendor: Fresh Vendor'));
  await tester.pumpAndSettle();
}

Future<void> _waitFor(WidgetTester tester, bool Function() ready) async {
  for (var attempt = 0; attempt < 100; attempt++) {
    await tester.pump(const Duration(milliseconds: 20));

    if (ready()) {
      return;
    }
  }

  fail('Nested vendor dialog did not reach the expected state.');
}

Future<void> _pump(WidgetTester tester, _Fixture fixture) async {
  addTearDown(fixture.changes.dispose);
  tester.view.physicalSize = const Size(1000, 1000);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);

  await tester.pumpWidget(
    MaterialApp(
      locale: const Locale('en'),
      supportedLocales: const [Locale('en'), Locale('de')],
      localizationsDelegates: GlobalMaterialLocalizations.delegates,
      home: SsTheme(
        colors: SsColors.light,
        child: Scaffold(
          body: Builder(
            builder: (context) {
              return SsButton(
                onPressed: () {
                  unawaited(fixture.openPrice(context));
                },
                child: const Text('Record price'),
              );
            },
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text('Record price'));
  await tester.pumpAndSettle();
}

final class _Fixture {
  final changes = ValueNotifier<int>(0);
  final permissions = {
    'view:products',
    'view:productPriceRecords',
    'manage:productPriceRecords',
    'view:productVendors',
    'manage:productVendors',
  };
  final vendorStore = _VendorStore();
  final priceStore = _PriceStore();
  final lookups = <String>[];
  final saved = <models.ProductsPriceRecordsListResultItem>[];
  int vendorWrites = 0;
  int vendorReads = 0;
  int priceWrites = 0;
  bool loseVendorAcknowledgement = false;
  models.ProductsVendorsCreateInput? vendorInput;
  models.ProductsPriceRecordsCreateInput? priceInput;
  Completer<void>? vendorReadGate;

  Future<void> openPrice(BuildContext context) async {
    final coordinator = ProductPriceWriteCoordinator(
      access: ProductPriceRpcAccess(
        scope: 'actor|product',
        productId: 'product',
        read: read,
        write: write,
        isCurrent: () {
          return true;
        },
        can: permissions.contains,
      ),
      receipts: priceStore,
    );
    final result = await showProductPriceDialog(
      context,
      product: models.Product(
        id: 'product',
        customId: 1,
        name: 'Product',
        baseUnit: 'kg',
        otherUnits: const models.ApplyPriceImportRowOtherUnits({}),
        categories: const [],
      ),
      coordinator: coordinator,
      queryIdentity: 'actor|product',
      isCurrent: () {
        return true;
      },
      canCreate: () {
        return permissions.contains('manage:productPriceRecords');
      },
      loadVendors: (query) async {
        lookups.add(query);

        return [];
      },
      createVendor: (query) {
        return openVendor(context, query);
      },
      canCreateVendor: () {
        return permissions.contains('manage:productVendors') &&
            permissions.contains('view:productVendors');
      },
      changes: changes,
    );

    if (result != null) {
      saved.add(result);
    }
  }

  Future<models.ProductVendor?> openVendor(BuildContext context, String query) {
    return showVendorDialog(
      context,
      initialQuery: query,
      coordinator: VendorWriteCoordinator(
        access: VendorRpcAccess(
          scope: 'actor|new-vendor',
          read: read,
          write: write,
          isCurrent: () {
            return true;
          },
          can: permissions.contains,
        ),
        receipts: vendorStore,
      ),
      queryIdentity: 'actor|new-vendor',
      isCurrent: () {
        return permissions.contains('view:productVendors');
      },
      canSave: () {
        return permissions.contains('manage:productVendors');
      },
      changes: changes,
    );
  }

  Future<O> write<I, O>(RpcMutation<I, O> mutation, I input) async {
    if (mutation == ApiMutations.productsVendorsCreate) {
      vendorWrites++;
      vendorInput = input as models.ProductsVendorsCreateInput;

      if (loseVendorAcknowledgement) {
        throw StateError('ACKNOWLEDGEMENT_LOST');
      }

      return const models.ProductsVendorsCreateOutput(id: 'created-vendor')
          as O;
    }

    expect(mutation, same(ApiMutations.productsPriceRecordsCreate));

    priceWrites++;
    priceInput = input as models.ProductsPriceRecordsCreateInput;

    return const models.ProductsPriceRecordsCreateOutput(id: 'price') as O;
  }

  Future<O> read<I, O>(RpcQuery<I, O> query, I input) async {
    if (query == ApiQueries.productsVendorsGet) {
      vendorReads++;
      expect((input as models.ProductsVendorsGetInput).id, 'created-vendor');

      await vendorReadGate?.future;

      final value = vendorInput!;

      return models.ProductVendor(
        id: 'created-vendor',
        name: value.name,
        description: value.description.valueOrNull,
        createdAt: DateTime.utc(2024),
        modifiedAt: DateTime.utc(2024),
      ) as O;
    }

    expect(query, same(ApiQueries.productsPriceRecordsList));
    final value = priceInput!;

    return [
      models.ProductsPriceRecordsListResultItem(
        id: 'price',
        productId: value.productId,
        timestamp: value.timestamp,
        price: value.pricePerBaseUnit,
        isRealPurchase: value.isRealPurchase,
        comment: value.comment.valueOrNull,
      ),
    ] as O;
  }
}

final class _VendorStore implements VendorReceiptStore {
  String? encoded;

  @override
  Future<VendorWriteReceipt?> read(String scope) async {
    return encoded == null ? null : VendorWriteReceipt.decode(encoded!);
  }

  @override
  Future<void> write(VendorWriteReceipt receipt) async {
    encoded = receipt.encode();
  }

  @override
  Future<void> clear(String scope) async {
    encoded = null;
  }
}

final class _PriceStore implements ProductPriceReceiptStore {
  String? encoded;

  @override
  Future<ProductPriceWriteReceipt?> read(String scope) async {
    return encoded == null ? null : ProductPriceWriteReceipt.decode(encoded!);
  }

  @override
  Future<void> write(ProductPriceWriteReceipt receipt) async {
    encoded = receipt.encode();
  }

  @override
  Future<void> clear(String scope) async {
    encoded = null;
  }
}
