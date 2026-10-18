import 'package:flutter/material.dart' show MaterialLocalizations, TextField;
import 'package:flutter/services.dart' show TextInputAction, TextInputType;
import 'package:flutter/widgets.dart';

import '../button.dart';
import '../theme.dart';
import 'text_field.dart';

String ssDateText(DateTime value) {
  final local = value.toLocal();
  final day = local.day.toString().padLeft(2, '0');
  final month = local.month.toString().padLeft(2, '0');

  return '$day.$month.${local.year}';
}

DateTime? ssParseDateText(String text) {
  final input = text.trim();
  final european = RegExp(r'^(\d{1,2})\.(\d{1,2})\.(\d{4,6})$')
      .firstMatch(input);
  final iso = RegExp(r'^(\d{4,6})-(\d{2})-(\d{2})$').firstMatch(input);

  if (european == null && iso == null) {
    return null;
  }

  final parts = european ?? iso!;
  final year = int.parse(parts.group(european == null ? 1 : 3)!);
  final month = int.parse(parts.group(2)!);
  final day = int.parse(parts.group(european == null ? 3 : 1)!);

  if (year < 100) {
    return null;
  }

  DateTime date;

  try {
    date = DateTime(year, month, day);
  } on ArgumentError {
    return null;
  }

  if (date.year != year || date.month != month || date.day != day) {
    return null;
  }

  return date;
}

class SsDateField extends FormField<DateTime> {
  SsDateField({
    super.key,
    required this.label,
    required this.clearLabel,
    this.showLabel = true,
    this.hint = 'TT.MM.JJJJ',
    this.onChanged,
    super.initialValue,
    super.enabled,
    super.validator,
    super.onSaved,
  }) : super(
         builder: (state) {
           return (state as _SsDateFieldState)._buildField();
         },
       );

  final String label;
  final String clearLabel;
  final bool showLabel;
  final String hint;
  final ValueChanged<DateTime?>? onChanged;

  @override
  FormFieldState<DateTime> createState() {
    return _SsDateFieldState();
  }
}

class _SsDateFieldState extends FormFieldState<DateTime> {
  late final TextEditingController _controller;
  final _focus = FocusNode();
  bool _invalidFormat = false;
  int _revision = 0;

  @override
  SsDateField get widget {
    return super.widget as SsDateField;
  }

  @override
  bool get hasError {
    return _invalidFormat || super.hasError;
  }

  @override
  String? get errorText {
    if (_invalidFormat) {
      return MaterialLocalizations.of(context).invalidDateFormatLabel;
    }

    return super.errorText;
  }

  @override
  void initState() {
    super.initState();

    _controller = TextEditingController(text: _inputText(value));
    _focus.addListener(_focusChanged);
  }

  @override
  void dispose() {
    _focus.removeListener(_focusChanged);
    _focus.dispose();
    _controller.dispose();

    super.dispose();
  }

  String _inputText(DateTime? date) {
    if (date == null) {
      return '';
    }

    final local = date.toLocal();
    final day = local.day.toString().padLeft(2, '0');
    final month = local.month.toString().padLeft(2, '0');
    final year = local.year.toString().padLeft(4, '0');

    return '$day.$month.$year';
  }

  bool get _malformed {
    return _controller.text.trim().isNotEmpty &&
        ssParseDateText(_controller.text) == null;
  }

  void _replaceText(DateTime? date) {
    final text = _inputText(date);
    _controller.value = TextEditingValue(
      text: text,
      selection: TextSelection.collapsed(offset: text.length),
    );
  }

  void _focusChanged() {
    if (_focus.hasFocus || !mounted) {
      return;
    }

    final malformed = _malformed;

    setState(() {
      _invalidFormat = malformed;
    });

    if (!malformed) {
      _replaceText(value);
    }
  }

  void _textChanged(String text) {
    final parsed = ssParseDateText(text);
    _revision++;

    if (parsed != null || text.trim().isEmpty) {
      _invalidFormat = false;
    }

    // Retain partial input while the user edits the date segments.
    super.didChange(parsed);
    widget.onChanged?.call(parsed);
  }

  @override
  void didChange(DateTime? value) {
    _revision++;
    _invalidFormat = false;
    _replaceText(value);

    super.didChange(value);
  }

  @override
  void reset() {
    _revision++;
    _invalidFormat = false;
    _replaceText(widget.initialValue);

    super.reset();
  }

  @override
  bool validate() {
    final malformed = _malformed;

    setState(() {
      _invalidFormat = malformed;
    });

    final valid = super.validate();

    return valid && !malformed;
  }

  void _clear() {
    if (!widget.enabled) {
      return;
    }

    didChange(null);
    widget.onChanged?.call(null);
  }

