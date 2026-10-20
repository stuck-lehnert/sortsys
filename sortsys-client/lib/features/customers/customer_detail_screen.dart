import 'package:flutter/widgets.dart';
import 'package:provider/provider.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

import '../../api/generated/api.g.dart';
import '../../api/generated/models.g.dart' as models;
import '../../state/session_controller.dart';
import '../../ui/entity_external_link.dart';
import '../../ui/query_view.dart';
import '../../ui/text.dart';
import '../projects/project_history.dart';
import '../projects/project_related_sections.dart';
import 'customer_list_state.dart';
import 'customer_edit_action.dart';
import 'customer_related_sections.dart';

class CustomerDetailScreen extends StatelessWidget {
  const CustomerDetailScreen({super.key, required this.id});

  final String id;

  @override
  Widget build(BuildContext context) {
    final session = context.watch<SessionController>();
    final binding = session.binding;

    if (!session.authenticated ||
        session.info?.can('view:customers') != true) {
      return Center(
        child: Text(text(context, 'Keine Berechtigung', 'No permission')),
      );
    }

    return QueryView<models.Customer>(
      key: ValueKey((binding, id)),
      requestKey: ApiQueries.customersGet.path,
      identity: id,
      load: (current) async {
        void checkScope() {
          if (!current.authenticated ||
              current.binding != binding ||
              current.info?.can('view:customers') != true) {
            throw StateError('CUSTOMER_DETAIL_SCOPE_CHANGED');
          }
        }

        checkScope();

        final customer = await current.read(
          ApiQueries.customersGet,
          models.CustomersGetInput(id: id),
        );
        checkScope();

        if (customer.id != id) {
          throw const FormatException('CUSTOMER_RESPONSE_ID_MISMATCH');
        }

        return customer;
      },
      builder: (context, customer, reload) {
        return KeyedSubtree(
          key: ValueKey((binding, id, customer.modifiedAt)),
          child: Builder(
            builder: (ownerContext) {
              bool pageCurrent() {
                return ownerContext.mounted &&
                    session.authenticated &&
                    session.binding == binding &&
                    session.info?.can('view:customers') == true;
              }

              return CustomerDetailLayout(
                customer: customer,
                editAction: session.info?.can('manage:customers') == true
                    ? CustomerEditAction(
                        customer: customer,
                        ownerContext: ownerContext,
                        isActive: pageCurrent,
                        onSaved: (confirmedId) {
                          if (pageCurrent() && confirmedId == id) {
                            reload();
                          }
                        },
                      )
                    : null,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    ProjectRemarks(
                      projectId: id,
                      resourceType: models.RemarksListRequestResourceType.customer,
                    ),
                    const SizedBox(height: 16),
                    ProjectActivity(
                      projectId: id,
                      resourceType: models.ActivityResourceType.customer,
                    ),
                    const SizedBox(height: 16),
                    CustomerRelatedSections(customerId: id),
                  ],
                ),
              );
            },
          ),
        );
      },
    );
  }
}

class CustomerDetailLayout extends StatelessWidget {
  const CustomerDetailLayout({
    super.key,
    required this.customer,
    required this.child,
    this.editAction,
  });

  final models.Customer customer;
  final Widget child;
  final Widget? editAction;

  @override
  Widget build(BuildContext context) {
    final address = customer.address;
    final title = customerName(customer);
    final content = ListView(
      padding: EdgeInsets.zero,
      children: [
        SsPageHeader(title: title, actions: editAction),
        const _CustomerDivider(),
        SsAttributeList(
          children: [
            if (customer.salutation?.isNotEmpty == true)
              SsAttribute(
                label: text(context, 'Anrede', 'Salutation'),
                child: Text(customer.salutation!),
              ),
            SsAttribute(
              label: text(context, 'Name', 'Name'),
              child: Text(customer.name),
            ),
            if (address != null)
              SsAttribute(
                label: text(context, 'Anschrift', 'Address'),
                child: EntityExternalLink(
                  uri: projectAddressUrl(address),
                  label: customerAddress(address),
                ),
              ),
          ],
        ),
        if (customer.emailAddresses.isNotEmpty ||
            customer.phoneNumbers.isNotEmpty) ...[
          const SizedBox(height: 8.8),
          SsAttributeList(
            children: [
              for (final (index, email) in customer.emailAddresses.indexed)
                SsAttribute(
                  label:
                      email.name.valueOrNull ??
                      text(
                        context,
                        'E-Mail ${index + 1}',
                        'Email ${index + 1}',
                      ),
                  child: EntityExternalLink(
                    uri: Uri(scheme: 'mailto', path: email.email),
                    label: email.email,
                  ),
                ),
              for (final (index, phone) in customer.phoneNumbers.indexed)
                SsAttribute(
                  label:
                      phone.name.valueOrNull ??
                      text(
                        context,
                        'Telefon ${index + 1}',
                        'Phone ${index + 1}',
                      ),
                  child: EntityExternalLink(
                    uri: Uri(scheme: 'tel', path: phone.number),
                    label: phone.number,
                  ),
                ),
            ],
          ),
        ],
        const _CustomerDivider(),
        child,
      ],
    );

    if (title.isEmpty) {
      return content;
    }

    return Title(
      title: title,
      color: SsTheme.of(context).surface,
      child: content,
    );
  }
}

class _CustomerDivider extends StatelessWidget {
  const _CustomerDivider();

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 12),
      child: Container(height: 1, color: SsTheme.of(context).border),
    );
  }
}
