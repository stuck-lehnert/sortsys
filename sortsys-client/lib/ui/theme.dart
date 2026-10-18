import 'package:flutter/material.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

ThemeData sortsysTheme(Brightness brightness) {
  final colors = brightness == Brightness.dark ? SsColors.dark : SsColors.light;
  const square = RoundedRectangleBorder(borderRadius: BorderRadius.zero);
  final scheme = ColorScheme(
    brightness: brightness,
    primary: colors.strongAccent,
    onPrimary: colors.onAccent,
    secondary: colors.accent,
    onSecondary: colors.onAccent,
    error: colors.danger,
    onError: colors.surface,
    surface: colors.surface,
    onSurface: colors.text,
    onSurfaceVariant: colors.secondaryText,
    outline: colors.border,
    surfaceTint: Colors.transparent,
  );

  // SDK editing/localization still uses Theme; visible controls live in sortsys_ui.
  return ThemeData(
    useMaterial3: false,
    brightness: brightness,
    colorScheme: scheme,
    fontFamily: 'packages/sortsys_ui/Ubuntu',
    scaffoldBackgroundColor: colors.background,
    splashFactory: NoSplash.splashFactory,
    highlightColor: Colors.transparent,
    dividerColor: colors.border,
    dialogTheme: DialogThemeData(
      shape: square,
      elevation: 0,
      backgroundColor: colors.surface,
    ),
    cardTheme: CardThemeData(
      margin: EdgeInsets.zero,
      elevation: 0,
      color: colors.surface,
      shape: square.copyWith(side: BorderSide(color: colors.border)),
    ),
    appBarTheme: AppBarTheme(
      backgroundColor: colors.surface,
      foregroundColor: colors.text,
      elevation: 0,
      scrolledUnderElevation: 0,
    ),
    scrollbarTheme: const ScrollbarThemeData(radius: Radius.zero),
    inputDecorationTheme: const InputDecorationTheme(
      border: OutlineInputBorder(borderRadius: BorderRadius.zero),
    ),
  );
}
