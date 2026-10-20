import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/features/customers/customer_detail_location.dart';
import 'package:sortsys_client/features/customers/customer_detail_screen.dart';
import 'package:sortsys_client/features/customers/customer_edit_action.dart';
import 'package:sortsys_client/features/customers/session_customer_delete_dialog.dart';
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

  testWidgets(
    'customer menu keeps canonical order genuine icons and callbacks',
    (tester) async {
      var edits = 0;
      var deletes = 0;

      await tester.pumpWidget(
        _app(
          child: CustomerDetailMenu(
            onEdit: () {
              edits++;
            },
            onDelete: () {
              deletes++;
            },
          ),
        ),
      );

      await tester.tap(find.byType(SsIconButton));
      await tester.pumpAndSettle();

      final items = tester
          .widgetList<MenuItemButton>(find.byType(MenuItemButton))
          .toList();

      expect(
        items.map((item) {
          return (item.child as Text).data;
        }),
        ['Edit', 'Delete'],
      );
      expect(
        items.map((item) {
          return (item.leadingIcon as SsIcon).name;
        }),
        ['edit', 'trash-can'],
      );
      expect(
        items.every((item) {
          return (item.leadingIcon as SsIcon).size == 16;
        }),
        isTrue,
      );

      await tester.tap(find.byKey(const ValueKey('customer-edit')));
      await tester.pumpAndSettle();

      expect(edits, 1);
      expect(deletes, 0);

      await tester.tap(find.byType(SsIconButton));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('customer-delete')));
      await tester.pumpAndSettle();

      expect(edits, 1);
      expect(deletes, 1);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('customer menu omits empty actions and live busy disables both', (
    tester,
  ) async {
    await tester.pumpWidget(_app(child: const CustomerDetailMenu()));

    expect(find.byType(SsIconButton), findsNothing);

    var busy = false;
    var calls = 0;
    late StateSetter update;

    await tester.pumpWidget(
      _app(
        child: StatefulBuilder(
          builder: (context, setState) {
            update = setState;

            return CustomerDetailMenu(
              busy: busy,
              onEdit: () {
                calls++;
              },
              onDelete: () {
                calls++;
              },
            );
          },
        ),
      ),
    );

    await tester.tap(find.byType(SsIconButton));
    await tester.pumpAndSettle();

    expect(find.byType(MenuItemButton), findsNWidgets(2));

    update(() {
      busy = true;
    });
    await tester.pump();

    expect(find.byType(MenuItemButton), findsNWidgets(2));

    for (final item in tester.widgetList<MenuItemButton>(
      find.byType(MenuItemButton),
    )) {
      expect(item.onPressed, isNull);
    }

    expect(
      tester.widget<SsIconButton>(find.byType(SsIconButton)).onPressed,
      isNull,
    );
    expect(calls, 0);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'delete-only customer menu fits320px doubled German RTL both themes',
    (tester) async {
      tester.view.physicalSize = const Size(320, 900);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      for (final dark in [false, true]) {
        var deletes = 0;

        await tester.pumpWidget(
          _app(
            german: true,
            narrow: true,
            dark: dark,
            child: CustomerDetailLayout(
              customer: _customer(),
              editAction: CustomerDetailMenu(
                onDelete: () {
                  deletes++;
                },
              ),
              child: const SizedBox(height: 40),
            ),
          ),
        );
        await tester.pumpAndSettle();
        await tester.ensureVisible(find.byType(SsIconButton));
        await tester.tap(find.byType(SsIconButton));
        await tester.pumpAndSettle();

        expect(find.byType(MenuItemButton), findsOneWidget);
        expect(find.byKey(const ValueKey('customer-edit')), findsNothing);
        expect(find.text('Bearbeiten'), findsNothing);
        expect(find.text('Löschen'), findsOneWidget);
        expect(tester.getSize(find.byType(CustomerDetailLayout)).width, 320);
        expect(tester.takeException(), isNull);

        await tester.tap(find.byKey(const ValueKey('customer-delete')));
        await tester.pumpAndSettle();

        expect(deletes, 1);
        expect(tester.takeException(), isNull);
      }
    },
  );

  test(
    'customer deletion permission requires view and delete independently',
    () {
      for (final roles in [
        <String>{},
        {'view:customers'},
        {'delete:customers'},
        {'manage:customers', 'delete:customers'},
        {'view:customers', 'manage:customers'},
        {'view:customers', 'delete:customers'},
        {'view:customers', 'manage:customers', 'delete:customers'},
      ]) {
        expect(
          canDeleteCustomer(roles.contains),
          roles.contains('view:customers') &&
              roles.contains('delete:customers'),
        );
      }
    },
  );

  test(
    'customer detail location owns decoded IDs and rejects malformed paths',
    () {
      for (final id in ['customer/1', 'a b', 'ä?+%', 'customer%2F1']) {
        final uri = Uri(
          pathSegments: ['customers', id],
          query: 'view=contacts',
          fragment: 'activity',
        );

        expect(isCustomerDetailLocation(uri, id), isTrue);
        expect(isCustomerDetailLocation(uri, 'other'), isFalse);
      }

      for (final path in [
        '/customers',
        '/customers/customer/1',
        '/customers/customer%2F1/',
        '/projects/customer%2F1',
        '/customers/%FF',
      ]) {
        expect(
          isCustomerDetailLocation(Uri.parse(path), 'customer/1'),
          isFalse,
        );
      }

      expect(isCustomerDetailLocation(Uri.parse('/customers/'), ''), isFalse);
    },
  );

  testWidgets(
    'real final customer menu session rejects delete and disposed keys',
    (tester) async {
      final session = SessionController();
      final saved = <String>[];
      final deleted = <String>[];
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
                  onSaved: (id) {
                    saved.add(id);
                  },
                  onDeleted: (id) {
                    deleted.add(id);
                  },
                );
              },
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      final result = await showSessionCustomerDeleteDialog(
        entryContext,
        session,
        customer: _customer(),
      );

      await tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
      await tester.sendKeyEvent(LogicalKeyboardKey.keyE);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
      await tester.pump();

      expect(result, isNull);
      expect(saved, isEmpty);
      expect(deleted, isEmpty);
      expect(find.byType(SsIconButton), findsNothing);
      expect(find.byType(Dialog), findsNothing);
      expect(tester.takeException(), isNull);

      await tester.pumpWidget(const SizedBox());
      await tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
      await tester.sendKeyEvent(LogicalKeyboardKey.keyE);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);

      expect(tester.takeException(), isNull);
    },
  );

  test(
    'customer deletion navigation requires exact owned URI and genuine ID',
    () {
      final owned = Uri.parse('/customers/customer%2F1?view=contacts#activity');

      expect(
        customerDeletedLocation(
          owned,
          ownedLocation: owned,
          displayedId: 'customer/1',
          acknowledgedId: 'customer/1',
        ),
        '/customers',
      );

      for (final current in [
        owned.replace(query: 'view=projects'),
        owned.replace(fragment: 'remarks'),
        Uri.parse('/customers/other?view=contacts#activity'),
        Uri.parse('/customers/customer%2F1/contacts'),
        Uri.parse('/customers/%FF'),
        Uri.parse('/projects/customer%2F1'),
      ]) {
        expect(
          customerDeletedLocation(
            current,
            ownedLocation: owned,
            displayedId: 'customer/1',
            acknowledgedId: 'customer/1',
          ),
          isNull,
        );
      }

      expect(
        customerDeletedLocation(
          owned,
          ownedLocation: owned,
          displayedId: 'customer/1',
          acknowledgedId: 'other',
        ),
        isNull,
      );
      expect(
        customerDeletedLocation(
          Uri.parse('/customers/'),
          ownedLocation: Uri.parse('/customers/'),
          displayedId: '',
          acknowledgedId: '',
        ),
        isNull,
      );
    },
  );
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

Widget _app({
  required Widget child,
  bool german = false,
  bool narrow = false,
  bool dark = false,
}) {
  final width = narrow ? 320.0 : 800.0;

  return MaterialApp(
    locale: Locale(german ? 'de' : 'en'),
    supportedLocales: const [Locale('en'), Locale('de')],
    localizationsDelegates: GlobalMaterialLocalizations.delegates,
    home: SsTheme(
      colors: dark ? SsColors.dark : SsColors.light,
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
