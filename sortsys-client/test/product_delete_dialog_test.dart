import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/features/products/product_categories_receipt.dart';
import 'package:sortsys_client/features/products/product_delete_coordinator.dart';
import 'package:sortsys_client/features/products/product_delete_dialog.dart';
import 'package:sortsys_client/features/products/product_delete_receipt.dart';
import 'package:sortsys_client/features/products/product_price_draft.dart';
import 'package:sortsys_client/features/products/product_price_receipt.dart';
import 'package:sortsys_client/features/products/session_product_delete_dialog.dart';
import 'package:sortsys_client/state/session_controller.dart';
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

  testWidgets('product deletion requires its real confirmation checkbox', (
    tester,
  ) async {
    final fixture = _Fixture();
    addTearDown(fixture.dispose);

    await _open(tester, fixture);
    await tester.tap(find.text('Delete'));
    await tester.pumpAndSettle();

    expect(find.text('Required field'), findsOneWidget);
    expect(fixture.access.deletes, 0);
    expect(fixture.store.encoded, isNull);
    expect(_button(tester, 'Delete').kind, SsButtonKind.danger);

    await tester.tap(find.byType(SsCheckbox));
    await tester.tap(find.text('Delete'));
    await tester.pumpAndSettle();

    expect(fixture.results, ['product']);
    expect(fixture.access.deletes, 1);
    expect(fixture.access.reads, 1);
    expect(fixture.store.writes, 3);
    expect(fixture.store.encoded, isNull);
    expect(find.byType(ProductDeleteDialog), findsNothing);
  });

  testWidgets(
    'product deletion blocks duplicate submit close and back while busy',
    (tester) async {
      final fixture = _Fixture();
      fixture.access.deleteGate = Completer<void>();
      addTearDown(fixture.dispose);

      await _open(tester, fixture);
      await tester.tap(find.byType(SsCheckbox));
      await tester.tap(find.text('Delete'));
      await tester.pump();

      expect(fixture.access.deletes, 1);
      expect(_button(tester, 'Cancel').onPressed, isNull);
      expect(_button(tester, 'Delete').onPressed, isNull);

      await tester.tap(find.text('Delete'));
      await tester.binding.handlePopRoute();
      await tester.pump();

      expect(find.byType(ProductDeleteDialog), findsOneWidget);
      expect(fixture.results, isEmpty);
      expect(fixture.access.deletes, 1);

      fixture.access.deleteGate!.complete();
      await tester.pumpAndSettle();

      expect(fixture.results, ['product']);
      expect(fixture.access.reads, 1);
      expect(fixture.store.encoded, isNull);
    },
  );

  testWidgets(
    'lost product delete acknowledgement stays blocked after reopening',
    (tester) async {
      final fixture = _Fixture();
      fixture.access.loseAcknowledgement = true;
      addTearDown(fixture.dispose);

      await _open(tester, fixture);
      await tester.tap(find.byType(SsCheckbox));
      await tester.tap(find.text('Delete'));
      await tester.pumpAndSettle();

      expect(fixture.access.deleted, isTrue);
      expect(fixture.receipt!.dispatching, isTrue);
      expect(fixture.receipt!.acknowledged, isFalse);
      expect(_button(tester, 'Delete').onPressed, isNull);
      expect(find.text('Finish acknowledged deletion'), findsNothing);
      expect(find.text('Discard unsent operation'), findsNothing);
      expect(
        find.textContaining('The server acknowledgement is missing.'),
        findsOneWidget,
      );

      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();
      await _open(tester, fixture);

      expect(_button(tester, 'Delete').onPressed, isNull);
      expect(fixture.access.deletes, 1);
      expect(fixture.access.reads, 1);
      expect(fixture.results, [null]);
    },
  );

  testWidgets(
    'product delete conflict blocks mutation until a fresh detail load',
    (tester) async {
      final fixture = _Fixture();
      fixture.access.product = _product(name: 'Concurrent change');
      addTearDown(fixture.dispose);

      await _open(tester, fixture);
      await tester.tap(find.byType(SsCheckbox));
      await tester.tap(find.text('Delete'));
      await tester.pumpAndSettle();

      expect(fixture.access.deletes, 0);
      expect(fixture.store.encoded, isNull);
      expect(_button(tester, 'Delete').onPressed, isNull);
      expect(find.textContaining('The product has changed.'), findsOneWidget);
    },
  );

  testWidgets('unreadable product journal gates deletion until status reload', (
    tester,
  ) async {
    final fixture = _Fixture();
    fixture.store.failRead = true;
    addTearDown(fixture.dispose);

    await _open(tester, fixture);

    expect(find.byType(SsCheckbox), findsNothing);
    expect(_button(tester, 'Delete').onPressed, isNull);
    expect(fixture.access.deletes, 0);

    fixture.store.failRead = false;
    await tester.tap(find.text('Reload'));
    await tester.pumpAndSettle();

    expect(find.byType(SsCheckbox), findsOneWidget);
    expect(_button(tester, 'Delete').onPressed, isNotNull);
    expect(fixture.access.deletes, 0);
  });

  testWidgets(
    'proven unsent product deletion can be discarded after role loss',
    (tester) async {
      final fixture = _Fixture();
      fixture.store.encoded = fixture.prepared().encode();
      addTearDown(fixture.dispose);

      await _open(tester, fixture);

      fixture.access.canDelete = false;
      fixture.refresh();
      await tester.pump();

      await tester.tap(find.text('Discard unsent operation'));
      await tester.pumpAndSettle();

      expect(fixture.store.encoded, isNull);
      expect(fixture.access.deletes, 0);
      expect(fixture.access.reads, 0);
      expect(fixture.results, isEmpty);
      expect(_button(tester, 'Delete').onPressed, isNull);
      expect(
        tester.widget<SsCheckbox>(find.byType(SsCheckbox)).onChanged,
        isNull,
      );
    },
  );

  testWidgets(
    'acknowledged product deletion recovers locally after role loss',
    (tester) async {
      final fixture = _Fixture();
      fixture.store.encoded = fixture
          .prepared()
          .started()
          .confirmed(const models.ProductsDeleteOutput(success: true))
          .encode();
      addTearDown(fixture.dispose);

      await _open(tester, fixture);

      fixture.access.canDelete = false;
      fixture.refresh();
      await tester.pump();

      await tester.tap(find.text('Finish acknowledged deletion'));
      await tester.pumpAndSettle();

      expect(fixture.results, ['product']);
      expect(fixture.store.encoded, isNull);
      expect(fixture.access.deletes, 0);
      expect(fixture.access.reads, 0);
    },
  );

  testWidgets(
    'genuine product deletion survives cleanup failure before or after',
    (tester) async {
      for (final afterClear in [false, true]) {
        final fixture = _Fixture();
        fixture.store.failClear = true;
        fixture.store.failAfterClear = afterClear;
        addTearDown(fixture.dispose);

        await _open(tester, fixture);
        await tester.tap(find.byType(SsCheckbox));
        await tester.tap(find.text('Delete'));
        await tester.pumpAndSettle();

        expect(fixture.results, ['product']);
        expect(fixture.access.deletes, 1);
        expect(fixture.access.reads, 1);
        expect(fixture.store.writes, 3);
        expect(fixture.receipt?.acknowledged, afterClear ? isNull : isTrue);
      }
    },
  );

  testWidgets('stale product dialog cannot accept a held deletion response', (
    tester,
  ) async {
    final fixture = _Fixture();
    fixture.access.deleteGate = Completer<void>();
    addTearDown(fixture.dispose);

    await _open(tester, fixture);
    await tester.tap(find.byType(SsCheckbox));
    await tester.tap(find.text('Delete'));
    await tester.pump();

    fixture.access.current = false;
    fixture.refresh();
    await tester.pump();

    expect(find.text('No permission'), findsOneWidget);
    expect(find.text('Product'), findsNothing);

    fixture.access.deleteGate!.complete();
    await tester.pumpAndSettle();

    expect(fixture.results, isEmpty);
    expect(fixture.access.deletes, 1);
    expect(fixture.receipt!.dispatching, isTrue);
    expect(fixture.receipt!.acknowledged, isFalse);
    expect(_button(tester, 'Delete').onPressed, isNull);
  });

  testWidgets('product confirmation scrolls at320px doubled German RTL', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(320, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final fixture = _Fixture();
    addTearDown(fixture.dispose);

    await _open(tester, fixture, german: true);
    await tester.ensureVisible(find.byType(SsCheckbox));
    await tester.pumpAndSettle();
    await tester.tap(find.byType(SsCheckbox));
    await tester.pump();

    expect(tester.widget<SsCheckbox>(find.byType(SsCheckbox)).value, isTrue);
    expect(
      MediaQuery.sizeOf(tester.element(find.byType(ProductDeleteDialog))).width,
      320,
    );
    expect(tester.takeException(), isNull);

    await tester.tap(find.text('Abbrechen'));
    await tester.pumpAndSettle();

    expect(fixture.results, [null]);
    expect(fixture.access.deletes, 0);
  });

  testWidgets(
    'product deletion freezes nested baseline before parent changes',
    (tester) async {
      final units = <String, num>{'box': 2};
      final categories = ['original'];
      final fixture = _Fixture(
        baseline: _product(units: units, categories: categories),
      );
      addTearDown(fixture.dispose);

      await _open(tester, fixture);

      units.clear();
      categories.clear();

      await tester.tap(find.byType(SsCheckbox));
      await tester.tap(find.text('Delete'));
      await tester.pumpAndSettle();

      expect(fixture.results, ['product']);
      expect(fixture.access.deletes, 1);
      expect(fixture.store.snapshots.first.baseline.otherUnits.values, {
        'box': 2,
      });
      expect(fixture.store.snapshots.first.baseline.categories, ['original']);
      expect(fixture.baseline.otherUnits.values, isEmpty);
      expect(fixture.baseline.categories, isEmpty);
    },
  );

  testWidgets('held product controls reject replacement owners and disposal', (
    tester,
  ) async {
    final fixture = _Fixture();
    addTearDown(fixture.dispose);

    await tester.pumpWidget(_direct(fixture, identity: 'first'));
    await tester.pumpAndSettle();

    final checkbox = tester.widget<SsCheckbox>(find.byType(SsCheckbox));
    final change = checkbox.onChanged!;
    final submit = _button(tester, 'Delete').onPressed!;

    await tester.pumpWidget(_direct(fixture, identity: 'replacement'));
    await tester.pumpAndSettle();

    expect(find.text('No permission'), findsOneWidget);
    expect(_button(tester, 'Delete').onPressed, isNull);

    change(true);
    submit();
    await tester.pump();

    expect(fixture.results, isEmpty);
    expect(fixture.access.deletes, 0);
    expect(fixture.store.writes, 0);

    await tester.pumpWidget(const SizedBox());

    change(true);
    submit();
    await tester.pump();

    expect(fixture.access.deletes, 0);
    expect(fixture.store.writes, 0);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'real final session rejects product delete modal before storage',
    (tester) async {
      final session = SessionController();
      addTearDown(session.dispose);
      var completed = false;
      String? result = 'unresolved';

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Builder(
              builder: (context) {
                return TextButton(
                  onPressed: () async {
                    result = await showSessionProductDeleteDialog(
                      context,
                      session,
                      product: _product(),
                    );
                    completed = true;
                  },
                  child: const Text('Open'),
                );
              },
            ),
          ),
        ),
      );

      await tester.tap(find.text('Open'));
      await tester.pumpAndSettle();

      expect(completed, isTrue);
      expect(result, isNull);
      expect(find.byType(ProductDeleteDialog), findsNothing);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'product deletion warns about cost estimates with canonical title',
    (tester) async {
      final fixture = _Fixture(
        baseline: _product(name: 'Paint', brand: 'Maker'),
      );
      addTearDown(fixture.dispose);

      await _open(tester, fixture);

      final warningFinder = find.byWidgetPredicate((widget) {
        return widget is Text &&
            widget.textSpan?.toPlainText().contains(
                  'This includes cost estimates.',
                ) ==
                true;
      });
      final content = find.byWidgetPredicate((widget) {
        return widget is ConstrainedBox && widget.constraints.maxWidth == 640;
      });

      expect(warningFinder, findsOneWidget);
      expect(find.text('Maker Paint'), findsOneWidget);

      final warning = tester.widget<Text>(warningFinder);
      final emphasis =
          (warning.textSpan! as TextSpan).children!.last as TextSpan;

      expect(emphasis.text, 'This action cannot be undone.');
      expect(emphasis.style!.fontWeight, FontWeight.w700);
      expect(content, findsOneWidget);
      expect(tester.getSize(content).width, lessThanOrEqualTo(640));
      expect(fixture.access.reads, 0);
      expect(fixture.access.deletes, 0);

      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();
    },
  );

  testWidgets(
    'product deletion gates pending price and category journals until reload',
    (tester) async {
      for (final kind in ['price', 'category']) {
        final fixture = _Fixture();
        addTearDown(fixture.dispose);

        if (kind == 'price') {
          fixture.prices.encoded = ProductPriceWriteReceipt(
            scope: fixture.access.scope,
            nonce: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            createdAt: DateTime.utc(2024),
            input: ProductPriceDraft(
              product: _product(),
              totalPrice: '10',
              amount: '2',
              date: DateTime.utc(2024, 2),
            ).createInput(),
          ).encode();
        } else {
          fixture.categories.encoded = ProductCategoriesWriteReceipt(
            scope: fixture.access.scope,
            nonce: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            createdAt: DateTime.utc(2024),
            input: const models.ProductsCategoriesSetInput(
              id: 'product',
              categories: ['next'],
            ),
            baselineCategories: const [],
          ).encode();
        }

        await _open(tester, fixture);

        expect(find.byType(SsCheckbox), findsNothing);
        expect(_button(tester, 'Delete').onPressed, isNull);
        expect(
          find.textContaining('category or price changes'),
          findsOneWidget,
        );
        expect(fixture.access.reads, 0);
        expect(fixture.access.deletes, 0);
        expect(fixture.store.writes, 0);

        fixture.prices.encoded = null;
        fixture.categories.encoded = null;

        await tester.tap(find.text('Reload'));
        await tester.pumpAndSettle();

        expect(find.byType(SsCheckbox), findsOneWidget);
        expect(_button(tester, 'Delete').onPressed, isNotNull);
        expect(fixture.access.deletes, 0);

        await tester.tap(find.text('Cancel'));
        await tester.pumpAndSettle();
      }
    },
  );
}

