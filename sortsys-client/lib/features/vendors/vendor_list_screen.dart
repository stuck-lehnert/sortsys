import 'dart:math' as math;

import 'package:flutter/widgets.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

import '../../api/generated/api.g.dart';
import '../../api/generated/models.g.dart' as models;
import '../../state/session_controller.dart';
import '../../ui/query_view.dart';
import '../../ui/text.dart';

enum VendorSortColumn { name, description }

List<models.ProductVendor> sortedVendors(
  List<models.ProductVendor> rows,
  VendorSortColumn? column, {
  bool descending = false,
}) {
  if (column == null) {
    return List.of(rows);
  }

  String key(models.ProductVendor vendor) {
    return switch (column) {
      VendorSortColumn.name => vendor.name.toLowerCase(),
      VendorSortColumn.description => (vendor.description ?? '').toLowerCase(),
    };
  }

  final indexed = rows.indexed.toList();
  indexed.sort((left, right) {
    final a = key(left.$2);
    final b = key(right.$2);

    if (a.isEmpty && b.isEmpty) {
      return left.$1.compareTo(right.$1);
    }

    if (a.isEmpty) {
      return 1;
    }

    if (b.isEmpty) {
      return -1;
    }

    final order = descending ? b.compareTo(a) : a.compareTo(b);

    if (order == 0) {
      return left.$1.compareTo(right.$1);
    }

    return order;
  });

  return [for (final entry in indexed) entry.$2];
}

class VendorListScreen extends StatelessWidget {
  const VendorListScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final session = context.watch<SessionController>();
    final binding = session.binding;

    if (!session.authenticated ||
        session.info?.can('view:productVendors') != true) {
      return Center(
        child: Text(text(context, 'Keine Berechtigung', 'No permission')),
      );
    }

    return Title(
      title: text(context, 'Händler', 'Vendors'),
      color: SsTheme.of(context).text,
      child: Column(
        children: [
          SsPageHeader(title: text(context, 'Händler', 'Vendors')),
          Expanded(
            child: QueryView<List<models.ProductVendor>>(
              requestKey: ApiQueries.productsVendorsList.path,
              identity: const [],
              load: (current) async {
                bool allowed() {
                  return current.authenticated &&
                      current.binding == binding &&
                      current.info?.can('view:productVendors') == true;
                }

                if (!allowed()) {
                  throw StateError('VENDOR_LIST_SCOPE_CHANGED');
                }

                final rows = await current.read(
                  ApiQueries.productsVendorsList,
                  const models.ProductsVendorsListInput(),
                );

                if (!allowed()) {
                  throw StateError('VENDOR_LIST_SCOPE_CHANGED');
                }

                return rows;
              },
              builder: (context, rows, reload) {
                return VendorListRows(
                  rows: rows,
                  onSelected: (vendor) {
                    context.go(
                      '/products/vendors/${Uri.encodeComponent(vendor.id)}',
                    );
                  },
                );
              },
            ),
          ),
        ],
      ),
    );
  }
}

class VendorListRows extends StatefulWidget {
  const VendorListRows({
    super.key,
    required this.rows,
    required this.onSelected,
  });

  final List<models.ProductVendor> rows;
  final ValueChanged<models.ProductVendor> onSelected;

  @override
  State<VendorListRows> createState() {
    return _VendorListRowsState();
  }
}

class _VendorListRowsState extends State<VendorListRows> {
  VendorSortColumn? _column;
  bool _descending = false;
  int _page = 0;
  int _pageSize = 25;

  void _sort(VendorSortColumn column) {
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

  String _label(VendorSortColumn column) {
    return switch (column) {
      VendorSortColumn.name => text(context, 'Name', 'Name'),
      VendorSortColumn.description => text(
        context,
        'Beschreibung',
        'Description',
      ),
    };
  }

  @override
  Widget build(BuildContext context) {
    final sorted = sortedVendors(
      widget.rows,
      _column,
      descending: _descending,
    );
    final lastPage = math.max(0, (sorted.length - 1) ~/ _pageSize);
    final page = _page.clamp(0, lastPage);
    final start = page * _pageSize;
    final visible = sorted.sublist(
      start,
      math.min(start + _pageSize, sorted.length),
    );
    final empty = Padding(
      padding: const EdgeInsets.all(14.4),
      child: Text(
        text(context, 'Keine Einträge vorhanden.', 'No entries available.'),
      ),
    );

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (sorted.isNotEmpty) ...[
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
                _page = 0;
                _pageSize = size;
              });
            },
          ),
          const SizedBox(height: 8),
        ],
        Expanded(
          child: LayoutBuilder(
            builder: (context, constraints) {
              final scale = MediaQuery.textScalerOf(context).scale(14) / 14;

              if (MediaQuery.sizeOf(context).width >= 1000 && scale <= 1.4) {
                return SsDataTable<models.ProductVendor>(
                  rows: visible,
                  rowKey: (vendor) {
                    return vendor.id;
                  },
                  onSelected: widget.onSelected,
                  empty: empty,
                  columns: [
                    for (final column in VendorSortColumn.values)
                      SsTableColumn(
                        label: _label(column),
                        header: SsTableSortHeader(
                          label: _label(column),
                          ascending: _column == column ? !_descending : null,
                          onPressed: () {
                            _sort(column);
                          },
                        ),
                        cell: (vendor) {
                          return Text(
                            column == VendorSortColumn.name
                                ? vendor.name
                                : vendor.description ?? '',
                          );
                        },
                      ),
                  ],
                );
              }

              return ListView(
                padding: EdgeInsets.zero,
                children: [
                  if (visible.isEmpty) empty,
                  for (final vendor in visible)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 8),
                      child: SsSurface(
                        padding: const EdgeInsets.all(9.6),
                        child: SsLink(
                          uri: Uri.parse(
                            '/products/vendors/'
                            '${Uri.encodeComponent(vendor.id)}',
                          ),
                          onPressed: () {
                            widget.onSelected(vendor);
                          },
                          child: Text(vendor.name),
                        ),
                      ),
                    ),
                ],
              );
            },
          ),
        ),
      ],
    );
  }
}