  Future<void> _choose() async {
    if (!widget.enabled) {
      return;
    }

    _focus.unfocus();

    final revision = _revision;
    final localizations = MaterialLocalizations.of(context);
    final result = await showGeneralDialog<DateTime>(
      context: context,
      barrierDismissible: true,
      barrierLabel: localizations.modalBarrierDismissLabel,
      pageBuilder: (routeContext, animation, secondaryAnimation) {
        return InheritedTheme.captureAll(
          context,
          SafeArea(
            minimum: const EdgeInsets.all(16),
            child: Center(
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 360),
                child: _SsCalendar(value: value),
              ),
            ),
          ),
        );
      },
    );

    if (!mounted ||
        !widget.enabled ||
        result == null ||
        revision != _revision) {
      return;
    }

    didChange(result);
    widget.onChanged?.call(result);
  }

  Widget _buildField() {
    final colors = SsTheme.of(context);

    return SsFieldLabel(
      label: widget.showLabel ? widget.label : null,
      child: Semantics(
        label: widget.showLabel ? null : widget.label,
        child: TextField(
          controller: _controller,
          focusNode: _focus,
          enabled: widget.enabled,
          keyboardType: TextInputType.datetime,
          textInputAction: TextInputAction.next,
          autocorrect: false,
          enableSuggestions: false,
          style: colors.body.copyWith(
            fontSize: 14.4,
            fontWeight: FontWeight.w500,
          ),
          cursorColor: colors.accent,
          decoration: ssFieldDecoration(
            context,
            hint: widget.hint,
            error: errorText,
            suffix: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                SsIconButton(
                  icon: 'calendar',
                  label: MaterialLocalizations.of(context)
                      .calendarModeButtonLabel,
                  tooltip: widget.label,
                  onPressed: widget.enabled ? _choose : null,
                ),
                SsIconButton(
                  icon: 'x',
                  label: widget.clearLabel,
                  onPressed: !widget.enabled || _controller.text.isEmpty
                      ? null
                      : _clear,
                ),
              ],
            ),
          ),
          onChanged: _textChanged,
        ),
      ),
    );
  }
}

class _SsCalendar extends StatefulWidget {
  const _SsCalendar({this.value});

  final DateTime? value;

  @override
  State<_SsCalendar> createState() {
    return _SsCalendarState();
  }
}

class _SsCalendarState extends State<_SsCalendar> {
  late DateTime _month;

  @override
  void initState() {
    super.initState();

    final initial = widget.value?.toLocal() ?? DateTime.now();
    _month = DateTime(initial.year, initial.month);
  }

  void _shift(int offset) {
    setState(() {
      _month = DateTime(_month.year, _month.month + offset);
    });
  }

  @override
  Widget build(BuildContext context) {
    final colors = SsTheme.of(context);
    final localizations = MaterialLocalizations.of(context);
    final firstWeekday = localizations.firstDayOfWeekIndex;
    final offset = (_month.weekday % 7 - firstWeekday + 7) % 7;
    final days = DateTime(_month.year, _month.month + 1, 0).day;
    final selected = widget.value?.toLocal();

    return DecoratedBox(
      decoration: BoxDecoration(
        color: colors.surface,
        border: Border.all(color: colors.border),
      ),
      child: SingleChildScrollView(
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  SsIconButton(
                    icon: 'chevron-left',
                    label: localizations.previousMonthTooltip,
                    onPressed: () {
                      _shift(-1);
                    },
                  ),
                  Expanded(
                    child: Text(
                      localizations.formatMonthYear(_month),
                      textAlign: TextAlign.center,
                      style: colors.body.copyWith(fontWeight: FontWeight.w500),
                    ),
                  ),
                  SsIconButton(
                    icon: 'chevron-right',
                    label: localizations.nextMonthTooltip,
                    onPressed: () {
                      _shift(1);
                    },
                  ),
                ],
              ),
              const SizedBox(height: 8),
              Row(
                children: [
                  for (var index = 0; index < 7; index++)
                    Expanded(
                      child: Text(
                        localizations.narrowWeekdays[(index + firstWeekday) %
                            7],
                        textAlign: TextAlign.center,
                        style: colors.label,
                      ),
                    ),
                ],
              ),
              const SizedBox(height: 8),
              GridView.builder(
                shrinkWrap: true,
                physics: const NeverScrollableScrollPhysics(),
                itemCount: ((offset + days + 6) ~/ 7) * 7,
                gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
                  crossAxisCount: 7,
                  mainAxisExtent: 48,
                ),
                itemBuilder: (context, index) {
                  final day = index - offset + 1;

                  if (day < 1 || day > days) {
                    return const SizedBox.shrink();
                  }

                  final date = DateTime(_month.year, _month.month, day);
                  final active =
                      selected?.year == date.year &&
                      selected?.month == date.month &&
                      selected?.day == day;

                  return SsButton(
                    kind: SsButtonKind.ghost,
                    padding: EdgeInsets.zero,
                    selected: active,
                    semanticLabel: localizations.formatFullDate(date),
                    onPressed: () {
                      Navigator.of(context).pop(date);
                    },

                    child: Text(localizations.formatDecimal(day)),
                  );
                },
              ),
              const SizedBox(height: 8),
              SsButton(
                kind: SsButtonKind.ghost,
                onPressed: () {
                  Navigator.of(context).pop();
                },

                child: Text(localizations.cancelButtonLabel),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