SsButton _button(WidgetTester tester, String label) {
  return tester.widget<SsButton>(
    find.ancestor(of: find.text(label), matching: find.byType(SsButton)),
  );
}

Future<void> _open(
  WidgetTester tester,
  _Fixture fixture, {
  bool german = false,
}) async {
  await tester.pumpWidget(
    MaterialApp(
      locale: Locale(german ? 'de' : 'en'),
      supportedLocales: const [Locale('en'), Locale('de')],
      localizationsDelegates: GlobalMaterialLocalizations.delegates,
      theme: ThemeData(fontFamily: 'packages/sortsys_ui/Ubuntu'),
      builder: (context, child) {
        final media = MediaQuery.of(context);

        return MediaQuery(
          data: media.copyWith(textScaler: TextScaler.linear(german ? 2 : 1)),
          child: Directionality(
            textDirection: german ? TextDirection.rtl : TextDirection.ltr,
            child: SsTheme(colors: SsColors.dark, child: child!),
          ),
        );
      },
      home: Scaffold(
        body: Builder(
          builder: (context) {
            return SsButton(
              onPressed: () {
                unawaited(
                  showProductDeleteDialog(
                    context,
                    product: fixture.baseline,
                    coordinator: fixture.coordinator,
                    queryIdentity: 'actor',
                    isCurrent: () {
                      return fixture.access.current;
                    },
                    canDelete: () {
                      return fixture.access.canDelete;
                    },
                    changes: fixture,
                  ).then((id) {
                    fixture.results.add(id);
                  }),
                );
              },
              child: const Text('Open product'),
            );
          },
        ),
      ),
    ),
  );

  await tester.tap(find.text('Open product'));
  await tester.pumpAndSettle();
}

