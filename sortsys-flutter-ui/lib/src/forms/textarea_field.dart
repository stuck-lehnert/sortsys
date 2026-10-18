import 'package:flutter/services.dart' show TextInputAction;
import 'package:flutter/widgets.dart';

import 'text_field.dart';

class SsTextAreaField extends StatelessWidget {
  const SsTextAreaField({
    super.key,
    this.label,
    this.hint,
    this.helper,
    this.error,
    this.controller,
    this.focusNode,
    this.initialValue,
    this.minLines = 4,
    this.maxLines = 12,
    this.maxLength,
    this.enabled = true,
    this.readOnly = false,
    this.onChanged,
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
  final int minLines;
  final int? maxLines;
  final int? maxLength;
  final bool enabled;
  final bool readOnly;
  final ValueChanged<String>? onChanged;
  final FormFieldValidator<String>? validator;
  final FormFieldSetter<String>? onSaved;

  @override
  Widget build(BuildContext context) {
    return SsTextField(
      label: label,
      hint: hint,
      helper: helper,
      error: error,
      controller: controller,
      focusNode: focusNode,
      initialValue: initialValue,
      minLines: minLines,
      maxLines: maxLines,
      maxLength: maxLength,
      enabled: enabled,
      readOnly: readOnly,
      keyboardType: TextInputType.multiline,
      textInputAction: TextInputAction.newline,
      onChanged: onChanged,
      validator: validator,
      onSaved: onSaved,
    );
  }

}
