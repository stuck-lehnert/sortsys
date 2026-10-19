import 'dart:math' as math;

import 'package:flutter/widgets.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

import '../../api/generated/models.g.dart' as models;
import '../../state/session_controller.dart';
import '../../ui/text.dart';
import 'product_read_repository.dart';

typedef ProductPriceRecord = models.ProductsPriceRecordsListResultItem;

enum ProductPriceSort { date, price }

List<ProductPriceRecord> sortedProductPrices(
  List<ProductPriceRecord> records, {
  ProductPriceSort column = ProductPriceSort.date,
  bool descending = true,
}) {
  final indexed = records.indexed.toList();
  indexed.sort((left, right) {
    final order = column == ProductPriceSort.date
        ? left.$2.timestamp.compareTo(right.$2.timestamp)
        : left.$2.price.compareTo(right.$2.price);

    if (order == 0) {
      return left.$1.compareTo(right.$1);
    }

    return descending ? -order : order;
  });

  return [for (final entry in indexed) entry.$2];
}

class ProductPriceHistory extends StatelessWidget {
  const ProductPriceHistory({
    super.key,
    required this.productId,
    required this.baseUnit,
    required this.records,
    this.chart,
  });

  final String productId;
  final String baseUnit;
  final List<ProductPriceRecord> records;
  final Widget? chart;

  @override
  Widget build(BuildContext context) {
    return SsDisclosure(
      title: text(context, 'Preisentwicklung', 'Price history'),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (records.length >= 2 && chart != null) ...[
            chart!,
            const SizedBox(height: 32),
          ],
          ProductPriceHistoryContent(
            records: records,
            baseUnit: baseUnit,
            vendorBuilder: (context, id, compact) {
              return _PriceVendor(
                key: ValueKey((productId, id, compact)),
                productId: productId,
                vendorId: id,
                compact: compact,
              );
            },
          ),
        ],
      ),
    );
  }
}

class _PriceVendor extends HookWidget {
  const _PriceVendor({
    super.key,
    required this.productId,
    required this.vendorId,
    required this.compact,
  });

  final String productId;
  final String vendorId;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final session = context.watch<SessionController>();
    final binding = session.binding;
    final owner = useRef(productId);
    owner.value = productId;
    final allowed =
        session.authenticated &&
        session.info?.can('view:products') == true &&
        session.info?.can('view:productPriceRecords') == true &&
        session.info?.can('view:productVendors') == true;
    final future = useMemoized(() {
      if (!allowed || vendorId.isEmpty) {
        return null;
      }

      final repository = ProductReadRepository(
        productId: productId,
        read: session.read,
        isCurrent: () {
          return owner.value == productId &&
              session.authenticated &&
              session.binding == binding;
        },
        can: (permission) {
          return session.info?.can(permission) == true;
        },
      );

      return repository.vendorReference(vendorId);
    }, [binding, productId, vendorId, allowed]);
    final snapshot = useFuture(future, preserveState: false);

    if (allowed && snapshot.connectionState != ConnectionState.done) {
      return const SsSpinner(size: 14);
    }

    final vendor = snapshot.data;

    if (!allowed || snapshot.hasError || vendor == null) {
      return Text(
        compact
            ? text(context, 'Unbekannt', 'Unknown')
            : text(context, 'Unbekannter Händler', 'Unknown vendor'),
      );
    }

    final uri = Uri.parse(
      '/products/vendors/${Uri.encodeComponent(vendor.id)}',
    );

    return SsLink(
      uri: uri,
      onPressed: () {
        context.go(uri.toString());
      },
      child: Text(vendor.name),
    );
  }
}

class ProductPriceHistoryContent extends StatefulWidget {
  const ProductPriceHistoryContent({
    super.key,
    required this.records,
    required this.baseUnit,
    required this.vendorBuilder,
  });

  final List<ProductPriceRecord> records;
  final String baseUnit;
  final Widget Function(BuildContext, String, bool) vendorBuilder;

  @override
  State<ProductPriceHistoryContent> createState() {
    return _ProductPriceHistoryContentState();
  }
}

class _ProductPriceHistoryContentState
    extends State<ProductPriceHistoryContent> {
  ProductPriceSort? _column;
  bool _descending = false;
  int _page = 0;
  int _pageSize = 25;

  void _sort(ProductPriceSort column) {
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
    final german = Localizations.localeOf(context).languageCode == 'de';
    final currency = NumberFormat.currency(
      locale: german ? 'de_DE' : 'en_GB',
      name: 'EUR',
      symbol: '€',
      decimalDigits: 2,
    );
    final dates = DateFormat(german ? 'dd.MM.yyyy' : 'dd/MM/yyyy');
    final initial = sortedProductPrices(widget.records);
    final sorted = _column == null
        ? initial
        : sortedProductPrices(
            initial,
            column: _column!,
            descending: _descending,
          );
    final lastPage = math.max(0, (sorted.length - 1) ~/ _pageSize);
    final page = _page.clamp(0, lastPage);
    final start = page * _pageSize;
    final visible = sorted.sublist(
      start,
      math.min(start + _pageSize, sorted.length),
    );
    final dateLabel = text(context, 'Datum', 'Date');
    final priceLabel = text(context, 'Preis', 'Price');
    final vendorLabel = text(context, 'Händler', 'Vendor');

    String price(ProductPriceRecord record) {
      return '${currency.format(record.price)} / ${widget.baseUnit}';
    }

    Widget vendor(ProductPriceRecord record, bool compact) {
      final id = record.vendorId;

      if (id == null || id.isEmpty) {
        return const SizedBox.shrink();
      }

      return widget.vendorBuilder(context, id, compact);
    }

    Widget header(ProductPriceSort column, String label) {
      return SsTableSortHeader(
        label: label,
        ascending: _column == column ? !_descending : null,
        onPressed: () {
          _sort(column);
        },
      );
    }

    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        SizedBox(
          height: 320,
          child: LayoutBuilder(
            builder: (context, constraints) {
              final scale = MediaQuery.textScalerOf(context).scale(14) / 14;

              if (MediaQuery.sizeOf(context).width >= 1000 && scale <= 1.4) {
                return SsDataTable<ProductPriceRecord>(
                  rows: visible,
                  rowKey: (record) {
                    return record.id;
                  },
                  columns: [
                    SsTableColumn(
                      label: dateLabel,
                      header: header(ProductPriceSort.date, dateLabel),
                      cell: (record) {
                        return Text(dates.format(record.timestamp.toLocal()));
                      },
                    ),
                    SsTableColumn(
                      label: priceLabel,
                      header: header(ProductPriceSort.price, priceLabel),
                      cell: (record) {
                        return Text(price(record));
                      },
                    ),
                    SsTableColumn(
                      label: vendorLabel,
                      cell: (record) {
                        return vendor(record, false);
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
                            SsAttribute(
                              label: dateLabel,
                              child: Text(
                                dates.format(record.timestamp.toLocal()),
                              ),
                            ),
                            SsAttribute(
                              label: 'Preis',
                              child: Text(price(record)),
                            ),
                            if (record.vendorId?.isNotEmpty == true)
                              SsAttribute(
                                label: vendorLabel,
                                child: vendor(record, true),
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
              setState(() {
                _page = next - 1;
              });
            },
            onPageSize: (size) {
              setState(() {
                _page = 0;
                _pageSize = size;
              });
            },
          ),
      ],
    );
  }
}
