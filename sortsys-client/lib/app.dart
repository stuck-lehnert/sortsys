import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:provider/provider.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

import 'navigation/router.dart';
import 'state/session_controller.dart';
import 'ui/theme.dart';

class SortsysApp extends HookWidget {
  const SortsysApp({super.key});

  @override
  Widget build(BuildContext context) {
    final session = context.watch<SessionController>();
    final router = useMemoized(() => createRouter(session), [session]);
    useEffect(() => router.dispose, [router]);

    return MaterialApp.router(
      title: 'sortsys',
      routerConfig: router,
      locale: Locale(session.info?.locale ?? 'de'),
      supportedLocales: const [Locale('de'), Locale('en')],
      localizationsDelegates: GlobalMaterialLocalizations.delegates,
      theme: sortsysTheme(Brightness.light),
      darkTheme: sortsysTheme(Brightness.dark),
      themeMode: ThemeMode.system,
      builder: (context, child) {
        final brightness = Theme.of(context).brightness;
        final colors = brightness == Brightness.dark
            ? SsColors.dark
            : SsColors.light;

        return SsTheme(
          colors: colors,
          child: Material(
            color: colors.background,
            child: child ?? const SizedBox.shrink(),
          ),
        );
      },
    );
  }
}
