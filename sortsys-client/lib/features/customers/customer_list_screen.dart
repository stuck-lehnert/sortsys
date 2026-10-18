import 'dart:math' as math;

import 'package:flutter/widgets.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

import '../../api/generated/api.g.dart';
import '../../api/generated/models.g.dart' as models;
import '../../state/session_controller.dart';
import '../../ui/entity_external_link.dart';
import '../../ui/text.dart';
import 'customer_list_state.dart';

class CustomerListScreen extends HookWidget {
  const CustomerListScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final session = context.watch<SessionController>();
    final uri = GoRouterState.of(context).uri;
    final state = CustomerListState.fromUri(uri);
    final allowed = session.info?.can('view:customers') == true;
    final revision = useState(0);
    final future = useMemoized(() {
      if (!allowed) {
        return null;
      }

      return session.read(
        ApiQueries.customersList,
        const models.CustomersListInput(),
      );
    }, [session.binding, allowed, revision.value]);
    final snapshot = useFuture(future, preserveState: false);

    if (!allowed) {
      return Center(
        child: Text(text(context, 'Keine Berechtigung', 'No permission')),
      );
    }

    return CustomerListLayout(
      rows: CustomerListRows(
        rows: snapshot.data ?? const [],
        loading: snapshot.connectionState != ConnectionState.done,
        error: snapshot.error,
        state: state,
        uri: uri,
        shrinkWrap: true,
        onRetry: () {
          revision.value++;
        },
        onStateChanged: (next) {
          context.go(next.toString());
        },
        onSelected: (customer) {
          context.go('/customers/${Uri.encodeComponent(customer.id)}');
        },
      ),
    );
  }
}

class CustomerListLayout extends StatelessWidget {
  const CustomerListLayout({super.key, required this.rows});

  final Widget rows;

  @override
  Widget build(BuildContext context) {
    return CustomScrollView(
      slivers: [
        SliverToBoxAdapter(
          child: SsPageHeader(title: text(context, 'Kunden', 'Customers')),
        ),
        const SliverToBoxAdapter(child: SizedBox(height: 8)),
        SliverToBoxAdapter(child: rows),
      ],
    );
  }
}

class CustomerListRows extends StatelessWidget {
  const CustomerListRows({
    super.key,
    required this.rows,
    required this.state,
    required this.uri,
    required this.onStateChanged,
    required this.onSelected,
    this.loading = false,
    this.error,
    this.onRetry,
    this.shrinkWrap = false,
  });

  final List<models.Customer> rows;
  final CustomerListState state;
  final Uri uri;
  final ValueChanged<Uri> onStateChanged;
  final ValueChanged<models.Customer> onSelected;
  final bool loading;
  final Object? error;
  final VoidCallback? onRetry;
  final bool shrinkWrap;

  String _columnLabel(BuildContext context, CustomerSortColumn column) {
    return switch (column) {
      CustomerSortColumn.salutation => text(context, 'Anrede', 'Salutation'),
      CustomerSortColumn.name => text(context, 'Name', 'Name'),
      CustomerSortColumn.address => text(context, 'Anschrift', 'Address'),
      CustomerSortColumn.phone => text(context, 'Telefon', 'Phone'),
      CustomerSortColumn.email => text(context, 'E-Mail', 'Email'),
    };
  }

