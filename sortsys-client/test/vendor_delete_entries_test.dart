import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/features/vendors/session_vendor_delete_dialog.dart';
import 'package:sortsys_client/features/vendors/vendor_delete_dialog.dart';
import 'package:sortsys_client/features/vendors/vendor_detail_screen.dart';
import 'package:sortsys_client/features/vendors/vendor_edit_action.dart';
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

  test('vendor delete entry needs view and delete rather than manage role', () {
    for (final roles in [
      <String>{},
      {'view:productVendors'},
      {'delete:productVendors'},
      {'manage:productVendors'},
      {'view:productVendors', 'manage:productVendors'},
      {'view:productVendors', 'delete:productVendors'},
      {'view:productVendors', 'manage:productVendors', 'delete:productVendors'},
    ]) {
      expect(
        canDeleteVendor(roles.contains),
        roles.contains('view:productVendors') &&
            roles.contains('delete:productVendors'),
      );
    }
  });

  test(
    'vendor delete navigation needs matching current route and genuine ID',
    () {
      const id = 'vendor/ä?x#y';
      final current = Uri.parse(
        '/products/vendors/${Uri.encodeComponent(id)}?q=one&q=two#details',
      );

      expect(
        vendorDeletedLocation(current, displayedId: id, acknowledgedId: id),
        '/products/vendors',
      );

      for (final uri in [
        Uri.parse('/products/vendors'),
        Uri.parse('/products/vendors/other'),
        Uri.parse('/products/vendors/${Uri.encodeComponent(id)}/history'),
        Uri.parse('/contacts/${Uri.encodeComponent(id)}'),
      ]) {
        expect(
          vendorDeletedLocation(uri, displayedId: id, acknowledgedId: id),
          isNull,
        );
      }

      expect(
        vendorDeletedLocation(
          current,
          displayedId: id,
          acknowledgedId: 'other',
        ),
        isNull,
      );
      expect(
        vendorDeletedLocation(current, displayedId: '', acknowledgedId: ''),
        isNull,
      );
    },
  );

  testWidgets(
    'vendor deletion rejects the actual unauthenticated final session',
    (tester) async {
      final session = SessionController();
      late BuildContext entryContext;
      addTearDown(session.dispose);

      await tester.pumpWidget(
        ChangeNotifierProvider.value(
          value: session,
          child: _app(
            child: Builder(
              builder: (context) {
                entryContext = context;

                return VendorEditAction(
                  vendor: _vendor(),
                  onSaved: (record) {
                    fail('An unauthenticated edit must not complete.');
                  },
                  onDeleted: (id) {
                    fail('An unauthenticated deletion must not complete.');
                  },
                );
              },
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(
        await showSessionVendorDeleteDialog(
          entryContext,
          session,
          vendor: _vendor(),
        ),
        isNull,
      );
      expect(find.byType(SsIconButton), findsNothing);
      expect(find.byType(VendorDeleteDialog), findsNothing);

      await tester.pumpWidget(const SizedBox());
      await tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
      await tester.sendKeyEvent(LogicalKeyboardKey.keyE);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
      await tester.pump();

      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('vendor menu filters actions and invokes the actual edit item', (
    tester,
  ) async {
    var edits = 0;

    await tester.pumpWidget(
      _app(
        child: VendorDetailMenu(
          onEdit: () {
            edits++;
          },
        ),
      ),
    );
    await tester.tap(find.byType(SsIconButton));
    await tester.pumpAndSettle();

    expect(find.text('Delete'), findsNothing);
    expect(
      tester
          .widget<SsIcon>(
            find.byWidgetPredicate((widget) {
              return widget is SsIcon && widget.name == 'edit';
            }),
          )
          .size,
      16,
    );

    await tester.tap(find.text('Edit'));
    await tester.pumpAndSettle();

    expect(edits, 1);

    await tester.pumpWidget(_app(child: const VendorDetailMenu()));
    await tester.pumpAndSettle();

    expect(find.byType(SsIconButton), findsNothing);

    await tester.pumpWidget(
      _app(
        child: VendorDetailMenu(
          busy: true,
          onEdit: () {
            edits++;
          },
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(
      tester.widget<SsIconButton>(find.byType(SsIconButton)).onPressed,
      isNull,
    );
    expect(edits, 1);
  });

  testWidgets(
    'vendor delete menu fits320px doubled German RTL with dark icons',
    (tester) async {
      tester.view.physicalSize = const Size(320, 900);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      var deletes = 0;

      await tester.pumpWidget(
        _app(
          german: true,
          dark: true,
          doubled: true,
          child: SsPageHeader(
            title: 'Händler',
            actions: VendorDetailMenu(
              onDelete: () {
                deletes++;
              },
            ),
          ),
        ),
      );
      await tester.tap(find.byType(SsIconButton));
      await tester.pumpAndSettle();

      expect(find.text('Bearbeiten'), findsNothing);
      expect(find.text('Löschen'), findsOneWidget);
      expect(
        tester
            .widget<MenuItemButton>(find.byType(MenuItemButton))
            .style
            ?.foregroundColor
            ?.resolve({}),
        SsColors.dark.text,
      );
      expect(
        find.byWidgetPredicate((widget) {
          return widget is SsIcon && widget.name == 'trash-can';
        }),
        findsOneWidget,
      );

      await tester.tap(find.text('Löschen'));
      await tester.pumpAndSettle();

      expect(deletes, 1);
      expect(tester.takeException(), isNull);
    },
  );
}

models.ProductVendor _vendor() {
  return models.ProductVendor(
    id: 'vendor',
    name: 'Vendor',
    createdAt: DateTime.utc(2024),
    modifiedAt: DateTime.utc(2024, 2),
  );
}

Widget _app({
  required Widget child,
  bool german = false,
  bool dark = false,
  bool doubled = false,
}) {
  return MaterialApp(
    locale: Locale(german ? 'de' : 'en'),
    supportedLocales: const [Locale('en'), Locale('de')],
    localizationsDelegates: GlobalMaterialLocalizations.delegates,
    theme: ThemeData(fontFamily: 'packages/sortsys_ui/Ubuntu'),
    builder: (context, content) {
      final media = MediaQuery.of(context);

      return MediaQuery(
        data: media.copyWith(textScaler: TextScaler.linear(doubled ? 2 : 1)),
        child: Directionality(
          textDirection: doubled ? TextDirection.rtl : TextDirection.ltr,
          child: SsTheme(
            colors: dark ? SsColors.dark : SsColors.light,
            child: content!,
          ),
        ),
      );
    },
    home: Scaffold(body: child),
  );
}
