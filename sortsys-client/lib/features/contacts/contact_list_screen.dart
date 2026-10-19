import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

import '../../api/generated/api.g.dart';
import '../../api/generated/models.g.dart' as models;
import '../../state/session_controller.dart';
import '../../ui/entity_external_link.dart';
import '../../ui/query_view.dart';
import '../../ui/text.dart';
import '../customers/customer_list_state.dart';
import '../projects/project_related_sections.dart';
import 'contact_detail_layout.dart';
import 'contact_list_state.dart';

class ContactListScreen extends StatelessWidget {
  const ContactListScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final session = context.watch<SessionController>();
    final binding = session.binding;
    final uri = GoRouterState.of(context).uri;

    if (!session.authenticated || session.info?.can('view:contacts') != true) {
      return Center(
        child: Text(text(context, 'Keine Berechtigung', 'No permission')),
      );
    }

    return Title(
      title: text(context, 'Kontakte', 'Contacts'),
      color: SsTheme.of(context).text,
      child: Column(
        children: [
          SsPageHeader(title: text(context, 'Kontakte', 'Contacts')),
          Expanded(
            child: QueryView<List<models.Contact>>(
              requestKey: ApiQueries.contactsList.path,
              identity: const [],
              load: (current) async {
                void checkScope() {
                  if (!current.authenticated ||
                      current.binding != binding ||
                      current.info?.can('view:contacts') != true) {
                    throw StateError('CONTACT_LIST_SCOPE_CHANGED');
                  }
                }

                checkScope();

                final contacts = await current.read(
                  ApiQueries.contactsList,
                  const models.ContactsListInput(),
                );

                checkScope();

                return List.unmodifiable(contacts);
              },
              builder: (context, contacts, reload) {
                return ContactListRows(
                  rows: contacts,
                  state: ContactListState.fromUri(uri),
                  uri: uri,
                  onStateChanged: (next) {
                    context.go(next.toString());
                  },
                  onSelected: (contact) {
                    context.go('/contacts/${Uri.encodeComponent(contact.id)}');
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

class ContactListRows extends StatelessWidget {
  const ContactListRows({
    super.key,
    required this.rows,
    required this.state,
    required this.uri,
    required this.onStateChanged,
    required this.onSelected,
  });

  final List<models.Contact> rows;
  final ContactListState state;
  final Uri uri;
  final ValueChanged<Uri> onStateChanged;
  final ValueChanged<models.Contact> onSelected;

  String _label(BuildContext context, ContactSortColumn column) {
    return switch (column) {
      ContactSortColumn.salutation => text(context, 'Anrede', 'Salutation'),
      ContactSortColumn.firstName => text(context, 'Vorname', 'First name'),
      ContactSortColumn.lastName => text(context, 'Nachname', 'Last name'),
      ContactSortColumn.address => text(context, 'Anschrift', 'Address'),
    };
  }

  @override
  Widget build(BuildContext context) {
    final sorted = sortedContacts(rows, state);
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
            pageSizes: contactPageSizes,
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
                return SsDataTable<models.Contact>(
                  rows: visible,
                  empty: empty,
                  rowKey: (contact) {
                    return contact.id;
                  },
                  onSelected: onSelected,
                  columns: [
                    for (final column in ContactSortColumn.values)
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
                        cell: (contact) {
                          return Text(contactColumnText(contact, column));
                        },
                      ),
                  ],
                );
              }

              return ListView(
                padding: EdgeInsets.zero,
                children: [
                  if (visible.isEmpty) empty,
                  for (final contact in visible)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 8),
                      child: SsSurface(
                        padding: const EdgeInsets.all(9.6),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            SsLink(
                              uri: Uri.parse(
                                '/contacts/${Uri.encodeComponent(contact.id)}',
                              ),
                              onPressed: () {
                                onSelected(contact);
                              },
                              child: Text(contactName(contact)),
                            ),
                            SsAttributeList(
                              children: [
                                if (contact.address != null)
                                  SsAttribute(
                                    label: 'Anschrift',
                                    child: EntityExternalLink(
                                      uri: projectAddressUrl(contact.address!),
                                      label: customerAddress(contact.address),
                                    ),
                                  ),
                                ...contactChannelFields(
                                  context,
                                  emailAddresses: contact.emailAddresses,
                                  phoneNumbers: contact.phoneNumbers,
                                  localizedFallbacks: false,
                                ),
                              ],
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
      ],
    );
  }
}
