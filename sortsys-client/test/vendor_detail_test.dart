import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/features/vendors/vendor_detail_screen.dart';
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

  test('vendor detail uses the exact generated identifier input', () {
    expect(vendorDetailInput('vendor-1').toWire(), {'id': 'vendor-1'});
    expect(vendorDetailInput(' A&/B ').toWire(), {'id': ' A&/B '});
    expect(() => vendorDetailInput(''), throwsFormatException);
  });

  testWidgets('vendor detail matches the canonical header-only content', (
    tester,
  ) async {
    final vendor = _vendor(' Nord & Süd ');
    await _pump(tester, vendor);

    final header = tester.widget<SsPageHeader>(find.byType(SsPageHeader));
    expect(header.title, vendor.name);
    expect(find.text(vendor.name), findsOneWidget);
    expect(find.text(vendor.description!), findsNothing);
    expect(find.text('Erstellt'), findsNothing);
    expect(find.text('Geändert'), findsNothing);
    expect(find.byType(SsAttribute), findsNothing);
    expect(find.byType(SsButton), findsNothing);
    expect(find.byType(SsIconButton), findsNothing);
    expect(
      find.descendant(
        of: find.byType(VendorDetailLayout),
        matching: find.byType(Title),
      ),
      findsNothing,
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('an empty vendor name is not replaced by invented content', (
    tester,
  ) async {
    await _pump(tester, _vendor(''));

    expect(tester.widget<SsPageHeader>(find.byType(SsPageHeader)).title, '');
    expect(find.text('Unbekannt'), findsNothing);
    expect(find.text('Unknown'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('vendor heading scrolls at 320px with doubled actual-font text', (
    tester,
  ) async {
    const name = 'Norddeutscher Baustoffhandel für Werkzeuge, Maschinen '
        'und Industriebedarf';
    await _pump(
      tester,
      _vendor(name),
      width: 320,
      height: 160,
      scale: 2,
    );
    final scroll = tester.state<ScrollableState>(find.byType(Scrollable));

    expect(scroll.position.maxScrollExtent, greaterThan(0));
    expect(tester.takeException(), isNull);
    await tester.drag(find.byType(ListView), const Offset(0, -400));
    await tester.pumpAndSettle();

    expect(scroll.position.pixels, greaterThan(0));
    expect(tester.getRect(find.text(name)).bottom, lessThanOrEqualTo(160));
    expect(tester.takeException(), isNull);
  });
}

Future<void> _pump(
  WidgetTester tester,
  models.ProductVendor vendor, {
  double width = 1200,
  double height = 900,
  double scale = 1,
}) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = Size(width, height);
  addTearDown(tester.view.resetDevicePixelRatio);
  addTearDown(tester.view.resetPhysicalSize);

  await tester.pumpWidget(
    MaterialApp(
      locale: const Locale('de'),
      supportedLocales: const [Locale('de'), Locale('en')],
      localizationsDelegates: GlobalMaterialLocalizations.delegates,
      builder: (context, child) {
        return SsTheme(
          colors: SsColors.light,
          child: MediaQuery(
            data: MediaQuery.of(context).copyWith(
              textScaler: TextScaler.linear(scale),
            ),
            child: child!,
          ),
        );
      },
      home: Scaffold(body: VendorDetailLayout(vendor: vendor)),
    ),
  );
  await tester.pumpAndSettle();
}

models.ProductVendor _vendor(String name) {
  return models.ProductVendor(
    id: 'vendor-1',
    name: name,
    description: 'Canonical detail does not display this description.',
    createdAt: DateTime.utc(2026, 1, 1),
    modifiedAt: DateTime.utc(2026, 1, 2),
  );
}
