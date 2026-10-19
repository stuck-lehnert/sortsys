import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/api/procedure.dart';
import 'package:sortsys_client/features/products/product_detail_layout.dart';
import 'package:sortsys_client/features/products/product_price_dialog.dart';
import 'package:sortsys_client/features/products/product_price_receipt.dart';
import 'package:sortsys_client/features/products/product_price_rpc_access.dart';
import 'package:sortsys_client/features/products/product_price_write_coordinator.dart';
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

  testWidgets('price dialog validates and submits real fields exactly once', (
    tester,
  ) async {
    final fixture = _Fixture();
    await _pump(tester, fixture);
    await tester.tap(find.text('Save'));
    await tester.pumpAndSettle();

    expect(fixture.writes, 0);
    await _fill(tester);
    await tester.tap(find.text('Save'));
    await _waitFor(tester, () {
      return fixture.saved.isNotEmpty;
    });

    expect(fixture.writes, 1);
    expect(fixture.reads, 1);
    expect(fixture.submitted!.pricePerBaseUnit, 15);
    expect(fixture.submitted!.comment.valueOrNull, 'invoice');
    expect(fixture.submitted!.vendorId.isAbsent, isTrue);
    expect(fixture.saved.single.id, 'price');
    expect(_button(tester, 'Save').onPressed, isNull);
    expect(fixture.store.encoded, isNull);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'price dialog blocks lost acknowledgements without fake recovery',
    (tester) async {
      final fixture = _Fixture()..loseAcknowledgement = true;
      await _pump(tester, fixture);
      await _fill(tester);
      await tester.tap(find.text('Save'));
      await _waitFor(tester, () {
        return find
            .textContaining('server acknowledgement is missing')
            .evaluate()
            .isNotEmpty;
      });

      expect(fixture.writes, 1);
      expect(fixture.reads, 0);
      expect(_button(tester, 'Save').onPressed, isNull);
      expect(find.text('Verify with read-only request'), findsNothing);
      expect(find.text('Discard unsent operation'), findsNothing);
      expect(fixture.saved, isEmpty);
      expect(fixture.store.encoded, isNotNull);
    },
  );

  testWidgets(
    'price dialog retries acknowledged verification without a second write',
    (tester) async {
      final fixture = _Fixture()..wrongRecord = true;
      await _pump(tester, fixture);
      await _fill(tester);
      await tester.tap(find.text('Save'));
      await _waitFor(tester, () {
        return find
                .text('Verify with read-only request')
                .evaluate()
                .isNotEmpty &&
            _button(tester, 'Verify with read-only request').onPressed != null;
      });

      expect(fixture.writes, 1);
      fixture.wrongRecord = false;
      await tester.tap(find.text('Verify with read-only request'));
      await _waitFor(tester, () {
        return fixture.saved.isNotEmpty;
      });

      expect(fixture.writes, 1);
      expect(fixture.reads, 2);
      expect(fixture.saved.single.id, 'price');
      expect(fixture.store.encoded, isNull);
    },
  );

  testWidgets(
    'price dialog discards only unsent work before explicit new save',
    (tester) async {
      final fixture = _Fixture();
      fixture.store.failWrite = 2;
      await _pump(tester, fixture);
      await _fill(tester);
      await tester.tap(find.text('Save'));
      await _waitFor(tester, () {
        return find.text('Discard unsent operation').evaluate().isNotEmpty &&
            _button(tester, 'Discard unsent operation').onPressed != null;
      });

      expect(fixture.writes, 0);
      await tester.tap(find.text('Discard unsent operation'));
      await _waitFor(tester, () {
        return _button(tester, 'Save').onPressed != null;
      });

      expect(fixture.writes, 0);
      expect(fixture.store.encoded, isNull);
      await tester.tap(find.text('Save'));
      await _waitFor(tester, () {
        return fixture.saved.isNotEmpty;
      });

      expect(fixture.writes, 1);
    },
  );

  testWidgets(
    'German narrow dialog blocks cancel while busy and ignores late disposal',
    (tester) async {
      final fixture = _Fixture()..gate = Completer<void>();
      await _pump(tester, fixture, width: 320, scale: 2, language: 'de');
      await _fill(tester, german: true);
      await tester.tap(find.text('Speichern'));
      await _waitFor(tester, () {
        return fixture.writes == 1;
      });

      expect(_button(tester, 'Abbrechen').onPressed, isNull);
      expect(_button(tester, 'Speichern').onPressed, isNull);
      expect(tester.takeException(), isNull);
      fixture.current = false;
      await tester.pumpWidget(const SizedBox.shrink());
      fixture.gate!.complete();
      await tester.runAsync(() async {
        await Future<void>.delayed(const Duration(milliseconds: 100));
      });
      await tester.pump();

      expect(fixture.saved, isEmpty);
      expect(fixture.store.encoded, isNotNull);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('product header opens actual price route and closes only after verification', (tester) async {
    final fixture = _Fixture();
    await _pump(tester, fixture, entry: true);

    expect(find.byType(ProductPriceDialog), findsNothing);
    await tester.tap(find.text('Record price'));
    await tester.pumpAndSettle();

    expect(find.byType(ProductPriceDialog), findsOneWidget);
    await _fill(tester);
    await tester.tap(find.text('Save'));
    await _waitFor(tester, () {
      return fixture.saved.isNotEmpty;
    });
    await tester.pumpAndSettle();

    expect(fixture.writes, 1);
    expect(fixture.reads, 1);
    expect(fixture.saved.single.id, 'price');
    expect(find.byType(ProductPriceDialog), findsNothing);
    expect(find.text('Record price'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });


  testWidgets('price dialog saves whitespace comment as canonical null', (tester) async {
    final fixture = _Fixture();
    await _pump(tester, fixture);
    await _fill(tester, commentText: '   ');
    await tester.tap(find.text('Save'));
    await _waitFor(tester, () {
      return fixture.saved.isNotEmpty;
    });

    expect(fixture.writes, 1);
    expect(fixture.reads, 1);
    expect(fixture.submitted!.comment.hasValue, isTrue);
    expect(fixture.submitted!.comment.valueOrNull, isNull);
    expect(fixture.saved.single.comment, isNull);
    expect(fixture.store.encoded, isNull);
  });
}

Future<void> _fill(
  WidgetTester tester, {
  bool german = false,
  String commentText = ' invoice ',
}) async {
  final price = _input(german ? 'Gesamtpreis (EUR)' : 'Total price (EUR)');
  final amount = _input(german ? 'Menge' : 'Quantity');
  final comment = _input(german ? 'Kommentar' : 'Comment');

  for (final entry in [(price, '30'), (amount, '2'), (comment, commentText)]) {
    await tester.ensureVisible(entry.$1);
    await tester.enterText(entry.$1, entry.$2);
  }

  await tester.pump();
}

Finder _input(String label) {
  return find.descendant(
    of: find.byWidgetPredicate((widget) {
      return widget is SsTextField && widget.label == label;
    }),
    matching: find.byType(TextField),
  );
}

SsButton _button(WidgetTester tester, String label) {
  return tester.widget<SsButton>(
    find.ancestor(of: find.text(label), matching: find.byType(SsButton)),
  );
}

Future<void> _waitFor(WidgetTester tester, bool Function() ready) async {
  for (var attempt = 0; attempt < 200; attempt++) {
    await tester.runAsync(() async {
      await Future<void>.delayed(const Duration(milliseconds: 10));
    });
    await tester.pump();

    if (ready()) {
      return;
    }
  }

  fail('Price dialog did not reach the expected I/O state.');
}

Future<void> _pump(
  WidgetTester tester,
  _Fixture fixture, {
  double width = 800,
  double scale = 1,
  String language = 'en',
  bool entry = false,
}) async {
  tester.view.physicalSize = Size(width, 800);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);

  final product = models.Product(
    id: 'product',
    customId: 1,
    name: 'Product',
    baseUnit: 'kg',
    otherUnits: const models.ApplyPriceImportRowOtherUnits({}),
    categories: const [],
  );

  bool current() {
    return fixture.current;
  }

  Future<List<models.ProductVendor>> vendors(String query) async {
    return [];
  }

  Future<void> open(BuildContext context) async {
    final record = await showProductPriceDialog(
      context,
      product: product,
      coordinator: fixture.coordinator,
      queryIdentity: 'scope',
      isCurrent: current,
      canCreate: current,
      loadVendors: vendors,
    );

    if (record != null && fixture.current) {
      fixture.saved.add(record);
    }
  }

  await tester.pumpWidget(
    MaterialApp(
      locale: Locale(language),
      supportedLocales: const [Locale('en'), Locale('de')],
      localizationsDelegates: GlobalMaterialLocalizations.delegates,
      home: SsTheme(
        colors: SsColors.light,
        child: MediaQuery(
          data: MediaQueryData(
            size: Size(width, 800),
            textScaler: TextScaler.linear(scale),
          ),
          child: Scaffold(
            body: entry
                ? Builder(
                    builder: (context) {
                      return ProductDetailLayout(
                        product: product,
                        headerActions: SsButton(
                          kind: SsButtonKind.ghost,
                          onPressed: () {
                            unawaited(open(context));
                          },
                          child: const Text('Record price'),
                        ),
                      );
                    },
                  )
                : ProductPriceDialog(
                    product: product,
                    coordinator: fixture.coordinator,
                    queryIdentity: 'scope',
                    isCurrent: current,
                    loadVendors: vendors,
                    onSaved: fixture.saved.add,
                    onCancel: () {},
                  ),
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

final class _Fixture {
  _Fixture() {
    coordinator = ProductPriceWriteCoordinator(
      access: ProductPriceRpcAccess(
        scope: 'actor|product',
        productId: 'product',
        read: read,
        write: write,
        isCurrent: () {
          return current;
        },
        can: (permission) {
          return true;
        },
      ),
      receipts: store,
    );
  }

  final store = _Store();
  final saved = <models.ProductsPriceRecordsListResultItem>[];
  late final ProductPriceWriteCoordinator coordinator;
  bool current = true;
  bool loseAcknowledgement = false;
  bool wrongRecord = false;
  int writes = 0;
  int reads = 0;
  Completer<void>? gate;
  models.ProductsPriceRecordsCreateInput? submitted;

  Future<O> write<I, O>(RpcMutation<I, O> mutation, I input) async {
    writes++;
    submitted = input as models.ProductsPriceRecordsCreateInput;
    final pending = gate;

    if (pending != null) {
      await pending.future;
    }

    if (loseAcknowledgement) {
      throw StateError('acknowledgement lost');
    }

    return const models.ProductsPriceRecordsCreateOutput(id: 'price') as O;
  }

  Future<O> read<I, O>(RpcQuery<I, O> query, I input) async {
    reads++;
    final value = submitted!;

    return [
      models.ProductsPriceRecordsListResultItem(
        id: wrongRecord ? 'foreign' : 'price',
        productId: value.productId,
        timestamp: value.timestamp,
        price: value.pricePerBaseUnit,
        isRealPurchase: value.isRealPurchase,
        comment: value.comment.valueOrNull?.trim(),
      ),
    ] as O;
  }
}

final class _Store implements ProductPriceReceiptStore {
  String? encoded;
  int writes = 0;
  int? failWrite;

  @override
  Future<ProductPriceWriteReceipt?> read(String scope) async {
    final value = encoded;

    return value == null ? null : ProductPriceWriteReceipt.decode(value);
  }

  @override
  Future<void> write(ProductPriceWriteReceipt receipt) async {
    writes++;

    if (writes == failWrite) {
      throw StateError('storage unavailable');
    }

    encoded = receipt.encode();
  }

  @override
  Future<void> clear(String scope) async {
    encoded = null;
  }
}
