import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/features/customers/customer_detail_screen.dart';
import 'package:sortsys_client/features/customers/customer_edit_action.dart';
import 'package:sortsys_client/features/customers/session_customer_dialog.dart';
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

  testWidgets('customer command requires view and manage in both languages', (
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
                return candidate.id == 'customers.create';
              });

              return const SizedBox();
            },
          ),
        ),
      );

      for (final roles in [
        <String>{},
        {'view:customers'},
        {'manage:customers'},
        {'view:customers', 'manage:customers'},
      ]) {
        expect(command.isAllowed(roles.contains), roles.length == 2);
      }

      expect(command.label, german ? 'Kunde erstellen' : 'Create customer');
      expect(command.group, PaletteGroup.create);
      expect(command.icon, 'customer');
    }
  });

  testWidgets(
    'customer entries reject unauthenticated final session and dispose keys',
    (tester) async {
      final session = SessionController();
      final saved = <String>[];
      late BuildContext entryContext;
      addTearDown(session.dispose);

      await tester.pumpWidget(
        ChangeNotifierProvider.value(
          value: session,
          child: _app(
            child: Builder(
              builder: (context) {
                entryContext = context;

                return CustomerEditAction(
                  customer: _customer(),
                  onSaved: saved.add,
                );
              },
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      final command = workspaceCommands(entryContext).singleWhere((candidate) {
        return candidate.id == 'customers.create';
      });
      final result = await showSessionCustomerDialog(entryContext, session);

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

  testWidgets('customer detail edit stays usable at320px doubled German RTL', (
    tester,
  ) async {
    var edits = 0;

    await tester.pumpWidget(
      _app(
        german: true,
        narrow: true,
        child: CustomerDetailLayout(
          customer: _customer(),
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
    expect(tester.getSize(find.byType(CustomerDetailLayout)).width, 320);
    expect(tester.takeException(), isNull);
  });
}

models.Customer _customer() {
  return models.Customer(
    id: 'customer/1',
    name: 'Customer',
    phoneNumbers: const [],
    emailAddresses: const [],
    createdAt: DateTime(2024),
    modifiedAt: DateTime(2024),
  );
}

Widget _app({required Widget child, bool german = false, bool narrow = false}) {
  final width = narrow ? 320.0 : 800.0;

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
                textScaler: TextScaler.linear(narrow ? 2 : 1),
              ),
              child: Directionality(
                textDirection: narrow ? TextDirection.rtl : TextDirection.ltr,
                child: child,
              ),
            ),
          ),
        ),
      ),
    ),
  );
}
