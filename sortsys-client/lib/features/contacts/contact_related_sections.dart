import 'package:flutter/widgets.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
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
import 'contact_read_repository.dart';

export 'contact_read_repository.dart'
    show contactCustomersInput, contactProjectsInput;

class ContactRelatedSections extends HookWidget {
  const ContactRelatedSections({super.key, required this.contactId});

  final String contactId;

  @override
  Widget build(BuildContext context) {
    final session = context.watch<SessionController>();
    final binding = session.binding;
    final canReadContact = session.authenticated &&
        session.info?.can('view:contacts') == true;
    final canViewCustomers = canReadContact &&
        session.info?.can('view:customers') == true;
    final canViewAllProjects = session.info?.can('view:projects') == true;
    final revision = useState(0);

    final repository = useMemoized(() {
      return ContactReadRepository(
        contactId: contactId,
        read: session.read,
        isCurrent: () {
          return session.authenticated && session.binding == binding;
        },
        can: (permission) {
          return session.info?.can(permission) == true;
        },
      );
    }, [session, binding, contactId]);

    final customersFuture = useMemoized(() {
      if (!canViewCustomers) {
        return null;
      }

      return repository.customers();
    }, [repository, canViewCustomers, revision.value]);
    final projectsFuture = useMemoized(() {
      if (!canReadContact) {
        return null;
      }

      return repository.projects();
    }, [repository, canReadContact, canViewAllProjects, revision.value]);
    final customers = useFuture(customersFuture, preserveState: false);
    final projects = useFuture(projectsFuture, preserveState: false);

    return ContactRelatedContent(
      customers: customers.data ?? const [],
      projects: projects.data ?? const [],
      hasError: customers.hasError || projects.hasError,
      onRetry: () {
        revision.value++;
      },
    );
  }
}

class ContactRelatedContent extends StatelessWidget {
  const ContactRelatedContent({
    super.key,
    required this.customers,
    required this.projects,
    this.hasError = false,
    this.onRetry,
  });

  final List<models.Customer> customers;
  final List<models.Project> projects;
  final bool hasError;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (hasError)
          Padding(
            padding: const EdgeInsets.only(bottom: 16),
            child: Semantics(
              liveRegion: true,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text(
                    text(
                      context,
                      'Verknüpfte Daten konnten nicht geladen werden',
                      'Related data could not be loaded',
                    ),
                    style: SsTheme.of(context).body.copyWith(
                      color: SsTheme.of(context).danger,
                    ),
                  ),
                  if (onRetry != null) ...[
                    const SizedBox(height: 8),
                    Align(
                      alignment: AlignmentDirectional.centerStart,
                      child: SsButton(
                        kind: SsButtonKind.secondary,
                        onPressed: onRetry,
                        child: Text(text(context, 'Erneut laden', 'Reload')),
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ),
        if (customers.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(bottom: 16),
            child: SsDisclosure(
              title: text(
                context,
                'Kunden (${customers.length})',
                'Customers (${customers.length})',
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  for (final customer in customers)
                    Padding(
                      key: ValueKey(customer.id),
                      padding: const EdgeInsets.only(bottom: 8),
                      child: ContactCustomerCard(customer: customer),
                    ),
                ],
              ),
            ),
          ),
        if (projects.isNotEmpty)
          SsDisclosure(
            title: text(
              context,
              'Projekte (${projects.length})',
              'Projects (${projects.length})',
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                for (final project in projects)
                  Padding(
                    key: ValueKey(project.id),
                    padding: const EdgeInsets.only(bottom: 8),
                    child: ContactProjectCard(project: project),
                  ),
              ],
            ),
          ),
      ],
    );
  }
}

class ContactCustomerCard extends StatelessWidget {
  const ContactCustomerCard({super.key, required this.customer});

  final models.Customer customer;

  @override
  Widget build(BuildContext context) {
    final address = customer.address;

    return SsSurface(
      padding: const EdgeInsets.all(9.6),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _ContactEntityTitle(
            location: '/customers/${Uri.encodeComponent(customer.id)}',
            title: customerName(customer),
          ),
          SsAttributeList(
            children: [
              if (address != null)
                SsAttribute(
                  label: 'Anschrift',
                  child: EntityExternalLink(
                    uri: projectAddressUrl(address),
                    label: customerAddress(address),
                  ),
                ),
              ...contactChannelFields(
                context,
                emailAddresses: customer.emailAddresses,
                phoneNumbers: customer.phoneNumbers,
                localizedFallbacks: false,
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class ContactProjectCard extends StatelessWidget {
  const ContactProjectCard({super.key, required this.project});

  final models.Project project;

  @override
  Widget build(BuildContext context) {
    final address = project.address;
    final customerId = project.customerId;

    return SsSurface(
      padding: const EdgeInsets.all(9.6),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _ContactEntityTitle(
            location: '/projects/${Uri.encodeComponent(project.id)}',
            title: project.title,
          ),
          SsAttributeList(
            children: [
              if (address != null)
                SsAttribute(
                  label: 'Anschrift',
                  child: EntityExternalLink(
                    uri: projectAddressUrl(address),
                    label: customerAddress(address),
                  ),
                ),
              if (customerId != null)
                SsAttribute(
                  label: text(context, 'Kunde', 'Customer'),
                  child: _ContactProjectCustomer(id: customerId),
                ),
            ],
          ),
        ],
      ),
    );
  }
}

class _ContactEntityTitle extends StatelessWidget {
  const _ContactEntityTitle({required this.location, required this.title});

  final String location;
  final String title;

  @override
  Widget build(BuildContext context) {
    return DefaultTextStyle(
      style: SsTheme.of(context).body.copyWith(fontWeight: FontWeight.w600),
      child: SsLink(
        uri: Uri.parse(location),
        onPressed: () {
          context.go(location);
        },
        child: Text(title, maxLines: 1, overflow: TextOverflow.ellipsis),
      ),
    );
  }
}

class _ContactProjectCustomer extends StatelessWidget {
  const _ContactProjectCustomer({required this.id});

  final String id;

  @override
  Widget build(BuildContext context) {
    final session = context.watch<SessionController>();

    if (session.info?.can('view:customers') != true) {
      return Text(text(context, 'Unbekannt', 'Unknown'));
    }

    return QueryView<models.Customer>(
      requestKey: ApiQueries.customersGet.path,
      identity: id,
      load: (current) async {
        if (current.info?.can('view:customers') != true) {
          throw StateError('CONTACT_CUSTOMER_LOOKUP_FORBIDDEN');
        }

        final customer = await current.read(
          ApiQueries.customersGet,
          models.CustomersGetInput(id: id),
        );

        if (customer.id != id) {
          throw const FormatException('CUSTOMER_RESPONSE_ID_MISMATCH');
        }

        if (current.info?.can('view:customers') != true) {
          throw StateError('CONTACT_CUSTOMER_LOOKUP_FORBIDDEN');
        }

        return customer;
      },
      builder: (context, customer, reload) {
        return _ContactEntityTitle(
          location: '/customers/${Uri.encodeComponent(customer.id)}',
          title: customerName(customer),
        );
      },
    );
  }
}