  Widget _stateContent(BuildContext context) {
    if (error != null) {
      return Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            text(
              context,
              'Einträge konnten nicht geladen werden.',
              'Entries could not be loaded.',
            ),
          ),
          if (onRetry != null) ...[
            const SizedBox(height: 8),
            SsButton(
              kind: SsButtonKind.secondary,
              onPressed: onRetry,
              child: Text(text(context, 'Erneut laden', 'Reload')),
            ),
          ],
        ],
      );
    }

    if (loading) {
      return Wrap(
        spacing: 8,
        runSpacing: 8,
        crossAxisAlignment: WrapCrossAlignment.center,
        children: [
          const SsSpinner(),
          Text(text(context, 'Einträge werden geladen …', 'Loading entries …')),
        ],
      );
    }

    return Text(
      text(context, 'Keine Einträge vorhanden.', 'No entries available.'),
    );
  }

  Widget _compactRows(
    BuildContext context,
    List<models.Customer> visible,
    Widget empty,
  ) {
    final colors = SsTheme.of(context);
    final body = visible.isEmpty
        ? empty
        : Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              for (var index = 0; index < visible.length; index++)
                Padding(
                  padding: EdgeInsets.only(
                    bottom: index == visible.length - 1 ? 0 : 8,
                  ),
                  child: CustomerTile(
                    key: ValueKey(visible[index].id),
                    customer: visible[index],
                    onSelected: onSelected,
                  ),
                ),
            ],
          );

    return DecoratedBox(
      decoration: BoxDecoration(
        color: colors.surface.withValues(alpha: 0.2),
        border: Border.all(color: colors.border),
      ),
      child: Padding(
        padding: const EdgeInsets.all(9),
        child: shrinkWrap ? body : SingleChildScrollView(child: body),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final sorted = sortedCustomers(rows, state);
    final lastPage = math.max(0, (sorted.length - 1) ~/ state.pageSize);
    final page = state.page.clamp(0, lastPage);
    final start = page * state.pageSize;
    final end = math.min(start + state.pageSize, sorted.length);
    final visible = loading || error != null
        ? const <models.Customer>[]
        : sorted.sublist(start, end);
    final empty = Semantics(
      liveRegion: loading || error != null,
      child: Padding(
        padding: const EdgeInsets.all(14.4),
        child: _stateContent(context),
      ),
    );
    final content = LayoutBuilder(
      builder: (context, constraints) {
        final scale = MediaQuery.textScalerOf(context).scale(14) / 14;

        if (MediaQuery.sizeOf(context).width >= 1000 && scale <= 1.4) {
          return SsDataTable<models.Customer>(
            rows: visible,
            shrinkWrap: shrinkWrap,
            empty: empty,
            rowKey: (customer) {
              return customer.id;
            },
            onSelected: onSelected,
            columns: [
              for (final column in CustomerSortColumn.values)
                SsTableColumn(
                  label: _columnLabel(context, column),
                  header: SsTableSortHeader(
                    label: _columnLabel(context, column),
                    ascending: state.sortColumn == column
                        ? !state.descending
                        : null,
                    onPressed: () {
                      onStateChanged(state.apply(uri, toggleColumn: column));
                    },
                  ),
                  cell: (customer) {
                    return Text(customerColumnText(customer, column));
                  },
                ),
            ],
          );
        }

        return _compactRows(context, visible, empty);
      },
    );

    return Column(
      mainAxisSize: shrinkWrap ? MainAxisSize.min : MainAxisSize.max,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (!loading && error == null && sorted.isNotEmpty) ...[
          SsPagination(
            totalItems: sorted.length,
            page: page + 1,
            pageSize: state.pageSize,
            pageSizes: customerPageSizes,
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
            pageRangeText: (page, total) {
              return text(
                context,
                'Seite $page von $total',
                'Page $page of $total',
              );
            },
            onPage: (page) {
              onStateChanged(state.apply(uri, page: page - 1));
            },
            onPageSize: (size) {
              onStateChanged(state.apply(uri, pageSize: size));
            },
          ),
          const SizedBox(height: 8),
        ],
        if (shrinkWrap) content else Expanded(child: content),
      ],
    );
  }
}

class CustomerTile extends StatelessWidget {
  const CustomerTile({
    super.key,
    required this.customer,
    required this.onSelected,
    this.omitAddress = false,
  });

  final models.Customer customer;
  final ValueChanged<models.Customer> onSelected;
  final bool omitAddress;

  @override
  Widget build(BuildContext context) {
    final colors = SsTheme.of(context);
    final location = '/customers/${Uri.encodeComponent(customer.id)}';
    final address = customer.address;
    final attributes = <Widget>[
      if (address != null && !omitAddress)
        SsAttribute(
          label: text(context, 'Anschrift', 'Address'),
          child: EntityExternalLink(
            uri: Uri.parse(
              'https://www.google.com/maps/search/${Uri.encodeComponent(customerAddress(address))}',
            ),
            label: customerAddress(address),
          ),
        ),
      for (final (index, email) in customer.emailAddresses.indexed)
        SsAttribute(
          label:
              email.name.valueOrNull ??
              text(context, 'E-Mail ${index + 1}', 'Email ${index + 1}'),
          child: EntityExternalLink(
            uri: Uri(scheme: 'mailto', path: email.email),
            label: email.email,
          ),
        ),
      for (final (index, phone) in customer.phoneNumbers.indexed)
        SsAttribute(
          label:
              phone.name.valueOrNull ??
              text(context, 'Telefon ${index + 1}', 'Phone ${index + 1}'),
          child: EntityExternalLink(
            uri: Uri(scheme: 'tel', path: phone.number),
            label: phone.number,
          ),
        ),
    ];

    return SsSurface(
      padding: const EdgeInsets.all(9.6),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          DefaultTextStyle(
            style: colors.body.copyWith(fontWeight: FontWeight.w600),
            child: SsLink(
              uri: Uri.parse(location),
              onPressed: () {
                onSelected(customer);
              },
              child: Text(
                customerName(customer),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
            ),
          ),
          SsAttributeList(children: attributes),
        ],
      ),
    );
  }
}
