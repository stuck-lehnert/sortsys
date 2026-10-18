import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:sortsys_client/app.dart';
import 'package:sortsys_client/state/session_controller.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

void main() {
  testWidgets(
    'login fields use the username minimum and keep password visibility',
    (tester) async {
      final fonts = FontLoader('packages/sortsys_ui/Ubuntu');

      for (final weight in ['Regular', 'Medium', 'Bold']) {
        final asset =
            'packages/sortsys_ui/assets/fonts/ubuntu/'
            'Ubuntu-$weight.ttf';
        final bytes = rootBundle.load(asset);
        fonts.addFont(bytes);
      }

      await fonts.load();

      final session = SessionController();
      addTearDown(session.dispose);

      await tester.pumpWidget(
        ChangeNotifierProvider.value(value: session, child: const SortsysApp()),
      );
      await tester.pumpAndSettle();

      final fields = find.byType(SsTextField);
      final username = find.byWidgetPredicate((widget) {
        return widget is SsTextField &&
            (widget.autofillHints?.contains(AutofillHints.username) ?? false);
      });
      final usernameEditable = find.descendant(
        of: username,
        matching: find.byType(EditableText),
      );
      final usernameContainer = InputDecorator.containerOf(
        tester.element(usernameEditable),
      );

      if (usernameContainer == null) {
        fail('Missing actual username input container');
      }

      final usernameHeight = usernameContainer.size.height;
      final password = find.byWidgetPredicate((widget) {
        return widget is SsTextField && widget.kind == SsTextFieldKind.password;
      });
      final passwordInput = find.descendant(
        of: password,
        matching: find.byType(TextField),
      );
      final passwordDecoration = find.descendant(
        of: password,
        matching: find.byType(InputDecorator),
      );
      final passwordHeight = tester.getSize(passwordDecoration).height;

      expect(fields, findsNWidgets(3));
      expect(username, findsOneWidget);
      expect(usernameHeight, greaterThanOrEqualTo(ssTextFieldMinimumHeight));
      expect(passwordHeight, closeTo(usernameHeight, 0.01));
      expect(tester.widget<TextField>(passwordInput).obscureText, isTrue);
      debugPrint(
        'Actual login heights: username=$usernameHeight, '
        'password=$passwordHeight',
      );

      for (var index = 0; index < 3; index++) {
        final decoration = find.descendant(
          of: fields.at(index),
          matching: find.byType(InputDecorator),
        );
        final height = tester.getSize(decoration).height;

        expect(
          height,
          greaterThanOrEqualTo(usernameHeight),
          reason:
              'Field $index height $height; username reference '
              '$usernameHeight',
        );
      }

      await tester.enterText(passwordInput, 'kept value');
      await tester.tap(
        find.descendant(of: password, matching: find.byType(SsIconButton)),
      );
      await tester.pump();

      final visible = tester.widget<TextField>(passwordInput);

      expect(visible.obscureText, isFalse);
      expect(visible.controller?.text, 'kept value');
      expect(tester.getSize(passwordDecoration).height, passwordHeight);
      expect(tester.takeException(), isNull);
    },
  );
}
