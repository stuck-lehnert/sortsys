import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/features/contacts/contact_detail_layout.dart';
import 'package:sortsys_client/features/contacts/contact_edit_action.dart';
import 'package:sortsys_client/features/contacts/session_contact_dialog.dart';
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

  testWidgets('contact command requires actual view and manage roles', (
    tester,
  ) async {
    for (final german in [false, true]) {
      late PaletteCommand command;

      await tester.pumpWidget(
        _app(
          german: german,
          child: Builder(
            builder: (context) {
              command = workspaceCommands(context).singleWhere((candidate) {
                return candidate.id == 'contacts.create';
              });

              return const SizedBox();
            },
          ),
        ),
      );

      for (final roles in [
        <String>{},
        {'view:contacts'},
        {'manage:contacts'},
        {'view:contacts', 'manage:contacts'},
      ]) {
        expect(command.isAllowed(roles.contains), roles.length == 2);
      }

      expect(command.label, german ? 'Kontakt erstellen' : 'Create contact');
      expect(command.group, PaletteGroup.create);
      expect(command.icon, 'contact');
      expect(tester.takeException(), isNull);
    }
  });

  testWidgets('contact entries reject unauthenticated authoritative session', (
    tester,
  ) async {
    final session = SessionController();
    final saved = <models.Contact>[];
    late BuildContext entryContext;
    addTearDown(session.dispose);

    await tester.pumpWidget(
      ChangeNotifierProvider.value(
        value: session,
        child: _app(
          child: Builder(
            builder: (context) {
              entryContext = context;

              return ContactEditAction(contact: _contact(), onSaved: saved.add);
            },
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    final command = workspaceCommands(entryContext).singleWhere((candidate) {
      return candidate.id == 'contacts.create';
    });
    final result = await showSessionContactDialog(entryContext, session);

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
  });

  testWidgets('contact detail keeps edit usable in narrow doubled German RTL', (
    tester,
  ) async {
    var edits = 0;

    await tester.pumpWidget(
      _app(
        german: true,
        width: 320,
        scale: 2,
        direction: TextDirection.rtl,
        child: ContactDetailLayout(
          contact: _contact(),
          editAction: SsButton(
            onPressed: () {
              edits++;
            },
            child: const Text('Bearbeiten'),
          ),
          child: const SizedBox(height: 40),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text('Bearbeiten'));
    await tester.tap(find.text('Bearbeiten'));
    await tester.pump();

    expect(edits, 1);
    expect(tester.getSize(find.byType(ContactDetailLayout)).width, 320);
    expect(tester.takeException(), isNull);
  });
}

models.Contact _contact() {
  return models.Contact(
    id: 'contact/1',
    firstName: 'Ada',
    lastName: 'Example',
    phoneNumbers: const [],
    emailAddresses: const [],
    createdAt: DateTime(2024),
    modifiedAt: DateTime(2024),
  );
}

Widget _app({
  required Widget child,
  bool german = false,
  double width = 800,
  double scale = 1,
  TextDirection direction = TextDirection.ltr,
}) {
  return MaterialApp(
    locale: Locale(german ? 'de' : 'en'),
    supportedLocales: const [Locale('en'), Locale('de')],
    localizationsDelegates: GlobalMaterialLocalizations.delegates,
    home: SsTheme(
      colors: SsColors.light,
      child: Scaffold(
        body: Align(
          alignment: Alignment.topLeft,
          child: SizedBox(
            width: width,
            height: 560,
            child: MediaQuery(
              data: MediaQueryData(
                size: Size(width, 560),
                textScaler: TextScaler.linear(scale),
              ),
              child: Directionality(textDirection: direction, child: child),
            ),
          ),
        ),
      ),
    ),
  );
}
