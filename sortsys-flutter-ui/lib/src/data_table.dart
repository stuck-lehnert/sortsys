import 'package:flutter/widgets.dart';

import 'pressable.dart';
import 'theme.dart';

const _cellPadding = EdgeInsets.symmetric(horizontal: 10.24, vertical: 8.96);

class SsTableColumn<T> {
  const SsTableColumn({
    required this.label,
    required this.cell,
    this.header,
    this.flex = 1,
  });

  final String label;
  final Widget? header;
  final Widget Function(T row) cell;
  final int flex;
}

class SsDataTable<T> extends StatelessWidget {
  const SsDataTable({
    super.key,
    required this.rows,
    required this.columns,
    required this.rowKey,
    this.onSelected,
    this.shrinkWrap = false,
    this.empty,
  });

  final List<T> rows;
  final List<SsTableColumn<T>> columns;
  final Object Function(T row) rowKey;
  final ValueChanged<T>? onSelected;
  final bool shrinkWrap;
  final Widget? empty;

  @override
  Widget build(BuildContext context) {
    final colors = SsTheme.of(context);
    final dark = colors.brightness == Brightness.dark;
    final headerStyle = colors.body.copyWith(
      fontSize: 14.24,
      height: 1.35,
      fontWeight: FontWeight.w600,
      color: colors.secondaryText,
    );

    return DecoratedBox(
      decoration: BoxDecoration(
        color: dark ? const Color(0xff151515) : colors.surface,
        border: Border.all(color: colors.border),
      ),
      child: ListView.builder(
        padding: const EdgeInsets.all(1),
        shrinkWrap: shrinkWrap,
        physics: shrinkWrap ? const NeverScrollableScrollPhysics() : null,
        itemCount: rows.length + 1 + (rows.isEmpty && empty != null ? 1 : 0),
        itemBuilder: (context, index) {
          if (index == 0) {
            return DecoratedBox(
              decoration: BoxDecoration(
                gradient: LinearGradient(
                  begin: Alignment.topCenter,
                  end: Alignment.bottomCenter,
                  colors: [
                    Color.lerp(colors.surface, colors.mutedSurface, 0.88)!,
                    colors.mutedSurface.withValues(alpha: 0.74),
                  ],
                ),
                border: Border(bottom: BorderSide(color: colors.border)),
              ),
              child: DefaultTextStyle(
                style: headerStyle,
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    for (final column in columns)
                      Expanded(
                        flex: column.flex,
                        child:
                            column.header ??
                            Padding(
                              padding: _cellPadding,
                              child: Text(column.label),
                            ),
                      ),
                  ],
                ),
              ),
            );
          }

          if (rows.isEmpty) {
            return empty!;
          }

          final row = rows[index - 1];
          final even = index.isEven;
          final content = DefaultTextStyle(
            style: colors.body.copyWith(fontSize: 14.24, height: 1.35),
            child: Padding(
              padding: const EdgeInsets.only(bottom: 1),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  for (final column in columns)
                    Expanded(
                      flex: column.flex,
                      child: Padding(
                        padding: _cellPadding,
                        child: column.cell(row),
                      ),
                    ),
                ],
              ),
            ),
          );

          Widget paintRow(bool highlighted, bool focused) {
            final background = _rowBackground(colors, even, highlighted);

            return DecoratedBox(
              decoration: BoxDecoration(
                color: background,
                border: Border(
                  bottom: BorderSide(
                    color: focused ? colors.accent : colors.border,
                  ),
                ),
                boxShadow: focused
                    ? [
                        BoxShadow(
                          color: colors.accent.withValues(alpha: 0.36),
                          spreadRadius: 2,
                        ),
                      ]
                    : const [],
              ),
              child: content,
            );
          }

          final select = onSelected;

          if (select == null) {
            return KeyedSubtree(
              key: ValueKey(rowKey(row)),
              child: paintRow(false, false),
            );
          }

          return SsPressable(
            key: ValueKey(rowKey(row)),
            onPressed: () {
              select(row);
            },

            builder: (context, state) {
              return paintRow(state.hovered || state.pressed, state.focused);
            },
          );
        },
      ),
    );
  }
}

Color _rowBackground(SsColors colors, bool even, bool highlighted) {
  if (colors.brightness == Brightness.dark) {
    if (highlighted) {
      return even ? const Color(0xff1a1a1a) : const Color(0xff1d1d1d);
    }

    return even ? const Color(0xff101010) : const Color(0xff161616);
  }

  const accentBackground = Color(0xfff3f7fc);

  if (highlighted) {
    return even
        ? Color.lerp(colors.mutedSurface, accentBackground, 0.34)!
        : Color.alphaBlend(
            accentBackground.withValues(alpha: 0.32),
            colors.surface,
          );
  }

  return even
      ? Color.alphaBlend(
          colors.mutedSurface.withValues(alpha: 0.40),
          colors.surface,
        )
      : colors.surface;
}

class SsTableSortHeader extends StatelessWidget {
  const SsTableSortHeader({
    super.key,
    required this.label,
    required this.onPressed,
    this.ascending,
  });

  final String label;
  final VoidCallback onPressed;
  final bool? ascending;

  @override
  Widget build(BuildContext context) {
    final colors = SsTheme.of(context);

    return Semantics(
      sortKey: null,
      child: SsPressable(
        onPressed: onPressed,
        builder: (context, state) {
          final highlighted = state.hovered || state.focused;
          final foreground = highlighted || ascending != null
              ? colors.text
              : colors.secondaryText;
          final style = DefaultTextStyle.of(context).style
              .copyWith(color: foreground);
          final direction = ascending;
          var indicator = '↕';

          if (direction != null) {
            indicator = direction ? '↑' : '↓';
          }

          return DecoratedBox(
            decoration: BoxDecoration(
              color: highlighted
                  ? Color.lerp(colors.surface, colors.backgroundAccent, 0.62)
                  : null,
              border: state.focused ? Border.all(color: colors.accent) : null,
            ),
            child: Padding(
              padding: _cellPadding,
              child: DefaultTextStyle(
                style: style,
                child: Row(
                  children: [
                    Flexible(child: Text(label)),
                    const SizedBox(width: 4.48),
                    SizedBox(
                      width: 14.4,
                      child: Text(
                        indicator,
                        style: style.copyWith(
                          fontSize: 13.6,
                          color: ascending != null || highlighted
                              ? colors.strongAccent
                              : colors.secondaryText.withValues(alpha: 0.6),
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          );
        },
      ),
    );
  }
}
