import 'dart:async';

import 'package:flutter/widgets.dart';

import '../button.dart';
import '../surface.dart';
import '../theme.dart';
import 'autocomplete_field.dart';

class SsMultiAutocompleteField<T extends Object> extends StatelessWidget {
  const SsMultiAutocompleteField({
    super.key,
    required this.label,
    required this.loadOptions,
    required this.displayString,
    required this.optionKey,
    this.initialValue = const [],
    this.queryIdentity,
    this.onChanged,
    this.validator,
    this.onSaved,
    this.enabled = true,
    this.removeLabel = 'Remove',
    this.loadingText = 'Loading options',
    this.emptyText = 'No matches',
    this.failureText = 'Options could not be loaded.',
    this.selectionRequiredText = 'Choose an option from the list.',
  });

  final String label;
  final FutureOr<List<T>> Function(String) loadOptions;
  final String Function(T) displayString;
  final Object Function(T) optionKey;
  final List<T> initialValue;
  final Object? queryIdentity;
  final ValueChanged<List<T>>? onChanged;
  final FormFieldValidator<List<T>>? validator;
  final FormFieldSetter<List<T>>? onSaved;
  final bool enabled;
  final String removeLabel;
  final String loadingText;
  final String emptyText;
  final String failureText;
  final String selectionRequiredText;

  @override
  Widget build(BuildContext context) {
    return FormField<List<T>>(
      key: ValueKey(queryIdentity),
      initialValue: List.unmodifiable(initialValue),
      validator: validator,
      onSaved: onSaved,
      enabled: enabled,
      builder: (field) {
        final selected = field.value ?? <T>[];
        final selectedKeys = selected.map(optionKey).toSet();

        void change(List<T> next) {
          if (!enabled) {
            return;
          }

          final values = List<T>.unmodifiable(next);
          field.didChange(values);
          onChanged?.call(values);
        }

        return Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (selected.isNotEmpty) ...[
              Wrap(
                spacing: 6,
                runSpacing: 6,
                children: [
                  for (final option in selected)
                    ConstrainedBox(
                      constraints: const BoxConstraints(maxWidth: 260),
                      child: SsBadge(
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Flexible(
                              child: Text(
                                displayString(option),
                                maxLines: 2,
                                overflow: TextOverflow.ellipsis,
                              ),
                            ),
                            SsIconButton(
                              icon: 'x',
                              label: '$removeLabel ${displayString(option)}',
                              onPressed: enabled
                                  ? () {
                                      change([
                                        for (final existing in selected)
                                          if (optionKey(existing) !=
                                              optionKey(option))
                                            existing,
                                      ]);
                                    }
                                  : null,
                            ),
                          ],
                        ),
                      ),
                    ),
                ],
              ),
              const SizedBox(height: 8),
            ],
            SsAutocompleteField<T>(
              label: label,
              queryIdentity: queryIdentity,
              displayString: displayString,
              enabled: enabled,
              clearOnSelect: true,
              loadingText: loadingText,
              emptyText: emptyText,
              failureText: failureText,
              selectionRequiredText: selectionRequiredText,
              loadOptions: (query) async {
                final options = await loadOptions(query);

                final seen = {...selectedKeys};
                final available = <T>[];

                for (final option in options) {
                  if (seen.add(optionKey(option))) {
                    available.add(option);
                  }
                }

                return available;
              },

              onChanged: (option) {
                if (option != null &&
                    !selectedKeys.contains(optionKey(option))) {
                  change([...selected, option]);
                }
              },
            ),
            if (field.errorText != null)
              Text(
                field.errorText!,
                style: SsTheme.of(context).label
                    .copyWith(color: SsTheme.of(context).danger),
              ),
          ],
        );
      },
    );
  }
}
