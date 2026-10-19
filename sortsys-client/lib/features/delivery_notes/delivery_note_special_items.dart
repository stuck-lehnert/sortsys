import 'dart:math' as math;

import 'package:flutter/widgets.dart';
import 'package:intl/intl.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

import '../../api/generated/models.g.dart' as models;
import '../../ui/text.dart';
import 'delivery_note_quantities.dart';

typedef DeliverySpecialItem = models.DeliveryNoteSpecialRecordsItem;

enum DeliverySpecialSort { name, quantity, price, total }

List<DeliverySpecialItem> sortedDeliverySpecialItems(
  List<DeliverySpecialItem> records, {
  DeliverySpecialSort? column,
  bool descending = false,
}) {
  if (column == null) {
    return List.of(records);
  }

  final indexed = records.indexed.toList();

  num value(DeliverySpecialItem record) {
    return switch (column) {
      DeliverySpecialSort.quantity => record.amount,
      DeliverySpecialSort.price => record.pricePerUnit ?? 0,
      DeliverySpecialSort.total => record.amount * (record.pricePerUnit ?? 0),
      _ => 0,
    };
  }

  indexed.sort((left, right) {
    final a = left.$2;
    final b = right.$2;
    int comparison;

    if (column == DeliverySpecialSort.name) {
      if (a.name.isEmpty != b.name.isEmpty) {
        return a.name.isEmpty ? 1 : -1;
      }

      comparison = a.name.compareTo(b.name);
    } else {
      comparison = value(a).compareTo(value(b));
    }

    if (comparison == 0) {
      return left.$1.compareTo(right.$1);
    }

    return descending ? -comparison : comparison;
  });

  return [for (final item in indexed) item.$2];
}

class DeliveryNoteSpecialItems extends StatefulWidget {
  const DeliveryNoteSpecialItems({super.key, required this.records});

  final List<DeliverySpecialItem> records;

  @override
  State<DeliveryNoteSpecialItems> createState() {
    return _DeliveryNoteSpecialItemsState();
  }
}

class _DeliveryNoteSpecialItemsState extends State<DeliveryNoteSpecialItems> {
  DeliverySpecialSort? _column;
  bool _descending = false;
  int _page = 0;
  int _pageSize = 25;

  void _sort(DeliverySpecialSort column) {
    setState(() {
      if (_column != column) {
        _column = column;
        _descending = false;
      } else if (!_descending) {
        _descending = true;
      } else {
        _column = null;
        _descending = false;
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final language = Localizations.localeOf(context).languageCode;
    final currency = NumberFormat.currency(
      locale: language == 'en' ? 'en_GB' : 'de_DE',
      name: 'EUR',
      symbol: '€',
      decimalDigits: 2,
    );
    final labels = [
      text(context, 'Bezeichnung', 'Name'),
      text(context, 'Menge', 'Quantity'),
      text(context, 'Preis pro Einheit', 'Price per unit'),
      text(context, 'Gesamt', 'Total'),
    ];
    final sorted = sortedDeliverySpecialItems(
      widget.records,
      column: _column,
      descending: _descending,
    );
    final lastPage = math.max(0, (sorted.length - 1) ~/ _pageSize);
    final page = _page.clamp(0, lastPage);
    final start = page * _pageSize;
    final visible = sorted.sublist(
      start,
      math.min(start + _pageSize, sorted.length),
    );

    String cell(DeliverySpecialItem record, int index) {
      final price = record.pricePerUnit;

      return switch (index) {
        0 => record.name,
        // Unlike product units, the canonical special-item cell keeps spacing.
        1 => '${formatDeliveryProductAmount(record.amount, '', language)} ${record.unit}',
        2 => price == null ? '' : currency.format(price),
        _ => price == null ? '' : currency.format(record.amount * price),
      };
    }

    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        SizedBox(
          height: 400,
          child: LayoutBuilder(
            builder: (context, constraints) {
              final scale = MediaQuery.textScalerOf(context).scale(14) / 14;

              if (MediaQuery.sizeOf(context).width >= 1000 && scale <= 1.4) {
                return SsDataTable<DeliverySpecialItem>(
                  rows: visible,
                  rowKey: (record) {
                    return record.id;
                  },
                  columns: [
                    for (var index = 0; index < labels.length; index++)
                      SsTableColumn(
                        label: labels[index],
                        header: SsTableSortHeader(
                          label: labels[index],
                          ascending: _column == DeliverySpecialSort.values[index]
                              ? !_descending
                              : null,
                          onPressed: () {
                            _sort(DeliverySpecialSort.values[index]);
                          },
                        ),
                        cell: (record) {
                          return Text(cell(record, index));
                        },
                      ),
                  ],
                );
              }

              return ListView(
                padding: EdgeInsets.zero,
                children: [
                  for (final record in visible)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 8),
                      child: SsSurface(
                        padding: const EdgeInsets.all(9.6),
                        child: SsAttributeList(
                          children: [
                            for (var index = 0; index < labels.length; index++)
                              SsAttribute(
                                label: labels[index],
                                child: Text(cell(record, index)),
                              ),
                          ],
                        ),
                      ),
                    ),
                ],
              );
            },
          ),
        ),
        if (sorted.isNotEmpty)
          SsPagination(
            totalItems: sorted.length,
            page: page + 1,
            pageSize: _pageSize,
            pageSizes: const [25, 50, 100],
            itemsPerPageText: text(context, 'Zeilen pro Seite', 'Rows per page'),
            backwardText: text(context, 'Zurück', 'Previous'),
            forwardText: text(context, 'Weiter', 'Next'),
            itemRangeText: (from, to, total) {
              return text(
                context,
                'Zeile $from–$to von $total',
                'Rows $from–$to of $total',
              );
            },
            pageRangeText: (current, total) {
              return text(
                context,
                'Seite $current von $total',
                'Page $current of $total',
              );
            },
            onPage: (next) {
              setState(() {
                _page = next - 1;
              });
            },
            onPageSize: (size) {
              setState(() {
                _pageSize = size;
              });
            },
          ),
      ],
    );
  }
}