final class _Fixture extends ChangeNotifier {
  _Fixture({models.Product? baseline}) : baseline = baseline ?? _product() {
    access.product = freezeProductDeleteBaseline(this.baseline);
  }

  final models.Product baseline;
  final store = _Store();
  final prices = _RelatedPriceReceipts();
  final categories = _RelatedCategoryReceipts();
  final access = _Access();
  final results = <String?>[];
  late final coordinator = ProductDeleteCoordinator(
    access: access,
    receipts: store,
    priceReceipts: prices,
    categoryReceipts: categories,
  );

  ProductDeleteReceipt? get receipt {
    final encoded = store.encoded;

    return encoded == null ? null : ProductDeleteReceipt.decode(encoded);
  }

  ProductDeleteReceipt prepared() {
    return ProductDeleteReceipt(
      scope: access.scope,
      nonce: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      createdAt: DateTime.utc(2024),
      input: const models.ProductsDeleteInput(id: 'product'),
      baseline: baseline,
    );
  }

  void refresh() {
    notifyListeners();
  }
}

final class _Store implements ProductDeleteReceiptStore {
  String? encoded;
  bool failRead = false;
  bool failClear = false;
  bool failAfterClear = false;
  int writes = 0;
  final snapshots = <ProductDeleteReceipt>[];

