import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
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
    'attribute cards adapt columns and equal heights with async builders',
    (tester) async {
      final result = Completer<String>();

      await tester.pumpWidget(
        _host(
          SsAttributeList(
            children: [
              SsAttribute(
                key: const ValueKey('name'),
                label: 'Name',
                child: FutureBuilder<String>(
                  future: result.future,
                  builder: (context, snapshot) {
                    return LayoutBuilder(
                      builder: (context, constraints) {
                        return Text(snapshot.data ?? 'Loading');
                      },
                    );
                  },
                ),
              ),
              const SsAttribute(
                key: ValueKey('address'),
                label: 'Address',
                child: Text(
                  'A longer street address that wraps over several lines',
                ),
              ),
              const SsAttribute(
                key: ValueKey('phone'),
                label: 'Phone',
                child: Text('12345'),
              ),
            ],
          ),
        ),
      );
      await tester.pumpAndSettle();

      final name = tester.getRect(find.byKey(const ValueKey('name')));
      final address = tester.getRect(find.byKey(const ValueKey('address')));
      final phone = tester.getRect(find.byKey(const ValueKey('phone')));

      expect(name.top, address.top);
      expect(name.width, closeTo(295.6, 0.01));
      expect(name.height, address.height);
      expect(address.left - name.right, closeTo(8.8, 0.01));
      expect(phone.top - name.bottom, closeTo(8.8, 0.01));
      expect(phone.width, name.width);

      result.complete('Resolved customer');
      await tester.pumpAndSettle();
      expect(find.text('Resolved customer'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    '320px doubled attributes retain source typography and dark surfaces',
    (tester) async {
      await tester.pumpWidget(
        _host(
          const SsAttributeList(
            children: [
              SsAttribute(
                key: ValueKey('address'),
                label: 'Address',
                child: Text('A long address with a building and floor'),
              ),
              SsAttribute(
                key: ValueKey('email'),
                label: 'Email',
                child: Text('long.customer.address@example.com'),
              ),
            ],
          ),
          width: 320,
          scale: 2,
          colors: SsColors.dark,
        ),
      );
      await tester.pumpAndSettle();

      final address = tester.getRect(find.byKey(const ValueKey('address')));
      final email = tester.getRect(find.byKey(const ValueKey('email')));
      final label = tester.widget<Text>(find.text('ADDRESS'));
      final valueStyle = DefaultTextStyle.of(
        tester.element(find.text('long.customer.address@example.com')),
      ).style;
      final decoration =
          tester
                  .widget<DecoratedBox>(
                    find.descendant(
                      of: find.byKey(const ValueKey('address')),
                      matching: find.byType(DecoratedBox),
                    ),
                  )
                  .decoration
              as BoxDecoration;

      expect(address.width, 320);
      expect(email.top - address.bottom, closeTo(8.8, 0.01));
      expect(label.semanticsLabel, 'Address');
      expect(label.style!.fontSize, 12);
      expect(label.style!.letterSpacing, 0.66);
      expect(valueStyle.fontSize, 15.2);
      expect(valueStyle.fontWeight, FontWeight.w500);
      expect(
        decoration.color,
        Color.lerp(SsColors.dark.border, SsColors.dark.mutedSurface, 0.82),
      );
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('links expose URLs and Enter activates while Space scrolls', (
    tester,
  ) async {
    final scroll = ScrollController();
    final semantics = tester.ensureSemantics();
    final uri = Uri.parse('/customers/customer');
    var activations = 0;

    try {
      await tester.pumpWidget(
        _host(
          SingleChildScrollView(
            controller: scroll,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SsLink(
                  uri: uri,
                  onPressed: () {
                    activations++;
                  },
                  child: const Text('Customer'),
                ),
                const SizedBox(height: 2000),
              ],
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(
        tester.getSemantics(find.byType(SsLink)).getSemanticsData().linkUrl,
        uri,
      );

      await tester.tap(find.text('Customer'));
      await tester.pump();
      expect(activations, 1);
      await tester.sendKeyEvent(LogicalKeyboardKey.space);
      await tester.pumpAndSettle();
      final afterSpace = scroll.offset;
      expect(afterSpace, greaterThan(0));
      expect(activations, 1);

      await tester.sendKeyDownEvent(LogicalKeyboardKey.shiftLeft);
      await tester.sendKeyEvent(LogicalKeyboardKey.space);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.shiftLeft);
      await tester.pumpAndSettle();
      expect(scroll.offset, lessThan(afterSpace));
      expect(activations, 1);

      await tester.ensureVisible(find.text('Customer'));
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump();
      expect(activations, 2);
      expect(tester.takeException(), isNull);
    } finally {
      await tester.pumpWidget(const SizedBox.shrink());
      scroll.dispose();
      semantics.dispose();
    }
  });

  testWidgets('disabled links remove URL activation and do not run callbacks', (
    tester,
  ) async {
    final semantics = tester.ensureSemantics();

    try {
      await tester.pumpWidget(
        _host(
          SsLink(
            uri: Uri.parse('/customers/customer'),
            child: const Text('Disabled customer'),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(
        tester.getSemantics(find.byType(SsLink)).getSemanticsData().linkUrl,
        isNull,
      );
      await tester.tap(find.text('Disabled customer'));
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump();
      expect(tester.takeException(), isNull);
    } finally {
      await tester.pumpWidget(const SizedBox.shrink());
      semantics.dispose();
    }
  });

  testWidgets(
    'inline links inherit compact value type without button geometry',
    (tester) async {
      await tester.pumpWidget(
        _host(
          DefaultTextStyle(
            style: SsColors.light.body.copyWith(
              fontSize: 15.2,
              fontWeight: FontWeight.w500,
            ),
            child: SsLink(
              onPressed: () {},
              child: const Text('Inline customer'),
            ),
          ),
        ),
      );
      final style = DefaultTextStyle.of(
        tester.element(find.text('Inline customer')),
      ).style;

      final linkSize = tester.getSize(find.byType(SsLink));
      final textSize = tester.getSize(find.text('Inline customer'));

      expect(linkSize, textSize);
      expect(style.height, 1.2);
      expect(style.fontSize, 15.2);
      expect(style.fontWeight, FontWeight.w500);
      expect(style.color, SsColors.light.strongAccent);
      expect(style.decoration, TextDecoration.none);
      expect(tester.takeException(), isNull);
    },
  );
}

Widget _host(
  Widget body, {
  double width = 600,
  double scale = 1,
  SsColors colors = SsColors.light,
}) {
  return MaterialApp(
    locale: const Locale('en'),
    builder: (context, navigator) {
      return SsTheme(
        colors: colors,
        child: MediaQuery(
          data: MediaQuery.of(context)
              .copyWith(textScaler: TextScaler.linear(scale)),
          child: navigator ?? const SizedBox.shrink(),
        ),
      );
    },
    home: Scaffold(
      body: Align(
        alignment: Alignment.topLeft,
        child: SizedBox(width: width, child: body),
      ),
    ),
  );
}
