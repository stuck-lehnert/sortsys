import 'package:flutter/material.dart';

import '../theme.dart';

enum SsTextFieldKind { text, search, email, password, phone, integer, decimal }

const ssTextFieldMinimumHeight = 44.0;

InputDecoration ssFieldDecoration(
  BuildContext context, {
  String? hint,
  String? helper,
  String? error,
  Widget? prefix,
  Widget? suffix,
}) {
  final colors = SsTheme.of(context);
  final border = OutlineInputBorder(
    borderRadius: BorderRadius.zero,
    borderSide: BorderSide(color: colors.border),
  );

  return InputDecoration(
    isDense: true,
    filled: true,
    fillColor: colors.surface,
    constraints: const BoxConstraints(minHeight: ssTextFieldMinimumHeight),
    contentPadding: const EdgeInsets.symmetric(
      horizontal: 8.96,
      vertical: 13.5,
    ),
    hintText: hint,
    hintStyle: colors.body.copyWith(
      color: colors.secondaryText.withValues(alpha: 0.82),
      fontSize: 14.4,
      fontWeight: FontWeight.w500,
    ),
    helperText: helper,
    helperMaxLines: 4,
    helperStyle: colors.label.copyWith(fontSize: 12),
    errorText: error,
    errorMaxLines: 4,
    errorStyle: colors.label.copyWith(color: colors.danger, fontSize: 12),
    border: border,
    enabledBorder: border,
    disabledBorder: border,
    focusedBorder: border.copyWith(
      borderSide: BorderSide(
        color: Color.lerp(colors.border, colors.accent, 0.62)!,
      ),
    ),
    errorBorder: border.copyWith(borderSide: BorderSide(color: colors.danger)),
    focusedErrorBorder: border.copyWith(
      borderSide: BorderSide(color: colors.danger),
    ),
    prefixIcon: prefix,
    suffixIcon: suffix,
    prefixIconConstraints: const BoxConstraints(
      minWidth: 30.4,
      minHeight: ssTextFieldMinimumHeight,
    ),
    suffixIconConstraints: const BoxConstraints(
      minWidth: 30.4,
      minHeight: ssTextFieldMinimumHeight,
    ),
  );
}

class SsFieldLabel extends StatelessWidget {
  const SsFieldLabel({super.key, required this.label, required this.child});

  final String? label;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final label = this.label;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        if (label != null) ...[
          ExcludeSemantics(
            child: Text(label, style: SsTheme.of(context).label),
          ),
          const SizedBox(height: 5.12),
        ],
        Semantics(label: label, child: child),
      ],
    );
  }
}

class SsTextField extends StatelessWidget {
  const SsTextField({
    super.key,
    this.label,
    this.hint,
    this.helper,
    this.error,
    this.controller,
    this.focusNode,
    this.initialValue,
    this.kind = SsTextFieldKind.text,
    this.enabled = true,
    this.readOnly = false,
    this.obscureText,
    this.autocorrect = true,
    this.enableSuggestions = true,
    this.autofocus = false,
    this.keyboardType,
    this.textInputAction,
    this.autofillHints,
    this.prefix,
    this.suffix,
    this.maxLines = 1,
    this.minLines,
    this.maxLength,
    this.onChanged,
    this.onSubmitted,
    this.validator,
    this.onSaved,
  });

  final String? label;
  final String? hint;
  final String? helper;
  final String? error;
  final TextEditingController? controller;
  final FocusNode? focusNode;
  final String? initialValue;
  final SsTextFieldKind kind;
  final bool enabled;
  final bool readOnly;
  final bool? obscureText;
  final bool autocorrect;
  final bool enableSuggestions;
  final bool autofocus;
  final TextInputType? keyboardType;
  final TextInputAction? textInputAction;
  final Iterable<String>? autofillHints;
  final Widget? prefix;
  final Widget? suffix;
  final int? maxLines;
  final int? minLines;
  final int? maxLength;
  final ValueChanged<String>? onChanged;
  final ValueChanged<String>? onSubmitted;
  final FormFieldValidator<String>? validator;
  final FormFieldSetter<String>? onSaved;

  TextInputType? _keyboard() {
    return switch (kind) {
      SsTextFieldKind.email => TextInputType.emailAddress,
      SsTextFieldKind.phone => TextInputType.phone,
      SsTextFieldKind.integer => TextInputType.number,
      SsTextFieldKind.decimal => const TextInputType.numberWithOptions(
        decimal: true,
        signed: true,
      ),
      _ => null,
    };
  }

  @override
  Widget build(BuildContext context) {
    final password = kind == SsTextFieldKind.password;
    final colors = SsTheme.of(context);

    return SsFieldLabel(
      label: label,
      child: TextFormField(
        controller: controller,
        focusNode: focusNode,
        initialValue: controller == null ? initialValue : null,
        enabled: enabled,
        readOnly: readOnly,
        autofocus: autofocus,
        obscureText: obscureText ?? password,
        autocorrect: !password && autocorrect,
        enableSuggestions: !password && enableSuggestions,
        keyboardType: keyboardType ?? _keyboard(),
        textInputAction: textInputAction,
        autofillHints: autofillHints,
        maxLines: password ? 1 : maxLines,
        minLines: password ? null : minLines,
        maxLength: maxLength,
        style: colors.body.copyWith(
          fontSize: 14.4,
          fontWeight: FontWeight.w500,
        ),
        cursorColor: colors.accent,
        decoration: ssFieldDecoration(
          context,
          hint: hint,
          helper: helper,
          error: error,
          prefix: prefix,
          suffix: suffix,
        ),
        onChanged: onChanged,
        onFieldSubmitted: onSubmitted,
        validator: validator,
        onSaved: onSaved,
      ),
    );
  }
}
