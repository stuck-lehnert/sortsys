import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/features/tools/tool_archive_notice.dart';
import 'package:sortsys_client/features/tools/tool_detail_layout.dart';
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

  testWidgets('unarchived tool detail has no archive notice', (tester) async {
    await _pump(tester, _tool());

    expect(find.byType(ToolArchiveNotice), findsNothing);
    expect(find.byType(SsInfoCallout), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('tool archive follows header in both languages and themes', (
    tester,
  ) async {
    for (final german in [false, true]) {
      for (final colors in [SsColors.light, SsColors.dark]) {
        await _pump(
          tester,
          _tool(archivedSince: DateTime(2024, 6, 15, 12)),
          locale: german ? 'de' : 'en',
          colors: colors,
        );

        final notice = find.byType(ToolArchiveNotice);
        final callout = tester.widget<SsInfoCallout>(
          find.byType(SsInfoCallout),
        );

        expect(
          find.text(
            german
                ? 'Werkzeug ist seit 15.06.2024 archiviert.'
                : 'Tool has been archived since 06/15/2024.',
          ),
          findsOneWidget,
        );
        expect(callout.kind, SsCalloutKind.info);
        expect(callout.icon, isNull);
        expect(
          tester.getTopLeft(notice).dy,
          tester.getBottomLeft(find.byType(SsPageHeader)).dy,
        );
        expect(find.byType(SsIcon), findsNothing);
        expect(tester.takeException(), isNull);
      }
    }
  });

  testWidgets('tool archive keeps canonical tense and formats the local day', (
    tester,
  ) async {
    for (final date in [
      DateTime(2100, 8, 9),
      DateTime.utc(2024, 6, 15, 23, 30),
    ]) {
      final local = date.toLocal();
      final month = local.month.toString().padLeft(2, '0');
      final day = local.day.toString().padLeft(2, '0');

      await _pump(tester, _tool(archivedSince: date));

      expect(
        find.text('Tool has been archived since $month/$day/${local.year}.'),
        findsOneWidget,
      );
      expect(tester.takeException(), isNull);
    }
  });

  testWidgets('real tool detail wraps German archive at320px in doubled RTL', (
    tester,
  ) async {
    for (final direction in [TextDirection.ltr, TextDirection.rtl]) {
      await _pump(
        tester,
        _tool(archivedSince: DateTime(2024, 6, 15, 12)),
        locale: 'de',
        width: 320,
        scale: 2,
        direction: direction,
      );

      final notice = find.byType(ToolArchiveNotice);

      expect(tester.getSize(find.byType(ToolDetailLayout)).width, 320);
      expect(
        find.text('Werkzeug ist seit 15.06.2024 archiviert.'),
        findsOneWidget,
      );
      expect(tester.getTopLeft(notice).dx, greaterThanOrEqualTo(0));
      expect(tester.getBottomRight(notice).dx, lessThanOrEqualTo(320));
      expect(find.byType(SsIcon), findsNothing);

      await tester.drag(find.byType(ListView), const Offset(0, -300));
      await tester.pumpAndSettle();

      expect(tester.takeException(), isNull);
    }
  });
}

models.Tool _tool({DateTime? archivedSince}) {
  return models.Tool(
    id: 'tool',
    customId: 17,
    brand: 'Brand',
    category: 'Category',
    available: true,
    createdAt: DateTime(2024),
    modifiedAt: DateTime(2024),
    archivedSince: archivedSince,
  );
}

Future<void> _pump(
  WidgetTester tester,
  models.Tool tool, {
  String locale = 'en',
  SsColors? colors,
  double width = 800,
  double scale = 1,
  TextDirection direction = TextDirection.ltr,
}) async {
  await tester.pumpWidget(
    MaterialApp(
      locale: Locale(locale),
      supportedLocales: const [Locale('en'), Locale('de')],
      localizationsDelegates: GlobalMaterialLocalizations.delegates,
      home: SsTheme(
        colors: colors ?? SsColors.light,
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
                child: Directionality(
                  textDirection: direction,
                  child: ToolDetailLayout(
                    tool: tool,
                    child: const SizedBox(height: 40),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}
