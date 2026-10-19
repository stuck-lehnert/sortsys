import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/api.g.dart';
import 'package:sortsys_client/api/procedure.dart';
import 'package:sortsys_client/features/search/command_palette.dart';
import 'package:sortsys_client/features/search/command_palette_controller.dart';
import 'package:sortsys_client/features/search/global_search.dart';
import 'package:sortsys_client/features/search/workspace_commands.dart';
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
    'vendor create command preserves canonical identity and both required roles',
    (tester) async {
      for (final language in ['de', 'en']) {
        final command = await _command(tester, language);

        expect(command.id, 'productVendors.create');
        expect(
          command.label,
          language == 'de' ? 'Händler erstellen' : 'Create vendor',
        );
        expect(command.group, PaletteGroup.create);
        expect(command.role, 'manage:productVendors');
        expect(command.requiredRoles, ['view:productVendors']);
        expect(command.icon, isNull);
        expect(command.isAllowed({'manage:productVendors'}.contains), isFalse);
        expect(command.isAllowed({'view:productVendors'}.contains), isFalse);
        expect(command.isAllowed(_roles().contains), isTrue);
      }
    },
  );

  testWidgets(
    'vendor command permissions are rechecked after visibility or manage changes',
    (tester) async {
      final command = await _command(tester, 'en');
      final permissions = _roles();
      final palette = CommandPaletteController(
        repository: _repository(permissions),
        commands: [command],
      );
      addTearDown(palette.dispose);
      palette.setQuery('> vendor');

      expect(palette.entries.single.command, same(command));
      permissions.remove('view:productVendors');

      expect(palette.entries, isEmpty);
      permissions.add('view:productVendors');
      permissions.remove('manage:productVendors');

      expect(palette.entries, isEmpty);
      permissions.add('manage:productVendors');

      expect(palette.entries.single.command, same(command));
    },
  );

  testWidgets(
    'text-only vendor command renders and activates through real palette keyboard route',
    (tester) async {
      final command = await _command(tester, 'en');
      final changes = ChangeNotifier();
      addTearDown(changes.dispose);
      PaletteEntry? selected;

      Future<void> open(BuildContext context) async {
        selected = await showDialog<PaletteEntry>(
          context: context,
          builder: (context) {
            return SsTheme(
              colors: SsColors.light,
              child: CommandPaletteDialog(
                repository: _repository(_roles()),
                commands: [command],
                scopeChanges: changes,
              ),
            );
          },
        );
      }

      await tester.pumpWidget(
        MaterialApp(
          home: SsTheme(
            colors: SsColors.light,
            child: Scaffold(
              body: Builder(
                builder: (context) {
                  return SsButton(
                    onPressed: () {
                      unawaited(open(context));
                    },
                    child: const Text('Open'),
                  );
                },
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('Open'));
      await tester.pumpAndSettle();
      final row = find.ancestor(
        of: find.text('Create vendor'),
        matching: find.byType(SsPressable),
      );

      expect(row, findsOneWidget);
      expect(
        find.descendant(of: row, matching: find.byType(SsIcon)),
        findsNothing,
      );
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();

      expect(selected?.command, same(command));
      expect(find.byType(CommandPaletteDialog), findsNothing);
      expect(tester.takeException(), isNull);
    },
  );
}

Set<String> _roles() {
  return {'view:productVendors', 'manage:productVendors'};
}

GlobalSearchRepository _repository(Set<String> permissions) {
  return GlobalSearchRepository(
    read: _read,
    can: permissions.contains,
    isCurrent: () {
      return true;
    },
  );
}

Future<O> _read<I, O>(RpcQuery<I, O> query, I input) async {
  expect(query, same(ApiQueries.personalizationActionsList));

  return query.decodeOutput(const <Object?>[]);
}

Future<PaletteCommand> _command(WidgetTester tester, String language) async {
  late List<PaletteCommand> commands;
  await tester.pumpWidget(
    MaterialApp(
      locale: Locale(language),
      supportedLocales: const [Locale('de'), Locale('en')],
      localizationsDelegates: GlobalMaterialLocalizations.delegates,
      home: Builder(
        builder: (context) {
          commands = workspaceCommands(context);

          return const SizedBox.shrink();
        },
      ),
    ),
  );

  return commands.singleWhere((command) {
    return command.id == 'productVendors.create';
  });
}
