import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/features/contacts/contact_detail_layout.dart';
import 'package:sortsys_client/features/contacts/contact_detail_location.dart';
import 'package:sortsys_client/features/contacts/contact_detail_screen.dart';
import 'package:sortsys_client/features/contacts/contact_edit_action.dart';
import 'package:sortsys_client/features/contacts/session_contact_delete_dialog.dart';
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

  testWidgets(
    'contact menu keeps canonical order genuine icons and callbacks',
    (tester) async {
      var edits = 0;
      var deletes = 0;

      await tester.pumpWidget(
        _app(
          child: ContactDetailMenu(
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

      await tester.tap(find.byKey(const ValueKey('contact-edit')));
      await tester.pumpAndSettle();

      expect(edits, 1);
      expect(deletes, 0);

      await tester.tap(find.byType(SsIconButton));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('contact-delete')));
      await tester.pumpAndSettle();

      expect(edits, 1);
      expect(deletes, 1);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('contact menu omits empty actions and live busy disables both', (
    tester,
  ) async {
    await tester.pumpWidget(_app(child: const ContactDetailMenu()));

    expect(find.byType(SsIconButton), findsNothing);

    var busy = false;
    var calls = 0;
    late StateSetter update;

    await tester.pumpWidget(
      _app(
        child: StatefulBuilder(
          builder: (context, setState) {
            update = setState;

            return ContactDetailMenu(
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
    'delete-only contact menu fits320px doubled German RTL both themes',
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
            width: 320,
            scale: 2,
            direction: TextDirection.rtl,
            dark: dark,
            child: ContactDetailLayout(
              contact: _contact(),
              editAction: ContactDetailMenu(
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
        expect(find.byKey(const ValueKey('contact-edit')), findsNothing);
        expect(find.text('Bearbeiten'), findsNothing);
        expect(find.text('Löschen'), findsOneWidget);
        expect(tester.getSize(find.byType(ContactDetailLayout)).width, 320);
        expect(tester.takeException(), isNull);

        await tester.tap(find.byKey(const ValueKey('contact-delete')));
        await tester.pumpAndSettle();

        expect(deletes, 1);
        expect(tester.takeException(), isNull);
      }
    },
  );

  test(
    'contact deletion permission requires view and delete independently',
    () {
      for (final roles in [
        <String>{},
        {'view:contacts'},
        {'delete:contacts'},
        {'manage:contacts', 'delete:contacts'},
        {'view:contacts', 'manage:contacts'},
        {'view:contacts', 'delete:contacts'},
        {'view:contacts', 'manage:contacts', 'delete:contacts'},
      ]) {
        expect(
          canDeleteContact(roles.contains),
          roles.contains('view:contacts') && roles.contains('delete:contacts'),
        );
      }
    },
  );

  test(
    'contact detail location owns decoded IDs and rejects malformed paths',
    () {
      for (final id in ['contact/1', 'a b', 'ä?+%', 'contact%2F1']) {
        final uri = Uri(
          pathSegments: ['contacts', id],
          query: 'view=contacts',
          fragment: 'activity',
        );

        expect(isContactDetailLocation(uri, id), isTrue);
        expect(isContactDetailLocation(uri, 'other'), isFalse);
      }

      for (final path in [
        '/contacts',
        '/contacts/contact/1',
        '/contacts/contact%2F1/',
        '/projects/contact%2F1',
        '/contacts/%FF',
      ]) {
        expect(isContactDetailLocation(Uri.parse(path), 'contact/1'), isFalse);
      }

      expect(isContactDetailLocation(Uri.parse('/contacts/'), ''), isFalse);
    },
  );

  testWidgets(
    'real final contact menu session rejects delete and disposed keys',
    (tester) async {
      final session = SessionController();
      final saved = <models.Contact>[];
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

                return ContactEditAction(
                  contact: _contact(),
                  onSaved: (record) {
                    saved.add(record);
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

      final result = await showSessionContactDeleteDialog(
        entryContext,
        session,
        contact: _contact(),
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
    'contact deletion navigation requires exact owned URI and genuine ID',
    () {
      final owned = Uri.parse('/contacts/contact%2F1?view=contacts#activity');

      expect(
        contactDeletedLocation(
          owned,
          ownedLocation: owned,
          displayedId: 'contact/1',
          acknowledgedId: 'contact/1',
        ),
        '/contacts',
      );

      for (final current in [
        owned.replace(query: 'view=projects'),
        owned.replace(fragment: 'remarks'),
        Uri.parse('/contacts/other?view=contacts#activity'),
        Uri.parse('/contacts/contact%2F1/contacts'),
        Uri.parse('/contacts/%FF'),
        Uri.parse('/projects/contact%2F1'),
      ]) {
        expect(
          contactDeletedLocation(
            current,
            ownedLocation: owned,
            displayedId: 'contact/1',
            acknowledgedId: 'contact/1',
          ),
          isNull,
        );
      }

      for (final (query, reorderedQuery) in [
        ('view=one&view=two', 'view=two&view=one'),
        ('view=two&view=one', 'view=one&view=two'),
      ]) {
        final repeated = owned.replace(query: query);
        final reordered = repeated.replace(query: reorderedQuery);

        expect(
          contactDeletedLocation(
            repeated,
            ownedLocation: repeated,
            displayedId: 'contact/1',
            acknowledgedId: 'contact/1',
          ),
          '/contacts',
        );
        expect(
          contactDeletedLocation(
            reordered,
            ownedLocation: repeated,
            displayedId: 'contact/1',
            acknowledgedId: 'contact/1',
          ),
          isNull,
        );
      }

      expect(
        contactDeletedLocation(
          owned,
          ownedLocation: owned,
          displayedId: 'contact/1',
          acknowledgedId: 'other',
        ),
        isNull,
      );
      expect(
        contactDeletedLocation(
          Uri.parse('/contacts/'),
          ownedLocation: Uri.parse('/contacts/'),
          displayedId: '',
          acknowledgedId: '',
        ),
        isNull,
      );
    },
  );

  testWidgets(
    'real final contact detail route rejects actions and preserves owned URI',
    (tester) async {
      final session = SessionController();
      addTearDown(session.dispose);
      final owned = Uri.parse(
        '/contacts/contact%2F1?view=one&view=two#remarks',
      );
      final router = GoRouter(
        initialLocation: owned.toString(),
        routes: [
          GoRoute(
            path: '/contacts/:id',
            builder: (context, state) {
              return ContactDetailScreen(id: state.pathParameters['id']!);
            },
          ),
          GoRoute(
            path: '/contacts',
            builder: (context, state) {
              return const SizedBox();
            },
          ),
        ],
      );
      addTearDown(router.dispose);

      await tester.pumpWidget(
        ChangeNotifierProvider.value(
          value: session,
          child: MaterialApp.router(
            routerConfig: router,
            builder: (context, child) {
              return SsTheme(colors: SsColors.light, child: child!);
            },
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byType(ContactDetailScreen), findsOneWidget);
      expect(
        tester.widget<ContactDetailScreen>(find.byType(ContactDetailScreen)).id,
        'contact/1',
      );
      expect(router.routeInformationProvider.value.uri, owned);
      expect(find.byType(SsIconButton), findsNothing);

      await tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
      await tester.sendKeyEvent(LogicalKeyboardKey.keyE);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
      await tester.pump();

      expect(find.byType(Dialog), findsNothing);
      expect(router.routeInformationProvider.value.uri, owned);
      expect(tester.takeException(), isNull);

      router.go('/contacts');
      await tester.pumpAndSettle();

      expect(find.byType(ContactDetailScreen), findsNothing);

      await tester.pumpWidget(const SizedBox());
      await tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
      await tester.sendKeyEvent(LogicalKeyboardKey.keyE);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);

      expect(tester.takeException(), isNull);
    },
  );
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
  bool dark = false,
  double width = 800,
  double scale = 1,
  TextDirection direction = TextDirection.ltr,
}) {
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
