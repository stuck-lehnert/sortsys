import 'package:flutter/material.dart';

import '../button.dart';
import '../icon.dart';
import '../theme.dart';
import 'text_field.dart';

class SsOption<T> {
  const SsOption({required this.value, required this.label});

  final T value;
  final String label;
}

class SsSelectField<T> extends StatelessWidget {
  const SsSelectField({
    super.key,
    required this.value,
    required this.options,
    required this.onChanged,
    this.label,
  });

  final T value;
  final List<SsOption<T>> options;
  final ValueChanged<T>? onChanged;
  final String? label;

  @override
  Widget build(BuildContext context) {
    final colors = SsTheme.of(context);

    return SsFieldLabel(
      label: label,
      child: DropdownButtonFormField<T>(
        initialValue: value,
        isExpanded: true,
        isDense: true,
        elevation: 0,
        borderRadius: BorderRadius.zero,
        dropdownColor: colors.surface,
        focusColor: colors.mutedSurface,
        style: colors.body.copyWith(
          fontSize: 14.4,
          fontWeight: FontWeight.w500,
        ),
        icon: const SsIcon('chevron-down'),
        decoration: ssFieldDecoration(context),
        menuMaxHeight: 320,
        items: [
          for (final option in options)
            DropdownMenuItem<T>(
              value: option.value,
              child: Text(
                option.label,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
            ),
        ],
        onChanged: onChanged == null
            ? null
            : (next) {
                if (next != null) {
                  onChanged!(next);
                }
              },
      ),
    );
  }
}

class SsChoiceBar<T> extends StatelessWidget {
  const SsChoiceBar({
    super.key,
    required this.value,
    required this.options,
    required this.onChanged,
  });

  final T value;
  final List<SsOption<T>> options;
  final ValueChanged<T> onChanged;

  @override
  Widget build(BuildContext context) {
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      child: Row(
        children: [
          for (final option in options)
            Padding(
              padding: const EdgeInsetsDirectional.only(end: 6),
              child: SsButton(
                kind: SsButtonKind.ghost,
                selected: option.value == value,
                onPressed: () {
                  onChanged(option.value);
                },

                child: Text(option.label),
              ),
            ),
        ],
      ),
    );
  }
}
