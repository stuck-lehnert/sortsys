import 'package:flutter/widgets.dart';

import '../button.dart';
import '../icon.dart';
import '../theme.dart';

class SsCheckbox extends StatefulWidget {
  const SsCheckbox({
    super.key,
    required this.value,
    required this.label,
    this.onChanged,
    this.helper,
  });

  final bool value;
  final String label;
  final ValueChanged<bool>? onChanged;
  final String? helper;

  @override
  State<SsCheckbox> createState() {
    return _SsCheckboxState();
  }
}

class _SsCheckboxState extends State<SsCheckbox> {
  final _focusNode = FocusNode();
  bool _focused = false;

  @override
  void initState() {
    super.initState();

    _focusNode.addListener(_focusChanged);
  }

  void _focusChanged() {
    setState(() {
      _focused = _focusNode.hasFocus;
    });
  }

  @override
  void dispose() {
    _focusNode.removeListener(_focusChanged);
    _focusNode.dispose();

    super.dispose();
  }

  void _toggle() {
    widget.onChanged?.call(!widget.value);
  }

  @override
  Widget build(BuildContext context) {
    final colors = SsTheme.of(context);
    final enabled = widget.onChanged != null;
    final foreground = enabled ? colors.text : colors.secondaryText;
    final border = widget.value ? colors.strongAccent : colors.strongBorder;
    final boxColor = widget.value ? colors.strongAccent : colors.surface;

    return Semantics(
      container: true,
      label: widget.label,
      hint: widget.helper,
      checked: widget.value,
      enabled: enabled,
      focused: enabled ? _focused : null,
      onTap: enabled ? _toggle : null,
      child: ConstrainedBox(
        constraints: const BoxConstraints(minHeight: 44),
        child: ExcludeSemantics(
          child: SsButton(
            focusNode: _focusNode,
            kind: SsButtonKind.ghost,
            padding: const EdgeInsets.symmetric(vertical: 8),
            alignment: AlignmentDirectional.centerStart,
            onPressed: enabled ? _toggle : null,
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Container(
                  width: 22,
                  height: 22,
                  decoration: BoxDecoration(
                    color: boxColor,
                    border: Border.all(color: border),
                  ),
                  child: widget.value
                      ? SsIcon('check', size: 18, color: colors.onAccent)
                      : null,
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        widget.label,
                        style: colors.body.copyWith(color: foreground),
                      ),
                      if (widget.helper != null) ...[
                        const SizedBox(height: 4),
                        Text(widget.helper!, style: colors.label),
                      ],
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class SsCheckboxField extends FormField<bool> {
  SsCheckboxField({
    super.key,
    required this.label,
    this.helper,
    this.onChanged,
    bool initialValue = false,
    super.enabled,
    super.validator,
    super.onSaved,
    super.autovalidateMode,
  }) : super(
         initialValue: initialValue,
         builder: (state) {
           final field = state.widget as SsCheckboxField;

           return Column(
             mainAxisSize: MainAxisSize.min,
             crossAxisAlignment: CrossAxisAlignment.stretch,
             children: [
               SsCheckbox(
                 label: field.label,
                 helper: field.helper,
                 value: state.value ?? false,
                 onChanged: field.enabled
                     ? (value) {
                         state.didChange(value);
                         field.onChanged?.call(value);
                       }
                     : null,
               ),
               if (state.errorText != null)
                 Text(
                   state.errorText!,
                   style: SsTheme.of(state.context).label
                       .copyWith(color: SsTheme.of(state.context).danger),
                 ),
             ],
           );
         },
       );

  final String label;
  final String? helper;
  final ValueChanged<bool>? onChanged;
}
