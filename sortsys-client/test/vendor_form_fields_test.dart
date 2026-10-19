import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/features/vendors/vendor_form_fields.dart';
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
    'vendor create fields preserve edit text and submit canonical values',
    (tester) async {
      final values = VendorFormValues(initialQuery: '  Initial query  ');
      final form = GlobalKey<FormState>();
      _disposeAfterUnmount(tester, values);
      await _pump(tester, values, form);

      expect(values.name.text, '  Initial query  ');
      expect(values.draft().createInput().toWire(), {
        'name': 'Initial query',
        'description': null,
      });
      await tester.enterText(_input('Name *'), '  Vendor Alpha  ');
      await tester.enterText(_input('Description'), '  Supplier note  ');

      expect(form.currentState!.validate(), isTrue);
      expect(values.name.text, '  Vendor Alpha  ');
      expect(values.description.text, '  Supplier note  ');
      expect(values.draft().createInput().toWire(), {
        'name': 'Vendor Alpha',
        'description': 'Supplier note',
      });
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'vendor edit fields retain known ID and nullable original description',
    (tester) async {
      final values = VendorFormValues(
        vendor: models.ProductVendor(
          id: 'vendor/one',
          name: '  Vendor Alpha  ',
          createdAt: DateTime.utc(2024),
          modifiedAt: DateTime.utc(2024, 2),
        ),
      );
      final form = GlobalKey<FormState>();
      _disposeAfterUnmount(tester, values);
      await _pump(tester, values, form);

      expect(values.name.text, '  Vendor Alpha  ');
      expect(form.currentState!.validate(), isTrue);
      expect(values.draft().updateInput().toWire(), {
        'id': 'vendor/one',
        'data': {'name': 'Vendor Alpha', 'description': null},
      });
      await tester.enterText(_input('Description'), '  Updated note  ');

      expect(values.vendorId, 'vendor/one');
      expect(
        values.draft().updateInput().data.description.valueOrNull,
        'Updated note',
      );
      await tester.pumpWidget(const SizedBox.shrink());
      values.name.addListener(_listener);
      values.name.removeListener(_listener);
      values.description.text = 'Still caller-owned';

      expect(values.description.text, 'Still caller-owned');
    },
  );

  testWidgets(
    'vendor fields validate required and exact UTF-8 limits without truncation',
    (tester) async {
      final values = VendorFormValues();
      final form = GlobalKey<FormState>();
      _disposeAfterUnmount(tester, values);
      await _pump(tester, values, form);

      expect(form.currentState!.validate(), isFalse);
      await tester.pump();

      expect(find.text('Required field'), findsOneWidget);
      final longName = List.filled(64, 'é').join();
      final longDescription = List.filled(128, 'é').join();
      await tester.enterText(_input('Name *'), longName);
      await tester.enterText(_input('Description'), longDescription);

      expect(form.currentState!.validate(), isFalse);
      await tester.pump();

      expect(find.text('Maximum 127 UTF-8 bytes.'), findsOneWidget);
      expect(find.text('Maximum 255 UTF-8 bytes.'), findsOneWidget);
      expect(values.name.text, longName);
      expect(values.description.text, longDescription);
      final name = '${List.filled(63, 'é').join()}a';
      final description = '${List.filled(127, 'é').join()}a';
      await tester.enterText(_input('Name *'), '  $name  ');
      await tester.enterText(_input('Description'), '  $description  ');

      expect(form.currentState!.validate(), isTrue);
      expect(values.draft().createInput().name, name);
      expect(values.draft().createInput().description.valueOrNull, description);
    },
  );

  testWidgets(
    'disabled German vendor fields scroll at320px with doubled Ubuntu',
    (tester) async {
      final values = VendorFormValues(initialQuery: 'Händler');
      final form = GlobalKey<FormState>();
      _disposeAfterUnmount(tester, values);
      await _pump(
        tester,
        values,
        form,
        enabled: false,
        width: 320,
        scale: 2,
        language: 'de',
      );
      await tester.ensureVisible(_input('Beschreibung'));

      expect(tester.widget<TextField>(_input('Name *')).enabled, isFalse);
      expect(tester.widget<TextField>(_input('Beschreibung')).enabled, isFalse);
      expect(values.name.text, 'Händler');
      expect(tester.takeException(), isNull);
    },
  );
}

Finder _input(String label) {
  return find.descendant(
    of: find.byWidgetPredicate((widget) {
      return widget is SsTextField && widget.label == label;
    }),
    matching: find.byType(TextField),
  );
}

void _listener() {}

void _disposeAfterUnmount(WidgetTester tester, VendorFormValues values) {
  addTearDown(() async {
    await tester.pumpWidget(const SizedBox.shrink());
    values.dispose();
  });
}

Future<void> _pump(
  WidgetTester tester,
  VendorFormValues values,
  GlobalKey<FormState> form, {
  bool enabled = true,
  double width = 800,
  double scale = 1,
  String language = 'en',
}) async {
  tester.view.physicalSize = Size(width, 800);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);

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
            body: SingleChildScrollView(
              child: Form(
                key: form,
                child: VendorFormFields(values: values, enabled: enabled),
              ),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}
