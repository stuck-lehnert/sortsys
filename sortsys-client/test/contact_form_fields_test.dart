import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/features/contacts/contact_draft.dart';
import 'package:sortsys_client/features/contacts/contact_form_fields.dart';
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

  testWidgets('contact fields require either name with exact UTF8 boundary', (
    tester,
  ) async {
    final values = ContactFormValues(ContactDraft());
    final form = await _pump(tester, values);

    expect(form.currentState!.validate(), isFalse);
    await tester.pump();

    expect(find.text('First name or last name is required'), findsNWidgets(2));

    await _enter(tester, values.lastName, '  Last  ');

    expect(form.currentState!.validate(), isTrue);
    expect(values.lastName.text, '  Last  ');
    expect(values.draft().createInput().lastName.value, 'Last');

    await _enter(tester, values.firstName, List.filled(64, 'ä').join());

    expect(form.currentState!.validate(), isFalse);
    await tester.pump();

    expect(find.text('Maximum 127 UTF-8 bytes.'), findsOneWidget);

    await _enter(tester, values.firstName, '${List.filled(63, 'ä').join()}x');

    expect(form.currentState!.validate(), isTrue);
    expect(tester.takeException(), isNull);
  });

  testWidgets('contact address toggle preserves raw hidden editing fields', (
    tester,
  ) async {
    final values = ContactFormValues(ContactDraft(firstName: 'Person'));
    final form = await _pump(tester, values);
    final toggle = find.widgetWithText(SsCheckbox, 'Add address');

    await tester.tap(toggle);
    await tester.pumpAndSettle();

    expect(form.currentState!.validate(), isFalse);

    await _enter(tester, values.street, '  Street 1  ');
    await _enter(tester, values.city, '  City  ');
    await _enter(tester, values.zip, ' ');
    await _enter(tester, values.country, ' AT ');

    expect(form.currentState!.validate(), isTrue);

    await tester.ensureVisible(toggle);
    await tester.tap(toggle);
    await tester.pumpAndSettle();

    expect(values.draft().createInput().address.value, isNull);
    expect(values.street.text, '  Street 1  ');
    expect(_field(values.street), findsNothing);

    await tester.tap(toggle);
    await tester.pumpAndSettle();

    final address = values.draft().createInput().address.value;

    expect(address?.streetAddress, 'Street 1');
    expect(address?.city, 'City');
    expect(address?.zip.value, isNull);
    expect(address?.country.value, 'AT');
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'contact channels focus new row and remove without early disposal',
    (tester) async {
      final values = ContactFormValues(ContactDraft(firstName: 'Person'));
      final form = await _pump(tester, values);

      await tester.ensureVisible(_button('Email'));
      await tester.tap(_button('Email'));
      await tester.pumpAndSettle();

      final email = values.channels.single;

      expect(email.nameFocus.hasFocus, isTrue);
      expect(form.currentState!.validate(), isFalse);

      await _enter(tester, email.name, ' Work ');
      await _enter(tester, email.value, ' a@example.test ');
      await tester.ensureVisible(_button('Phone'));
      await tester.tap(_button('Phone'));
      await tester.pumpAndSettle();

      final phone = values.channels.last;

      expect(phone.nameFocus.hasFocus, isTrue);

      await _enter(tester, phone.value, ' +43 123 ');

      expect(form.currentState!.validate(), isTrue);
      expect(
        values.draft().createInput().emailAddresses.value.single.email,
        'a@example.test',
      );
      expect(
        values.draft().createInput().phoneNumbers.value.single.number,
        '+43 123',
      );

      final remove = find.byType(SsIconButton).first;
      await tester.ensureVisible(remove);
      await tester.tap(remove);
      await tester.pumpAndSettle();

      void listener() {}
      email.name.addListener(listener);
      email.name.removeListener(listener);

      expect(values.channels, [phone]);
      expect(values.draft().createInput().emailAddresses.value, isEmpty);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('contact disabled fields reject add remove and address changes', (
    tester,
  ) async {
    final values = ContactFormValues(
      ContactDraft(
        firstName: 'Person',
        address: const models.ProjectAddress(
          streetAddress: 'Street',
          city: 'City',
        ),
        phoneNumbers: const [ContactChannelDraft(value: '+43 123')],
      ),
    );
    await _pump(tester, values, enabled: false);

    expect(
      tester
          .widgetList<SsTextField>(find.byType(SsTextField))
          .every((field) => !field.enabled),
      isTrue,
    );
    expect(
      tester.widget<SsCheckbox>(find.byType(SsCheckbox)).onChanged,
      isNull,
    );
    expect(
      tester.widget<SsIconButton>(find.byType(SsIconButton)).onPressed,
      isNull,
    );
    expect(
      tester
          .widgetList<SsButton>(find.byType(SsButton))
          .every((button) => button.onPressed == null),
      isTrue,
    );

    await tester.ensureVisible(_button('Email'));
    await tester.tapAt(tester.getCenter(_button('Email')));
    await tester.pump();

    expect(values.channels.length, 1);
    expect(values.useAddress, isTrue);
    expect(tester.takeException(), isNull);
  });

  testWidgets('contact German RTL fields scroll at320 doubled Ubuntu', (
    tester,
  ) async {
    final values = ContactFormValues(ContactDraft(lastName: 'Person'));
    final form = await _pump(
      tester,
      values,
      language: 'de',
      width: 320,
      scale: 2,
    );

    await tester.ensureVisible(_button('E-Mail'));
    await tester.tap(_button('E-Mail'));
    await tester.pumpAndSettle();

    final email = values.channels.single;

    expect(email.nameFocus.hasFocus, isTrue);
    expect(
      Directionality.of(tester.element(find.byType(ContactFormFields))),
      TextDirection.rtl,
    );

    await _enter(tester, email.name, '  Geschäftlich  ');
    await _enter(tester, email.value, ' person@example.test ');

    expect(form.currentState!.validate(), isTrue);
    expect(
      values.draft().createInput().emailAddresses.value.single.name.value,
      'Geschäftlich',
    );
    expect(tester.takeException(), isNull);
  });
}

Finder _field(TextEditingController controller) {
  return find.byWidgetPredicate((widget) {
    return widget is TextField && widget.controller == controller;
  });
}

Finder _button(String label) {
  return find.widgetWithText(SsButton, label);
}

Future<void> _enter(
  WidgetTester tester,
  TextEditingController controller,
  String value,
) async {
  final field = _field(controller);
  await tester.ensureVisible(field);
  await tester.enterText(field, value);
  await tester.pump();
}

Future<GlobalKey<FormState>> _pump(
  WidgetTester tester,
  ContactFormValues values, {
  bool enabled = true,
  String language = 'en',
  double width = 800,
  double scale = 1,
}) async {
  final form = GlobalKey<FormState>();
  tester.view.physicalSize = Size(width, 900);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  addTearDown(() async {
    await tester.pumpWidget(const SizedBox());
    values.dispose();
  });

  await tester.pumpWidget(
    MaterialApp(
      locale: Locale(language),
      supportedLocales: const [Locale('en'), Locale('de')],
      localizationsDelegates: GlobalMaterialLocalizations.delegates,
      home: SsTheme(
        colors: SsColors.light,
        child: MediaQuery(
          data: MediaQueryData(
            size: Size(width, 900),
            textScaler: TextScaler.linear(scale),
          ),
          child: Directionality(
            textDirection: language == 'de'
                ? TextDirection.rtl
                : TextDirection.ltr,
            child: Scaffold(
              body: Form(
                key: form,
                child: SingleChildScrollView(
                  padding: const EdgeInsets.all(16),
                  child: ContactFormFields(values: values, enabled: enabled),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();

  return form;
}
