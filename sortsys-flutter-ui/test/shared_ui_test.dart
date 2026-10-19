import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

typedef Choice = ({String id, String label});

Widget host(Widget child, {double scale = 1}) {
  return MaterialApp(
    home: Scaffold(
      body: Builder(
        builder: (context) {
          return MediaQuery(
            data: MediaQuery.of(context)
                .copyWith(textScaler: TextScaler.linear(scale)),
            child: SsTheme(colors: SsColors.light, child: child),
          );
        },
      ),
    ),
  );
}

void main() {
  testWidgets('buttons use flat shared controls and keyboard activation', (
    tester,
  ) async {
    final focus = FocusNode();
    addTearDown(focus.dispose);
    var pressed = 0;

    await tester.pumpWidget(
      host(
        SsButton(
          focusNode: focus,
          onPressed: () {
            pressed += 1;
          },

          child: const Text('Save'),
        ),
      ),
    );

    expect(find.byType(FilledButton), findsNothing);
    expect(find.byType(InkWell), findsNothing);
    expect(tester.getSize(find.byType(SsButton)).height, equals(32));

    focus.requestFocus();
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    expect(pressed, 1);

    await tester.pumpWidget(host(const SsButton(child: Text('Save'))));
    await tester.tap(find.text('Save'));
    expect(pressed, 1);
  });

  testWidgets('text fields participate in real Form validation', (
    tester,
  ) async {
    final form = GlobalKey<FormState>();

    await tester.pumpWidget(
      host(
        Form(
          key: form,
          child: SsTextField(
            label: 'Title',
            validator: (value) {
              if (value == null || value.isEmpty) {
                return 'A title is required.';
              }

              return null;
            },
          ),
        ),
      ),
    );

    expect(form.currentState!.validate(), isFalse);
    await tester.pump();
    expect(find.text('A title is required.'), findsOneWidget);

    await tester.enterText(find.byType(TextFormField), 'Harbor');
    expect(form.currentState!.validate(), isTrue);
  });

  testWidgets('typed autocomplete selects records, not free-text IDs', (
    tester,
  ) async {
    const choice = (id: 'customer-1', label: 'Harbor GmbH');
    Choice? selected;

    await tester.pumpWidget(
      host(
        SsAutocompleteField<Choice>(
          label: 'Customer',
          queryIdentity: 'account-1',
          loadOptions: (query) async {
            return [choice];
          },

          displayString: (value) {
            return value.label;
          },

          onChanged: (value) {
            selected = value;
          },
        ),
      ),
    );

    await tester.enterText(find.byType(TextFormField), 'Har');
    await tester.pump(const Duration(milliseconds: 300));
    await tester.pump();
    await tester.tap(find.text('Harbor GmbH').last);
    await tester.pump();
    expect(selected, choice);

    await tester.enterText(
      find.byType(TextFormField),
      'Not a selected customer',
    );
    expect(selected, isNull);
  });

  testWidgets('late autocomplete responses cannot replace newer results', (
    tester,
  ) async {
    final old = Completer<List<String>>();
    final current = Completer<List<String>>();

    await tester.pumpWidget(
      host(
        SsAutocompleteField<String>(
          label: 'Project',
          loadOptions: (query) {
            return query == 'old' ? old.future : current.future;
          },

          displayString: (value) {
            return value;
          },
        ),
      ),
    );

    await tester.enterText(find.byType(TextFormField), 'old');
    await tester.pump(const Duration(milliseconds: 300));
    await tester.enterText(find.byType(TextFormField), 'current');
    await tester.pump(const Duration(milliseconds: 300));

    current.complete(['Current project']);
    await tester.pump();
    await tester.pump();
    old.complete(['Old project']);
    await tester.pump();
    await tester.pump();

    expect(find.text('Current project'), findsOneWidget);
    expect(find.text('Old project'), findsNothing);
  });

  testWidgets('lookup failures are shown instead of fake empty success', (
    tester,
  ) async {
    await tester.pumpWidget(
      host(
        SsAutocompleteField<String>(
          label: 'User',
          loadOptions: (query) async {
            throw StateError('Test lookup failure');
          },

          displayString: (value) {
            return value;
          },
        ),
      ),
    );

    await tester.enterText(find.byType(TextFormField), 'Al');
    await tester.pump(const Duration(milliseconds: 300));
    await tester.pump();

    expect(find.text('Options could not be loaded.'), findsOneWidget);
    expect(find.text('No matches'), findsNothing);
  });

  testWidgets('shared page headers fit 320px with doubled text', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(320, 700));
    addTearDown(() async {
      await tester.binding.setSurfaceSize(null);
    });

    await tester.pumpWidget(
      host(
        const SsPageHeader(
          title: 'Project deployment planning',
          actions: SsTextField(hint: 'Search'),
        ),
        scale: 2,
      ),
    );

    expect(tester.takeException(), isNull);
    expect(find.text('Project deployment planning'), findsOneWidget);
  });

  testWidgets('mobile navigation is custom, dismissible and uses Tabler', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(320, 700));
    addTearDown(() async {
      await tester.binding.setSurfaceSize(null);
    });

    var selections = 0;

    await tester.pumpWidget(
      host(
        SsWorkspaceLayout(
          brand: const Text('sortsys'),
          menuLabel: 'Open navigation',
          closeMenuLabel: 'Close navigation',
          navigationBuilder: (close) {
            return ListView(
              children: [
                SsNavigationItem(
                  label: 'Projects',
                  icon: 'building',
                  selected: true,
                  onPressed: () {
                    selections += 1;
                    close();
                  },
                ),
              ],
            );
          },

          child: const Text('Workspace'),
        ),
      ),
    );

    expect(find.byType(Drawer), findsNothing);
    expect(find.byType(NavigationBar), findsNothing);
    expect(find.byType(AppBar), findsNothing);

    await tester.tap(find.byTooltip('Open navigation'));
    await tester.pump();
    expect(find.text('Projects'), findsOneWidget);
    await tester.tap(find.text('Projects'));
    await tester.pump();
    expect(selections, 1);
    expect(find.text('Projects'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('official icon and offline font licence assets are bundled', (
    tester,
  ) async {
    await tester.pumpWidget(host(const SsIcon('eye')));
    await tester.pumpAndSettle();

    for (final name in ssIconNames) {
      final directory = name == 'trash-can' || name == 'task-complete'
          ? 'carbon'
          : 'tabler';
      final svg = await rootBundle.loadString(
        'packages/sortsys_ui/assets/icons/$directory/$name.svg',
      );
      expect(svg, contains('<svg'));

      if (name == 'trash-can') {
        expect(svg, contains('viewBox="0 0 32 32"'));
        expect(svg, contains('M12 12H14V24H12z'));
        expect(svg, contains('M18 12H20V24H18z'));
        expect(svg, contains('M12 2H20V4H12z'));
        expect(svg, contains('Copyright IBM Corp. 2016, 2023'));
      }

      if (name == 'task-complete') {
        expect(svg, contains('viewBox="0 0 32 32"'));
        expect(svg, contains('M22 27.18 19.41 24.59'));
        expect(svg, contains('M25,5H22V4a2.0058'));
        expect(svg, contains('Copyright IBM Corp. 2016, 2023'));
      }
    }

    final carbonLicence = await rootBundle.loadString(
      'packages/sortsys_ui/assets/icons/carbon/LICENSE',
    );
    expect(carbonLicence, contains('Apache License'));
    expect(carbonLicence, contains('Version 2.0, January 2004'));

    final licence = await rootBundle.loadString(
      'packages/sortsys_ui/assets/fonts/ubuntu/UFL.txt',
    );
    expect(licence, contains('UBUNTU FONT LICENCE Version 1.0'));
    expect(find.byType(Icon), findsNothing);
  });
}
