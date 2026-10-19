import 'dart:math' as math;

import 'package:flutter/widgets.dart';
import 'package:intl/intl.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

import '../../api/generated/models.g.dart' as models;
import '../../ui/text.dart';
import '../products/product_detail_layout.dart' show productTitle;
import 'delivery_note_products_state.dart';
import 'delivery_note_quantities.dart';

typedef DeliveryProductRecord = models.DeliveryNoteRecordsItem;

class DeliveryNoteProducts extends StatelessWidget {
  const DeliveryNoteProducts({
    super.key,
    required this.noteId,
    required this.records,
    required this.products,
    required this.uri,
    required this.onNavigate,
    this.costs,
    this.loadingProductIds = const {},
  });

  final String noteId;
  final List<DeliveryProductRecord> records;
  final Map<String, models.Product> products;
  final Uri uri;
  final ValueChanged<Uri> onNavigate;
  final models.DeliveryNotesCostsGetOutput? costs;
  final Set<String> loadingProductIds;

  @override
  Widget build(BuildContext context) {
    final language = Localizations.localeOf(context).languageCode;
    final currency = NumberFormat.currency(
      locale: language == 'en' ? 'en_GB' : 'de_DE',
      name: 'EUR',
      symbol: '€',
      decimalDigits: 2,
    );
    final state = DeliveryNoteProductsState.fromUri(uri);
    final costs = this.costs?.noteId == noteId ? this.costs : null;
    final owned = records.where((record) {
      return record.noteId == noteId;
    }).toList();
    final sorted = sortedDeliveryProducts(owned, costs, state);
    final lastPage = math.max(0, (sorted.length - 1) ~/ state.pageSize);
    final page = state.page.clamp(0, lastPage);
    final start = page * state.pageSize;
    final visible = sorted.sublist(
      start,
      math.min(start + state.pageSize, sorted.length),
    );
    final labels = [
      text(context, 'Bezeichnung', 'Name'),
      text(context, 'Menge', 'Quantity'),
      text(context, 'Basismenge', 'Base quantity'),
      text(context, 'mittlerer EP', 'average unit price'),
      text(context, 'Kosten', 'Costs'),
    ];

    Widget cell(DeliveryProductRecord record, int index) {
      final cost = deliveryRecordCost(costs, record.id);

      if (index == 4) {
        return Text(cost == null ? '' : currency.format(cost));
      }

      final average = deliveryAverageUnitPrice(
        costs,
        record.id,
        record.quantity,
      );

      if (index == 3 && average == null) {
        return const Text('-');
      }

      final candidate = products[record.productId];
      final product = candidate?.id == record.productId ? candidate : null;

      if (product == null && loadingProductIds.contains(record.productId)) {
        return const SsSpinner(size: 14);
      }

      if (index == 0) {
        if (product == null) {
          return Text(text(context, 'Unbekannt', 'Unknown'));
        }

        final target = Uri.parse(
          '/products/${Uri.encodeComponent(product.id)}',
        );

        return SsLink(
          uri: target,
          onPressed: () {
            onNavigate(target);
          },
          child: Text(productTitle(product)),
        );
      }

      if (index == 3) {
        final suffix = product?.baseUnit.isNotEmpty == true
            ? '/${product!.baseUnit}'
            : '';

        return Text('${currency.format(average)}$suffix');
      }

      if (product == null) {
        return Text(
          formatDeliveryProductAmount(
            record.quantity,
            index == 1 ? '???' : '',
            language,
          ),
        );
      }

      final quantity = deliveryQuantityInUnit(
        product,
        record.quantity,
        record.unit,
      );

      if (index == 1) {
        return Text(
          formatDeliveryProductAmount(quantity.amount, quantity.unit, language),
        );
      }

      return Text(
        formatDeliveryBaseQuantity(
          record.quantity,
          product.baseUnit,
          quantity.unit,
          language,
        ),
      );
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
                return SsDataTable<DeliveryProductRecord>(
                  rows: visible,
                  rowKey: (record) {
                    return record.id;
                  },
                  columns: [
                    for (var index = 0; index < labels.length; index++)
                      SsTableColumn(
                        label: labels[index],
                        header: index < 3
                            ? null
                            : SsTableSortHeader(
                                label: labels[index],
                                ascending:
                                    state.column ==
                                        DeliveryProductSort.values[index - 3]
                                    ? !state.descending
                                    : null,
                                onPressed: () {
                                  onNavigate(
                                    state.apply(
                                      uri,
                                      toggleColumn:
                                          DeliveryProductSort.values[index - 3],
                                    ),
                                  );
                                },
                              ),
                        cell: (record) {
                          return cell(record, index);
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
                                child: cell(record, index),
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
            pageSize: state.pageSize,
            pageSizes: deliveryProductPageSizes,
            itemsPerPageText: text(
              context,
              'Zeilen pro Seite',
              'Rows per page',
            ),
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
              onNavigate(state.apply(uri, page: next - 1));
            },
            onPageSize: (size) {
              onNavigate(state.apply(uri, pageSize: size));
            },
          ),
      ],
    );
  }
}