  @override
  Future<ProductDeleteReceipt?> read(String scope) async {
    if (failRead) {
      throw StateError('JOURNAL_READ_FAILED');
    }

    return encoded == null ? null : ProductDeleteReceipt.decode(encoded!);
  }

  @override
  Future<void> write(ProductDeleteReceipt receipt) async {
    writes++;
    encoded = receipt.encode();
    snapshots.add(ProductDeleteReceipt.decode(encoded!));
  }

  @override
  Future<void> clear(String scope) async {
    if (failClear && !failAfterClear) {
      throw StateError('CLEAR_FAILED');
    }

    encoded = null;

    if (failClear) {
      throw StateError('CLEAR_FAILED_AFTER_REMOVAL');
    }
  }
}

final class _Access implements ProductDeleteAccess {
  @override
  final scope = 'product-dialog:scope';

  @override
  final productId = 'product';
  var product = _product();
  bool current = true;
  bool canDelete = true;
  bool deleted = false;
  bool loseAcknowledgement = false;
  int deletes = 0;
  int reads = 0;
  Completer<void>? deleteGate;

  @override
  void checkCurrent() {
    if (!current) {
      throw StateError('OWNER_CHANGED');
    }
  }

  @override
  void checkDelete(models.ProductsDeleteInput input) {
    checkCurrent();

    if (!canDelete || input.id != 'product') {
      throw StateError('DELETE_NOT_ALLOWED');
    }
  }

