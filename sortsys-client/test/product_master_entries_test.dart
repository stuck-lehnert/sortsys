import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/features/products/product_detail_layout.dart';
import 'package:sortsys_client/features/products/product_edit_action.dart';
import 'package:sortsys_client/features/products/session_product_master_dialog.dart';
import 'package:sortsys_client/features/search/command_palette_controller.dart';
import 'package:sortsys_client/features/search/workspace_commands.dart';
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

  testWidgets(
    'product create command requires both actual view and manage roles',
    (tester) async {
      late PaletteCommand command;

      await tester.pumpWidget(
        MaterialApp(
          home: Builder(
            builder: (context) {
              command = workspaceCommands(context).singleWhere((candidate) {
                return candidate.id == 'products.create';
              });

              return const SizedBox();
            },
          ),
        ),
      );

      for (final roles in [
        <String>{},
        {'view:products'},
        {'manage:products'},
        {'view:products', 'manage:products'},
      ]) {
        expect(command.isAllowed(roles.contains), roles.length == 2);
      }

      expect(command.label, 'Create product');
      expect(command.group, PaletteGroup.create);
      expect(command.icon, 'product');
    },
  );

  testWidgets(
    'product entries and Ctrl E reject unauthenticated final session',
    (tester) async {
      final session = SessionController();
      final saved = <models.Product>[];
      late BuildContext entryContext;
      addTearDown(session.dispose);

      await tester.pumpWidget(
        ChangeNotifierProvider.value(
          value: session,
          child: MaterialApp(
            home: SsTheme(
              colors: SsColors.light,
              child: Scaffold(
                body: Builder(
                  builder: (context) {
                    entryContext = context;

                    return ProductEditAction(
                      product: _product(),
                      onSaved: saved.add,
                    );
                  },
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      final command = workspaceCommands(entryContext).singleWhere((candidate) {
        return candidate.id == 'products.create';
      });
      final result = await showSessionProductMasterDialog(
        entryContext,
        session,
      );
      await runWorkspaceCommand(entryContext, command);
      await tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
      await tester.sendKeyEvent(LogicalKeyboardKey.keyE);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
      await tester.pump();

      expect(result, isNull);
      expect(saved, isEmpty);
      expect(find.text('Edit'), findsNothing);
      expect(find.byType(Dialog), findsNothing);
      expect(tester.takeException(), isNull);

      await tester.pumpWidget(const SizedBox());
      await tester.sendKeyEvent(LogicalKeyboardKey.keyE);

      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'product detail keeps both actions at320 doubled Ubuntu German RTL',
    (tester) async {
      tester.view.physicalSize = const Size(320, 900);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      var prices = 0;
      var edits = 0;

      await tester.pumpWidget(
        MaterialApp(
          locale: const Locale('de'),
          supportedLocales: const [Locale('de')],
          localizationsDelegates: GlobalMaterialLocalizations.delegates,
          home: SsTheme(
            colors: SsColors.light,
            child: MediaQuery(
              data: const MediaQueryData(
                size: Size(320, 900),
                textScaler: TextScaler.linear(2),
              ),
              child: Directionality(
                textDirection: TextDirection.rtl,
                child: Scaffold(
                  body: ProductDetailLayout(
                    product: _product(),
                    headerActions: SsButton(
                      onPressed: () {
                        prices++;
                      },
                      child: const Text('Preis verzeichnen'),
                    ),
                    editAction: SsButton(
                      onPressed: () {
                        edits++;
                      },
                      child: const Text('Bearbeiten'),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('Preis verzeichnen'));
      await tester.tap(find.text('Preis verzeichnen'));
      await tester.ensureVisible(find.text('Bearbeiten'));
      await tester.tap(find.text('Bearbeiten'));
      await tester.pump();

      expect(prices, 1);
      expect(edits, 1);
      expect(tester.takeException(), isNull);
    },
  );
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
