import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/features/products/product_categories_dialog.dart';
import 'package:sortsys_client/features/products/product_categories_inputs.dart';
import 'package:sortsys_client/features/products/product_categories_picker.dart';
import 'package:sortsys_client/features/products/product_categories_receipt.dart';
import 'package:sortsys_client/features/products/product_categories_write_access.dart';
import 'package:sortsys_client/features/products/product_categories_write_coordinator.dart';
import 'package:sortsys_client/features/products/session_product_categories_dialog.dart';
import 'package:sortsys_client/state/session_controller.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

void main() {
  testWidgets(
    'category dialog saves raw selections once after verified readback',
    (tester) async {
      final harness = _Harness();
      harness.options = ['Old', ' New '];
      addTearDown(harness.dispose);

      await tester.pumpWidget(harness.app());
      await tester.pumpAndSettle();
      await _select(tester, ' New ');
      await tester.tap(_button('Save'));
      await tester.pumpAndSettle();

      expect(harness.access.setCalls, 1);
      expect(harness.access.inputs.single.categories, ['Old', ' New ']);
      expect(harness.saved.single.categories, ['Old', 'New']);
      expect(harness.receipts.stages, [
        'prepared',
        'dispatching',
        'acknowledged',
      ]);
      expect(harness.receipts.encoded, isNull);
      expect(tester.widget<SsButton>(_button('Save')).onPressed, isNull);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'category dialog distinguishes clearing from a known-target no-op',
    (tester) async {
      final unchanged = _Harness();
      final clearing = _Harness();
      addTearDown(unchanged.dispose);
      addTearDown(clearing.dispose);

      await tester.pumpWidget(unchanged.app());
      await tester.pumpAndSettle();
      await tester.tap(_button('Save'));
      await tester.pumpAndSettle();

      expect(unchanged.saved.single.categories, ['Old']);
      expect(unchanged.access.setCalls, 0);
      expect(unchanged.receipts.stages, isEmpty);

      await tester.pumpWidget(clearing.app());
      await tester.pumpAndSettle();
      await tester.tap(find.byType(TextField));
      await tester.pumpAndSettle();
      await tester.tap(
        find.byKey(const ValueKey(('product-category-option', 0, 'Old'))),
      );
      await tester.pumpAndSettle();
      await tester.tap(_button('Save'));
      await tester.pumpAndSettle();

      expect(clearing.access.inputs.single.categories, isEmpty);
      expect(clearing.saved.single.categories, isEmpty);
      expect(clearing.access.setCalls, 1);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'busy category modal blocks duplicate submit cancel and route back',
    (tester) async {
      final harness = _Harness();
      final gate = Completer<void>();
      harness.access.beforeRead = (count) async {
        if (count == 2) {
          await gate.future;
        }
      };
      addTearDown(harness.dispose);

      await tester.pumpWidget(harness.app(routeMode: true));
      await tester.tap(find.text('Open'));
      await tester.pumpAndSettle();
      await _select(tester, 'New');

      final submit = tester.widget<SsButton>(_button('Save')).onPressed!;

      submit();
      submit();
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 20));

      expect(harness.access.setCalls, 1);
      expect(harness.saved, isEmpty);
      expect(tester.widget<SsButton>(_button('Cancel')).onPressed, isNull);
      expect(tester.widget<SsButton>(_button('Save')).onPressed, isNull);
      expect(find.byType(ProductCategoriesDialog), findsOneWidget);

      await tester.binding.handlePopRoute();
      await tester.pump();

      expect(find.byType(ProductCategoriesDialog), findsOneWidget);
      expect(harness.saved, isEmpty);

      gate.complete();
      await tester.pumpAndSettle();

      expect(find.byType(ProductCategoriesDialog), findsNothing);
      expect(harness.saved.single.categories, ['Old', 'New']);
      expect(harness.access.setCalls, 1);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'journal and category option failures stay blocked until explicit retry',
    (tester) async {
      final harness = _Harness();
      harness.receipts.failRead = true;
      harness.failOptions = true;
      addTearDown(harness.dispose);

      await tester.pumpWidget(harness.app());
      await tester.pumpAndSettle();

      expect(tester.widget<SsButton>(_button('Save')).onPressed, isNull);
      expect(harness.access.setCalls, 0);

      harness.receipts.failRead = false;

      await tester.tap(_button('Reload'));
      await tester.pumpAndSettle();

      expect(tester.widget<SsButton>(_button('Save')).onPressed, isNull);
      expect(harness.access.setCalls, 0);

      harness.failOptions = false;

      await tester.tap(_button('Reload categories'));
      await tester.pumpAndSettle();

      expect(harness.optionReads, 2);
      expect(tester.widget<SsButton>(_button('Save')).onPressed, isNotNull);
      expect(harness.access.setCalls, 0);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'lost category acknowledgement recovers view-only without replay',
    (tester) async {
      final harness = _Harness();
      harness.access.loseAcknowledgement = true;
      addTearDown(harness.dispose);

      await tester.pumpWidget(harness.app());
      await tester.pumpAndSettle();
      await _select(tester, 'New');
      await tester.tap(_button('Save'));
      await tester.pumpAndSettle();

      expect(harness.saved, isEmpty);
      expect(harness.access.setCalls, 1);
      expect(harness.receipts.receipt!.dispatching, isTrue);
      expect(
        tester.widget<TextField>(find.byType(TextField)).controller!.text,
        'New',
      );

      harness.change(() {
        harness.access.manage = false;
      });
      await tester.pumpAndSettle();

      expect(tester.widget<SsButton>(_button('Save')).onPressed, isNull);
      expect(
        tester
            .widget<SsButton>(_button('Verify with read-only request'))
            .onPressed,
        isNotNull,
      );

      await tester.tap(_button('Verify with read-only request'));
      await tester.pumpAndSettle();

      expect(harness.saved.single.categories, ['Old', 'New']);
      expect(harness.receipts.encoded, isNull);
      expect(harness.access.setCalls, 1);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'unsent category discard preserves draft query across manage loss',
    (tester) async {
      final harness = _Harness();
      harness.receipts.failPreparedAfterWrite = true;
      addTearDown(harness.dispose);

      await tester.pumpWidget(harness.app());
      await tester.pumpAndSettle();
      await _select(tester, 'New');
      await tester.tap(_button('Save'));
      await tester.pumpAndSettle();

      expect(harness.access.setCalls, 0);
      expect(harness.receipts.receipt!.dispatching, isFalse);
      expect(harness.receipts.receipt!.acknowledged, isFalse);

      harness.change(() {
        harness.access.manage = false;
      });
      await tester.pumpAndSettle();
      await tester.tap(_button('Discard unsent operation'));
      await tester.pumpAndSettle();

      expect(harness.receipts.encoded, isNull);
      expect(harness.saved, isEmpty);
      expect(harness.access.setCalls, 0);
      expect(
        tester.widget<TextField>(find.byType(TextField)).controller!.text,
        'New',
      );
      expect(
        tester
            .widget<ProductCategoriesPicker>(
              find.byType(ProductCategoriesPicker),
            )
            .selected,
        ['Old', 'New'],
      );
      expect(tester.widget<SsButton>(_button('Save')).onPressed, isNull);

      harness.change(() {
        harness.access.manage = true;
        harness.receipts.failPreparedAfterWrite = false;
      });
      await tester.pumpAndSettle();
      await tester.tap(_button('Save'));
      await tester.pumpAndSettle();

      expect(harness.saved.single.categories, ['Old', 'New']);
      expect(harness.access.setCalls, 1);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'category cleanup failures retain success before and after removal',
    (tester) async {
      for (final after in [false, true]) {
        final harness = _Harness();
        harness.receipts.clearFailureAfter = after;
        addTearDown(harness.dispose);

        await tester.pumpWidget(harness.app());
        await tester.pumpAndSettle();
        await _select(tester, 'New');
        await tester.tap(_button('Save'));
        await tester.pumpAndSettle();

        expect(harness.saved.single.categories, ['Old', 'New']);
        expect(harness.access.setCalls, 1);
        expect(harness.receipts.encoded == null, after);
        expect(tester.widget<SsButton>(_button('Save')).onPressed, isNull);
        expect(tester.takeException(), isNull);
      }
    },
  );

  testWidgets(
    'category dialog freezes its initial baseline and ignores unowned changes',
    (tester) async {
      final harness = _Harness();
      addTearDown(harness.dispose);

      await tester.pumpWidget(harness.app());
      await tester.pumpAndSettle();

      harness.baseline.categories.add('foreign parent mutation');
      harness.access.product = _product(['Old'], name: 'Fresh server name');

      await _select(tester, 'New');
      await tester.tap(_button('Save'));
      await tester.pumpAndSettle();

      expect(harness.access.inputs.single.categories, ['Old', 'New']);
      expect(harness.saved.single.name, 'Fresh server name');
      expect(harness.saved.single.categories, ['Old', 'New']);
      expect(harness.access.setCalls, 1);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('category conflict keeps the draft and blocks further dispatch', (
    tester,
  ) async {
    final harness = _Harness();
    addTearDown(harness.dispose);

    await tester.pumpWidget(harness.app());
    await tester.pumpAndSettle();
    await _select(tester, 'New');

    harness.access.product = _product(['Other']);

    await tester.tap(_button('Save'));
    await tester.pumpAndSettle();

    expect(harness.access.setCalls, 0);
    expect(harness.saved, isEmpty);
    expect(find.textContaining('The categories have changed.'), findsOneWidget);
    expect(tester.widget<SsButton>(_button('Save')).onPressed, isNull);
    expect(
      tester.widget<TextField>(find.byType(TextField)).controller!.text,
      'New',
    );
    expect(
      tester
          .widget<ProductCategoriesPicker>(find.byType(ProductCategoriesPicker))
          .selected,
      ['Old', 'New'],
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'late category options and held controls cannot change replacement owner',
    (tester) async {
      final harness = _Harness();
      final gate = Completer<List<String>>();
      harness.optionGate = gate;
      addTearDown(harness.dispose);

      await tester.pumpWidget(harness.app());
      await tester.pump();

      final cancel = tester.widget<SsButton>(_button('Cancel')).onPressed!;
      final change = tester
          .widget<ProductCategoriesPicker>(
            find.byType(ProductCategoriesPicker, skipOffstage: false),
          )
          .onChanged;

      harness.change(() {
        harness.identity = 'replacement';
        harness.optionGate = null;
        harness.options = ['Other'];
        harness.baseline = _product(['Other']);
        harness.access.scope = 'replacement-scope';
        harness.access.product = _product(['Other']);
      });
      await tester.pumpAndSettle();

      gate.complete(['foreign']);
      await tester.pumpAndSettle();

      cancel();
      change(['foreign']);

      final picker = tester.widget<ProductCategoriesPicker>(
        find.byType(ProductCategoriesPicker),
      );

      expect(picker.options, ['Other']);
      expect(picker.selected, ['Other']);
      expect(harness.cancelled, 0);
      expect(harness.saved, isEmpty);
      expect(harness.access.setCalls, 0);

      await tester.pumpWidget(const SizedBox.shrink());

      cancel();
      change(['foreign']);

      expect(harness.cancelled, 0);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('invalid legacy categories cannot dispatch and can be removed', (
    tester,
  ) async {
    final harness = _Harness();
    final oversized = List.filled(64, 'ä').join();
    harness.baseline = _product([oversized]);
    harness.access.product = _product([oversized]);
    harness.options = [];
    addTearDown(harness.dispose);

    await tester.pumpWidget(harness.app());
    await tester.pumpAndSettle();
    await tester.tap(_button('Save'));
    await tester.pumpAndSettle();

    expect(harness.access.setCalls, 0);
    expect(harness.access.readIds, isEmpty);
    expect(find.textContaining('127 UTF-8 bytes'), findsOneWidget);

    await tester.tap(find.byType(TextField));
    await tester.pumpAndSettle();
    await tester.tap(
      find.byKey(ValueKey(('product-category-option', 0, oversized))),
    );
    await tester.pumpAndSettle();
    await tester.tap(_button('Save'));
    await tester.pumpAndSettle();

    expect(harness.access.inputs.single.categories, isEmpty);
    expect(harness.saved.single.categories, isEmpty);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'real final session rejects category dialog before secure storage',
    (tester) async {
      final session = SessionController();
      late BuildContext context;
      addTearDown(session.dispose);

      await tester.pumpWidget(
        MaterialApp(
          home: Builder(
            builder: (value) {
              context = value;

              return const SizedBox.shrink();
            },
          ),
        ),
      );

      final result = await showSessionProductCategoriesDialog(
        context,
        session,
        product: _product(['Old']),
      );

      expect(result, isNull);
      expect(session.authenticated, isFalse);
      expect(find.byType(ProductCategoriesDialog), findsNothing);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'category dialog fits doubled German RTL at 320px in both themes',
    (tester) async {
      tester.view.physicalSize = const Size(320, 900);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      const productName = 'Ein langes Produkt mit langem Titel';

      for (final colors in [SsColors.light, SsColors.dark]) {
        final harness = _Harness();
        harness.baseline = _product(['Old'], name: productName);
        addTearDown(harness.dispose);

        await tester.pumpWidget(
          harness.app(colors: colors, german: true, scale: 2),
        );
        await tester.pumpAndSettle();

        expect(find.text('Kategorien bearbeiten'), findsOneWidget);
        expect(find.text('Kategorien'), findsOneWidget);
        expect(_button('Speichern'), findsOneWidget);
        expect(_button('Abbrechen'), findsOneWidget);
        expect(find.byType(ProductCategoriesPicker), findsOneWidget);
        expect(tester.takeException(), isNull);
      }
    },
  );
}

Finder _button(String label) {
  return find.widgetWithText(SsButton, label);
}

Future<void> _select(WidgetTester tester, String category) async {
  await tester.enterText(find.byType(TextField), category);
  await tester.pumpAndSettle();
  await tester.tap(
    find.byKey(ValueKey(('product-category-option', 0, category))),
  );
  await tester.pumpAndSettle();
}

final class _Harness extends ChangeNotifier {
  final access = _Access();
  final receipts = _Receipts();
  late final coordinator = ProductCategoriesWriteCoordinator(
    access: access,
    receipts: receipts,
  );
  models.Product baseline = _product(['Old']);
  Object identity = 'initial';
  List<String> options = ['Old', 'New'];
  Completer<List<String>>? optionGate;
  bool failOptions = false;
  int optionReads = 0;
  int cancelled = 0;
  final saved = <models.Product>[];

  bool current() {
    return access.current && access.view;
  }

  void change(VoidCallback update) {
    update();
    notifyListeners();
  }

  Future<List<String>> loadOptions() async {
    optionReads++;
    final gate = optionGate;

    if (gate != null) {
      return gate.future;
    }

    if (failOptions) {
      throw StateError('OPTIONS_UNAVAILABLE');
    }

    return List.of(options);
  }

  Widget app({
    bool routeMode = false,
    SsColors colors = SsColors.light,
    bool german = false,
    double scale = 1,
  }) {
    return MaterialApp(
      key: ObjectKey(this),
      locale: Locale(german ? 'de' : 'en'),
      supportedLocales: const [Locale('en'), Locale('de')],
      localizationsDelegates: GlobalMaterialLocalizations.delegates,
      builder: (context, child) {
        final media = MediaQuery.of(context);

        return SsTheme(
          colors: colors,
          child: MediaQuery(
            data: media.copyWith(textScaler: TextScaler.linear(scale)),
            child: Directionality(
              textDirection: german ? TextDirection.rtl : TextDirection.ltr,
              child: child!,
            ),
          ),
        );
      },
      home: Builder(
        builder: (context) {
          if (routeMode) {
            return Scaffold(
              body: TextButton(
                onPressed: () {
                  unawaited(
                    showProductCategoriesDialog(
                      context,
                      product: baseline,
                      coordinator: coordinator,
                      queryIdentity: identity,
                      isCurrent: current,
                      canSave: () {
                        return current() && access.manage;
                      },
                      loadCategories: loadOptions,
                      changes: this,
                    ).then((record) {
                      if (record != null) {
                        saved.add(record);
                      }
                    }),
                  );
                },
                child: const Text('Open'),
              ),
            );
          }

          return Scaffold(
            body: ListenableBuilder(
              listenable: this,
              builder: (context, child) {
                return ProductCategoriesDialog(
                  product: baseline,
                  coordinator: coordinator,
                  queryIdentity: identity,
                  isCurrent: current,
                  enabled: access.manage,
                  loadCategories: loadOptions,
                  onSaved: (record) {
                    saved.add(record);
                  },
                  onCancel: () {
                    cancelled++;
                  },
                );
              },
            ),
          );
        },
      ),
    );
  }
}

final class _Access implements ProductCategoriesWriteAccess {
  @override
  String scope = 'scope';

  @override
  String productId = 'product-1';

  bool current = true;
  bool view = true;
  bool manage = true;
  bool loseAcknowledgement = false;
  int setCalls = 0;
  models.Product product = _product(['Old']);
  final inputs = <models.ProductsCategoriesSetInput>[];
  final readIds = <String>[];
  Future<void> Function(int count)? beforeRead;

  @override
  void checkCurrent() {
    if (!current || !view) {
      throw StateError('OWNER_CHANGED');
    }
  }

  @override
  void checkSet(models.ProductsCategoriesSetInput input) {
    checkCurrent();

    if (!manage) {
      throw StateError('MANAGE_REVOKED');
    }

    if (input.id != productId) {
      throw const FormatException('TARGET_CHANGED');
    }

    checkProductCategoriesInput(input);
  }

  @override
  Future<models.Product?> getProduct(String id) async {
    checkCurrent();

    readIds.add(id);
    final callback = beforeRead;

    if (callback != null) {
      await callback(readIds.length);
    }

    checkCurrent();

    return product;
  }

  @override
  Future<models.ProductsCategoriesSetOutput> setCategories(
    models.ProductsCategoriesSetInput input,
  ) async {
    setCalls++;

    checkSet(input);

    inputs.add(input);
    product = _product(
      productCategoriesStoredValues(input),
      name: product.name,
    );

    if (loseAcknowledgement) {
      throw StateError('ACK_LOST');
    }

    return const models.ProductsCategoriesSetOutput(success: true);
  }
}

final class _Receipts implements ProductCategoriesReceiptStore {
  String? encoded;
  bool failRead = false;
  bool failPreparedAfterWrite = false;
  bool? clearFailureAfter;
  final stages = <String>[];

  ProductCategoriesWriteReceipt? get receipt {
    final value = encoded;

    return value == null ? null : ProductCategoriesWriteReceipt.decode(value);
  }

  @override
  Future<ProductCategoriesWriteReceipt?> read(String scope) async {
    if (failRead) {
      throw StateError('JOURNAL_UNAVAILABLE');
    }

    return receipt;
  }

  @override
  Future<void> write(ProductCategoriesWriteReceipt value) async {
    final stage = value.acknowledged
        ? 'acknowledged'
        : value.dispatching
        ? 'dispatching'
        : 'prepared';

    stages.add(stage);
    encoded = value.encode();

    if (failPreparedAfterWrite && stage == 'prepared') {
      throw StateError('PREPARED_WRITE_FAILED_AFTER');
    }
  }

  @override
  Future<void> clear(String scope) async {
    if (clearFailureAfter == false) {
      throw StateError('CLEAR_FAILED_BEFORE');
    }

    encoded = null;

    if (clearFailureAfter == true) {
      throw StateError('CLEAR_FAILED_AFTER');
    }
  }
}

models.Product _product(List<String> categories, {String name = 'Paint'}) {
  return models.Product(
    id: 'product-1',
    customId: 1,
    name: name,
    baseUnit: 'kg',
    otherUnits: models.ApplyPriceImportRowOtherUnits(const {}),
    categories: categories,
  );
}