  @override
  Future<models.Product> getProduct(String id) async {
    checkCurrent();

    reads++;

    if (deleted) {
      throw StateError('MISSING_PRODUCT');
    }

    return product;
  }

  @override
  Future<models.ProductsDeleteOutput> deleteProduct(
    models.ProductsDeleteInput input,
  ) async {
    checkDelete(input);

    deletes++;
    deleted = true;

    await deleteGate?.future;

    checkCurrent();

    if (loseAcknowledgement) {
      throw StateError('ACKNOWLEDGEMENT_LOST');
    }

    return const models.ProductsDeleteOutput(success: true);
  }
}

models.Product _product({
  String name = 'Product',
  String? brand,
  Map<String, num> units = const {},
  List<String> categories = const [],
}) {
  return models.Product(
    id: 'product',
    customId: 10,
    name: name,
    brand: brand,
    baseUnit: 'kg',
    otherUnits: models.ApplyPriceImportRowOtherUnits(units),
    categories: categories,
  );
}

Widget _direct(_Fixture fixture, {required Object identity}) {
  return MaterialApp(
    theme: ThemeData(fontFamily: 'packages/sortsys_ui/Ubuntu'),
    home: SsTheme(
      colors: SsColors.dark,
      child: Scaffold(
        body: ProductDeleteDialog(
          product: fixture.baseline,
          coordinator: fixture.coordinator,
          queryIdentity: identity,
          isCurrent: () {
            return fixture.access.current;
          },
          onDeleted: (id) {
            fixture.results.add(id);
          },
          onCancel: () {
            fixture.results.add(null);
          },
        ),
      ),
    ),
  );
}

final class _RelatedPriceReceipts implements ProductPriceReceiptStore {
  String? encoded;

  @override
  Future<ProductPriceWriteReceipt?> read(String scope) async {
    final value = encoded;

    return value == null ? null : ProductPriceWriteReceipt.decode(value);
  }

  @override
  Future<void> write(ProductPriceWriteReceipt receipt) async {
    throw StateError('RELATED_PRICE_WRITE_FORBIDDEN');
  }

  @override
  Future<void> clear(String scope) async {
    throw StateError('RELATED_PRICE_CLEAR_FORBIDDEN');
  }
}

final class _RelatedCategoryReceipts implements ProductCategoriesReceiptStore {
  String? encoded;

  @override
  Future<ProductCategoriesWriteReceipt?> read(String scope) async {
    final value = encoded;

    return value == null ? null : ProductCategoriesWriteReceipt.decode(value);
  }

  @override
  Future<void> write(ProductCategoriesWriteReceipt receipt) async {
    throw StateError('RELATED_CATEGORY_WRITE_FORBIDDEN');
  }

  @override
  Future<void> clear(String scope) async {
    throw StateError('RELATED_CATEGORY_CLEAR_FORBIDDEN');
  }
}
