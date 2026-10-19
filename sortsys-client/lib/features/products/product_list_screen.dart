import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

import '../../api/generated/api.g.dart';
import '../../api/generated/models.g.dart' as models;
import '../../state/session_controller.dart';
import '../../ui/query_view.dart';
import '../../ui/text.dart';
import 'product_detail_layout.dart';
import 'product_filter_dialog.dart';
import 'product_filter_options.dart';
import 'product_list_state.dart';

class ProductListScreen extends StatelessWidget {
  const ProductListScreen({super.key});

  Future<void> _showFilters(
    BuildContext context,
    SessionController session,
    Uri uri,
    ProductListFilter filter,
  ) async {
    final binding = session.binding;

    bool current() {
      return context.mounted &&
          session.authenticated &&
          session.binding == binding &&
          session.info?.can('view:products') == true &&
          GoRouterState.of(context).uri == uri;
    }

    if (!current()) {
      return;
    }

    final options = ProductFilterOptions(
      read: session.read,
      isCurrent: current,
      can: (permission) {
        return session.info?.can(permission) == true;
      },
    );
    final result = await showDialog<ProductListFilter>(
      context: context,
      builder: (dialogContext) {
        final active = dialogContext.watch<SessionController>();

        return ProductFilterDialog(
          initialFilter: filter,
          queryIdentity: (binding, 'product-filter'),
          enabled: identical(active, session) && current(),
          loadBrands: options.brands,
          loadCategories: options.categories,
          onApplied: (next) {
            Navigator.of(dialogContext).pop(next);
          },
          onCancel: () {
            Navigator.of(dialogContext).pop();
          },
        );
      },
    );

    if (!context.mounted || !current() || result == null) {
      return;
    }

    context.go(result.apply(uri).toString());
  }

  @override
  Widget build(BuildContext context) {
    final session = context.watch<SessionController>();
    final binding = session.binding;
    final uri = GoRouterState.of(context).uri;
    final filter = ProductListFilter.fromUri(uri);

    if (!session.authenticated || session.info?.can('view:products') != true) {
      return Center(
        child: Text(text(context, 'Keine Berechtigung', 'No permission')),
      );
    }

    return Title(
      title: text(context, 'Produkte', 'Products'),
      color: SsTheme.of(context).text,
      child: Column(
        children: [
          SsPageHeader(
            title: text(context, 'Produkte', 'Products'),
            actions: Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                SsOperationalTag(
                  onPressed: () {
                    _showFilters(context, session, uri, filter);
                  },
                  child: Text(
                    filter.hasFilter
                        ? text(context, 'Filter ändern', 'Change filter')
                        : text(context, 'Filter', 'Filter'),
                  ),
                ),
                if (filter.hasFilter)
                  SsOperationalTag(
                    onPressed: () {
                      context.go(
                        const ProductListFilter().apply(uri).toString(),
                      );
                    },
                    child: Text(text(context, 'Filter aus', 'Disable filter')),
                  ),
              ],
            ),
          ),
          Expanded(
            child: QueryView<List<models.Product>>(
              requestKey: ApiQueries.productsList.path,
              identity: [filter.category],
              load: (current) async {
                void checkScope() {
                  if (!current.authenticated ||
                      current.binding != binding ||
                      current.info?.can('view:products') != true) {
                    throw StateError('PRODUCT_LIST_SCOPE_CHANGED');
                  }
                }

                checkScope();

                final products = await current.read(
                  ApiQueries.productsList,
                  filter.input(),
                );
                checkScope();

                return List.unmodifiable(products);
              },
              builder: (context, products, reload) {
                return ProductListRows(
                  rows: filter.filterBrand(products),
                  state: ProductListState.fromUri(uri),
                  uri: uri,
                  onStateChanged: (next) {
                    context.go(next.toString());
                  },
                  onSelected: (product) {
                    context.go('/products/${Uri.encodeComponent(product.id)}');
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

String productListNumber(num number) {
  if (number == number.truncateToDouble()) {
    return number.toStringAsFixed(0);
  }

  return number.toString();
}

class ProductListRows extends StatelessWidget {
  const ProductListRows({
    super.key,
    required this.rows,
    required this.state,
    required this.uri,
    required this.onStateChanged,
    required this.onSelected,
  });

  final List<models.Product> rows;
  final ProductListState state;
  final Uri uri;
  final ValueChanged<Uri> onStateChanged;
  final ValueChanged<models.Product> onSelected;

  String _label(BuildContext context, ProductSortColumn column) {
    return switch (column) {
      ProductSortColumn.number => text(context, 'Nummer', 'Number'),
      ProductSortColumn.name => text(context, 'Bezeichnung', 'Name'),
      ProductSortColumn.brand => text(context, 'Hersteller', 'Manufacturer'),
    };
  }

  String _value(models.Product product, ProductSortColumn column) {
    return switch (column) {
      ProductSortColumn.number => productListNumber(product.customId),
      ProductSortColumn.name => product.name,
      ProductSortColumn.brand => product.brand ?? '',
    };
  }

  @override
  Widget build(BuildContext context) {
    final sorted = sortedProducts(rows, state);
    final lastPage = math.max(0, (sorted.length - 1) ~/ state.pageSize);
    final page = state.page.clamp(0, lastPage);
    final start = page * state.pageSize;
    final visible = sorted.sublist(
      start,
      math.min(start + state.pageSize, sorted.length),
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
            pageSize: state.pageSize,
            pageSizes: productPageSizes,
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
              onStateChanged(state.apply(uri, page: next - 1));
            },
            onPageSize: (size) {
              onStateChanged(state.apply(uri, page: 0, pageSize: size));
            },
          ),
          const SizedBox(height: 8),
        ],
        Expanded(
          child: LayoutBuilder(
            builder: (context, constraints) {
              final scale = MediaQuery.textScalerOf(context).scale(14) / 14;

              if (MediaQuery.sizeOf(context).width >= 1000 && scale <= 1.4) {
                return SsDataTable<models.Product>(
                  rows: visible,
                  empty: empty,
                  rowKey: (product) {
                    return product.id;
                  },
                  onSelected: onSelected,
                  columns: [
                    for (final column in ProductSortColumn.values)
                      SsTableColumn(
                        label: _label(context, column),
                        header: SsTableSortHeader(
                          label: _label(context, column),
                          ascending: state.column == column
                              ? !state.descending
                              : null,
                          onPressed: () {
                            onStateChanged(
                              state.apply(uri, toggleColumn: column),
                            );
                          },
                        ),
                        cell: (product) {
                          return Text(_value(product, column));
                        },
                      ),
                  ],
                );
              }

              return ListView(
                padding: EdgeInsets.zero,
                children: [
                  if (visible.isEmpty) empty,
                  for (final product in visible)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 8),
                      child: SsSurface(
                        padding: const EdgeInsets.all(9.6),
                        child: SsLink(
                          uri: Uri.parse(
                            '/products/${Uri.encodeComponent(product.id)}',
                          ),
                          onPressed: () {
                            onSelected(product);
                          },
                          child: Text(
                            '${productListNumber(product.customId)} '
                            '${productTitle(product)}',
                          ),
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
