import 'package:flutter/widgets.dart';

@immutable
class SsColors {
  const SsColors({
    required this.brightness,
    required this.background,
    required this.surface,
    required this.mutedSurface,
    required this.border,
    required this.strongBorder,
    required this.text,
    required this.secondaryText,
    required this.accent,
    required this.strongAccent,
    required this.onAccent,
    required this.danger,
    required this.success,
  });

  final Brightness brightness;
  final Color background;
  final Color surface;
  final Color mutedSurface;
  final Color border;
  final Color strongBorder;
  final Color text;
  final Color secondaryText;
  final Color accent;
  final Color strongAccent;
  final Color onAccent;
  final Color danger;
  final Color success;

  static const light = SsColors(
    brightness: Brightness.light,
    background: Color(0xffffffff),
    surface: Color(0xffffffff),
    mutedSurface: Color(0xfff7f9fc),
    border: Color(0xffd2dce9),
    strongBorder: Color(0xffadc1d6),
    text: Color(0xff14263a),
    secondaryText: Color(0xff576d84),
    accent: Color(0xff2b74ff),
    strongAccent: Color(0xff1456d9),
    onAccent: Color(0xffffffff),
    danger: Color(0xffd64545),
    success: Color(0xff198c5d),
  );

  static const dark = SsColors(
    brightness: Brightness.dark,
    background: Color(0xff101010),
    surface: Color(0xff171717),
    mutedSurface: Color(0xff232323),
    border: Color(0xff363636),
    strongBorder: Color(0xff525252),
    text: Color(0xffeaf2fc),
    secondaryText: Color(0xffc2d2e6),
    accent: Color(0xff5f97ff),
    strongAccent: Color(0xff84b3ff),
    onAccent: Color(0xff0c2240),
    danger: Color(0xfff98787),
    success: Color(0xff64c793),
  );

  Color get warning {
    return brightness == Brightness.dark
        ? const Color(0xffe9b26e)
        : const Color(0xffc87415);
  }

  Color get backgroundAccent {
    return brightness == Brightness.dark
        ? const Color(0xff1a1a1a)
        : const Color(0xfff3f7fc);
  }

  Color get nestedSurface {
    if (brightness == Brightness.dark) {
      return Color.lerp(border, mutedSurface, 0.82)!;
    }

    return Color.lerp(surface, mutedSurface, 0.74)!;
  }

  Color get nestedSurfaceHover {
    if (brightness == Brightness.dark) {
      return Color.lerp(mutedSurface, border, 0.78)!;
    }

    return Color.lerp(border, mutedSurface, 0.74)!;
  }

  TextStyle get body {
    return TextStyle(
      fontFamily: 'Ubuntu',
      package: 'sortsys_ui',
      fontSize: 16,
      height: 1.2,
      color: text,
    );
  }

  TextStyle get label {
    return body.copyWith(
      fontSize: 13.12,
      fontWeight: FontWeight.w600,
      letterSpacing: 0.2624,
      color: secondaryText,
    );
  }

  TextStyle get heading {
    return body.copyWith(
      fontSize: 26,
      height: 1.15,
      letterSpacing: -0.5,
      fontWeight: FontWeight.w700,
    );
  }
}

class SsTheme extends StatelessWidget {
  const SsTheme({super.key, required this.colors, required this.child});

  final SsColors colors;
  final Widget child;

  static SsColors of(BuildContext context) {
    final scope = context.dependOnInheritedWidgetOfExactType<_SsThemeScope>();

    if (scope != null) {
      return scope.colors;
    }

    final brightness = MediaQuery.platformBrightnessOf(context);

    return brightness == Brightness.dark ? SsColors.dark : SsColors.light;
  }

  @override
  Widget build(BuildContext context) {
    return _SsThemeScope(
      colors: colors,
      child: DefaultTextStyle(
        style: colors.body,
        child: IconTheme(
          data: IconThemeData(color: colors.text, size: 20),
          child: child,
        ),
      ),
    );
  }
}

class _SsThemeScope extends InheritedTheme {
  const _SsThemeScope({required this.colors, required super.child});

  final SsColors colors;

  @override
  bool updateShouldNotify(_SsThemeScope oldWidget) {
    return colors != oldWidget.colors;
  }

  @override
  Widget wrap(BuildContext context, Widget child) {
    return SsTheme(colors: colors, child: child);
  }
}
