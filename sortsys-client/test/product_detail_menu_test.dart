import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/features/products/product_detail_layout.dart';
import 'package:sortsys_client/features/products/product_detail_location.dart';
import 'package:sortsys_client/features/products/product_detail_menu.dart';
import 'package:sortsys_client/features/products/product_edit_action.dart';
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

  testWidgets('product menu keeps canonical order icons and actual callbacks', (
    tester,
  ) async {
    var prices = 0;
    var edits = 0;

    await tester.pumpWidget(
      _app(
        child: ProductDetailMenu(
          onRecordPrice: () {
            prices++;
          },
          onEdit: () {
            edits++;
          },
        ),
      ),
    );
    await tester.tap(_anchor());
    await tester.pumpAndSettle();

    expect(
      tester.getTopLeft(find.text('Record price')).dy,
      lessThan(tester.getTopLeft(find.text('Edit')).dy),
    );
    expect(find.byKey(const ValueKey('product-record-price')), findsOneWidget);

    for (final name in ['price-record', 'edit']) {
      expect(
        find.byWidgetPredicate((widget) {
          return widget is SsIcon && widget.name == name && widget.size == 16;
        }),
        findsOneWidget,
      );
    }

    await tester.tap(find.text('Record price'));
    await tester.pumpAndSettle();

    expect(prices, 1);
    expect(edits, 0);

    await tester.tap(_anchor());
    await tester.pumpAndSettle();
    await tester.tap(find.text('Edit'));
    await tester.pumpAndSettle();

    expect(edits, 1);
    expect(prices, 1);
    expect(tester.takeException(), isNull);
  });

  testWidgets('product menu omits unavailable actions and empty controls', (
    tester,
  ) async {
    for (final priceOnly in [true, false]) {
      await tester.pumpWidget(
        _app(
          child: ProductDetailMenu(
            onRecordPrice: priceOnly ? _presentationAction : null,
            onEdit: priceOnly ? null : _presentationAction,
          ),
        ),
      );
      await tester.tap(_anchor());
      await tester.pumpAndSettle();

      expect(find.text(priceOnly ? 'Record price' : 'Edit'), findsOneWidget);
      expect(find.text(priceOnly ? 'Edit' : 'Record price'), findsNothing);

      await tester.tap(find.text(priceOnly ? 'Record price' : 'Edit'));
      await tester.pumpAndSettle();
    }

    await tester.pumpWidget(_app(child: const ProductDetailMenu()));
    await tester.pumpAndSettle();

    expect(_anchor(), findsNothing);
  });

  testWidgets(
    'product menu disables anchor and already-open items while busy',
    (tester) async {
      final busy = ValueNotifier(false);
      addTearDown(busy.dispose);

      await tester.pumpWidget(
        _app(
          child: ValueListenableBuilder<bool>(
            valueListenable: busy,
            builder: (context, value, child) {
              return ProductDetailMenu(
                busy: value,
                onRecordPrice: _presentationAction,
                onEditCategories: _presentationAction,
                onEdit: _presentationAction,
              );
            },
          ),
        ),
      );

      await tester.tap(_anchor());
      await tester.pumpAndSettle();

      expect(find.text('Edit categories'), findsOneWidget);
      expect(find.byType(MenuItemButton), findsNWidgets(3));

      busy.value = true;
      await tester.pumpAndSettle();

      expect(tester.widget<SsIconButton>(_anchor()).onPressed, isNull);
      expect(find.byType(MenuItemButton), findsNWidgets(3));

      for (final item in tester.widgetList<MenuItemButton>(
        find.byType(MenuItemButton),
      )) {
        expect(item.onPressed, isNull);
      }

      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'product menu wraps at320px doubled German RTL in the dark theme',
    (tester) async {
      tester.view.physicalSize = const Size(320, 900);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      var prices = 0;

      await tester.pumpWidget(
        _app(
          german: true,
          child: SsPageHeader(
            title: 'Produkt',
            actions: ProductDetailMenu(
              onRecordPrice: () {
                prices++;
              },
              onEdit: _presentationAction,
            ),
          ),
        ),
      );
      await tester.tap(_anchor());
      await tester.pumpAndSettle();

      expect(find.text('Preis verzeichnen'), findsOneWidget);
      expect(find.text('Bearbeiten'), findsOneWidget);
      expect(
        tester
            .widget<MenuItemButton>(
              find.byKey(const ValueKey('product-record-price')),
            )
            .style
            ?.foregroundColor
            ?.resolve({}),
        SsColors.dark.text,
      );
      expect(tester.takeException(), isNull);

      await tester.tap(find.text('Preis verzeichnen'));
      await tester.pumpAndSettle();

      expect(prices, 1);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'real product edit owner survives menu closure without auth injection',
    (tester) async {
      final session = SessionController();
      final enabled = ValueNotifier(true);
      addTearDown(session.dispose);
      addTearDown(enabled.dispose);
      VoidCallback? edit;
      var busy = false;
      var prices = 0;

      await tester.pumpWidget(
        ChangeNotifierProvider.value(
          value: session,
          child: _app(
            child: ValueListenableBuilder<bool>(
              valueListenable: enabled,
              builder: (context, value, child) {
                final product = _product();

                return ProductEditAction(
                  product: product,
                  enabled: value,
                  onSaved: (record) {
                    fail('An unauthenticated edit must not complete.');
                  },
                  builder: (context, onEdit, opening) {
                    edit = onEdit;
                    busy = opening;

                    return ProductDetailLayout(
                      product: product,
                      headerActions: ProductDetailMenu(
                        onEdit: onEdit,
                        busy: opening,
                        onRecordPrice: () {
                          // This callback only exercises the presentation fixture.
                          prices++;
                        },
                      ),
                    );
                  },
                );
              },
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      final owner = tester.state(find.byType(ProductEditAction));

      expect(edit, isNull);
      expect(busy, isFalse);

      await tester.tap(_anchor());
      await tester.pumpAndSettle();
      await tester.tap(find.text('Record price'));
      await tester.pumpAndSettle();

      expect(prices, 1);
      expect(tester.state(find.byType(ProductEditAction)), same(owner));
      expect(edit, isNull);

      enabled.value = false;
      await tester.pumpAndSettle();

      expect(busy, isTrue);
      expect(tester.widget<SsIconButton>(_anchor()).onPressed, isNull);

      await tester.pumpWidget(const SizedBox());
      await tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
      await tester.sendKeyEvent(LogicalKeyboardKey.keyE);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
      await tester.pump();

      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'category action keeps canonical order genuine icon and callback',
    (tester) async {
      var prices = 0;
      var categories = 0;
      var edits = 0;

      await tester.pumpWidget(
        _app(
          child: ProductDetailMenu(
            onRecordPrice: () {
              prices++;
            },
            onEditCategories: () {
              categories++;
            },
            onEdit: () {
              edits++;
            },
          ),
        ),
      );

      await tester.tap(_anchor());
      await tester.pumpAndSettle();

      final category = find.byKey(const ValueKey('product-edit-categories'));

      expect(category, findsOneWidget);
      expect(find.byType(MenuItemButton), findsNWidgets(3));
      expect(
        tester.getTopLeft(find.text('Record price')).dy,
        lessThan(tester.getTopLeft(find.text('Edit categories')).dy),
      );
      expect(
        tester.getTopLeft(find.text('Edit categories')).dy,
        lessThan(tester.getTopLeft(find.text('Edit')).dy),
      );
      expect(
        find.descendant(
          of: category,
          matching: find.byWidgetPredicate((widget) {
            return widget is SsIcon &&
                widget.name == 'edit' &&
                widget.size == 16;
          }),
        ),
        findsOneWidget,
      );

      await tester.tap(category);
      await tester.pumpAndSettle();

      expect(categories, 1);
      expect(prices, 0);
      expect(edits, 0);
      expect(_anchor(), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'category-only menu wraps doubled German RTL and omits unavailable actions',
    (tester) async {
      tester.view.physicalSize = const Size(320, 900);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      var categories = 0;

      await tester.pumpWidget(
        _app(
          german: true,
          child: SsPageHeader(
            title: 'Produkt',
            actions: ProductDetailMenu(
              onEditCategories: () {
                categories++;
              },
            ),
          ),
        ),
      );

      await tester.tap(_anchor());
      await tester.pumpAndSettle();

      expect(find.text('Kategorien bearbeiten'), findsOneWidget);
      expect(find.text('Preis verzeichnen'), findsNothing);
      expect(find.text('Bearbeiten'), findsNothing);
      expect(find.byType(MenuItemButton), findsOneWidget);
      expect(tester.takeException(), isNull);

      await tester.tap(find.text('Kategorien bearbeiten'));
      await tester.pumpAndSettle();

      expect(categories, 1);
      expect(tester.takeException(), isNull);
    },
  );

  test(
    'product category owner checks decoded route IDs without discarding URI state',
    () {
      const id = 'paint / ä?#';
      final uri = Uri.parse(
        '/products/${Uri.encodeComponent(id)}?a=1&a=2#details',
      );

      expect(isProductDetailLocation(uri, id), isTrue);
      expect(uri.queryParametersAll['a'], ['1', '2']);
      expect(uri.fragment, 'details');
      expect(isProductDetailLocation(uri, 'other'), isFalse);
      expect(isProductDetailLocation(uri, ''), isFalse);
      expect(isProductDetailLocation(Uri.parse('/products'), id), isFalse);
      expect(
        isProductDetailLocation(Uri.parse('/products/vendors/$id'), id),
        isFalse,
      );
      expect(
        isProductDetailLocation(
          Uri.parse('/users/${Uri.encodeComponent(id)}'),
          id,
        ),
        isFalse,
      );
      expect(isProductDetailLocation(Uri.parse('/products/%FF'), id), isFalse);
    },
  );
}

Finder _anchor() {
  return find.byWidgetPredicate((widget) {
    return widget is SsIconButton && widget.icon == 'overflow-menu-vertical';
  });
}

void _presentationAction() {
  // No business operation belongs to this presentation-only fixture.
}

models.Product _product() {
  return models.Product(
    id: 'product',
    customId: 10,
    name: 'Product',
    baseUnit: 'kg',
    otherUnits: models.ApplyPriceImportRowOtherUnits({'box': 2}),
    categories: [],
  );
}

Widget _app({required Widget child, bool german = false}) {
  return MaterialApp(
    locale: Locale(german ? 'de' : 'en'),
    supportedLocales: const [Locale('en'), Locale('de')],
    localizationsDelegates: GlobalMaterialLocalizations.delegates,
    theme: ThemeData(fontFamily: 'packages/sortsys_ui/Ubuntu'),
    builder: (context, content) {
      final media = MediaQuery.of(context);

      return MediaQuery(
        data: media.copyWith(textScaler: TextScaler.linear(german ? 2 : 1)),
        child: Directionality(
          textDirection: german ? TextDirection.rtl : TextDirection.ltr,
          child: SsTheme(colors: SsColors.dark, child: content!),
        ),
      );
    },
    home: Scaffold(body: child),
  );
}
