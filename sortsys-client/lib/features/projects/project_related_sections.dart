import 'package:flutter/widgets.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

import '../../api/generated/api.g.dart';
import '../../api/generated/models.g.dart' as api_models;
import '../../state/session_controller.dart';
import '../../ui/entity_external_link.dart';
import '../../ui/query_view.dart';
import '../../ui/text.dart';
import 'project_list_state.dart';

Uri projectAddressUrl(api_models.ProjectAddress address) {
  final encoded = Uri.encodeComponent(projectAddress(address));

  return Uri.parse('https://www.google.com/maps/search/$encoded');
}

class ProjectExternalLink extends StatefulWidget {
  const ProjectExternalLink({
    super.key,
    required this.uri,
    required this.label,
  });

  final Uri uri;
  final String label;

  @override
  State<ProjectExternalLink> createState() {
    return _ProjectExternalLinkState();
  }
}

class _ProjectExternalLinkState extends State<ProjectExternalLink> {
  @override
  Widget build(BuildContext context) {
    return EntityExternalLink(uri: widget.uri, label: widget.label);
  }
}

class _ProjectAttribute extends StatelessWidget {
  const _ProjectAttribute({required this.label, required this.child});

  final String label;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return SsAttribute(label: label, child: child);
  }
}

class ProjectAttributes extends StatelessWidget {
  const ProjectAttributes({super.key, required this.project});

  final api_models.Project project;

  @override
  Widget build(BuildContext context) {
    final info = context.watch<SessionController>().info;
    final customerId = project.customerId;
    final leaderId = project.responsibleProjectLeaderUserId;
    final address = project.address;
    final orderDate = project.orderReceivedAt;

    return SsAttributeList(
      children: [
        if (address != null)
          _ProjectAttribute(
            label: text(context, 'Anschrift', 'Address'),
            child: ProjectExternalLink(
              uri: projectAddressUrl(address),
              label: projectAddress(address),
            ),
          ),
        if (customerId != null)
          _ProjectAttribute(
            label: text(context, 'Kunde', 'Customer'),
            child: info?.can('view:customers') != true
                ? Text(text(context, 'Keine Berechtigung', 'No permission'))
                : QueryView<api_models.Customer>(
                    requestKey: ApiQueries.customersGet.path,
                    identity: customerId,
                    load: (session) async {
                      final customer = await session.read(
                        ApiQueries.customersGet,
                        api_models.CustomersGetInput(id: customerId),
                      );

                      if (customer.id != customerId) {
                        throw const FormatException(
                          'CUSTOMER_RESPONSE_ID_MISMATCH',
                        );
                      }

                      return customer;
                    },

                    builder: (context, customer, reload) {
                      final name = [customer.salutation, customer.name]
                          .whereType<String>()
                          .where((part) {
                            return part.isNotEmpty;
                          })
                          .join(' ');

                      final location =
                          '/customers/${Uri.encodeComponent(customer.id)}';

                      return SsLink(
                        uri: Uri.parse(location),
                        onPressed: () {
                          context.go(location);
                        },
                        child: Text(name),
                      );
                    },
                  ),
          ),
        if (orderDate != null)
          _ProjectAttribute(
            label: text(context, 'Auftrag erhalten am', 'Order received on'),
            child: Text(ssDateText(orderDate)),
          ),
        if (leaderId != null)
          _ProjectAttribute(
            label: text(
              context,
              'Verantwortlicher Projektleiter',
              'Responsible project leader',
            ),
            child: info?.can('view:users') != true
                ? Text(text(context, 'Keine Berechtigung', 'No permission'))
                : QueryView<api_models.User>(
                    requestKey: ApiQueries.usersGet.path,
                    identity: leaderId,
                    load: (session) async {
                      final user = await session.read(
                        ApiQueries.usersGet,
                        api_models.UsersGetInput(id: leaderId),
                      );

                      if (user.id != leaderId) {
                        throw const FormatException(
                          'USER_RESPONSE_ID_MISMATCH',
                        );
                      }

                      return user;
                    },

                    builder: (context, user, reload) {
                      final location = '/users/${Uri.encodeComponent(user.id)}';

                      return SsLink(
                        uri: Uri.parse(location),
                        onPressed: () {
                          context.go(location);
                        },
                        child: Text(
                          [
                            user.firstName,
                            user.lastName,
                          ].whereType<String>().join(' '),
                        ),
                      );
                    },
                  ),
          ),
      ],
    );
  }
}

class ProjectContacts extends StatelessWidget {
  const ProjectContacts({super.key, required this.projectId});

  final String projectId;

  @override
  Widget build(BuildContext context) {
    final input = api_models.ProjectsContactsListInput(projectId: projectId);

    return QueryView<List<api_models.ProjectsContactsListResultItem>>(
      requestKey: ApiQueries.projectsContactsList.path,
      identity: input,
      load: (session) {
        return session.read(ApiQueries.projectsContactsList, input);
      },

      builder: (context, contacts, reload) {
        if (contacts.isEmpty) {
          return const SizedBox.shrink();
        }

        return SsDisclosure(
          title: text(
            context,
            'Ansprechpartner (${contacts.length})',
            'Contacts (${contacts.length})',
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              for (final contact in contacts)
                Padding(
                  padding: const EdgeInsets.only(bottom: 12),
                  child: SsSurface(
                    child: Padding(
                      padding: const EdgeInsets.all(12),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          Text(
                            [
                                  contact.salutation,
                                  contact.firstName,
                                  contact.lastName,
                                ]
                                .whereType<String>()
                                .where((part) {
                                  return part.isNotEmpty;
                                })
                                .join(' '),
                          ),
                          if (contact.label != null) Text(contact.label!),
                          if (contact.address != null)
                            ProjectExternalLink(
                              uri: projectAddressUrl(contact.address!),
                              label: projectAddress(contact.address),
                            ),
                          for (final phone in contact.phoneNumbers)
                            ProjectExternalLink(
                              uri: Uri(scheme: 'tel', path: phone.number),
                              label: phone.name.valueOrNull?.isNotEmpty == true
                                  ? '${phone.name.valueOrNull}: ${phone.number}'
                                  : phone.number,
                            ),
                          for (final email in contact.emailAddresses)
                            ProjectExternalLink(
                              uri: Uri(scheme: 'mailto', path: email.email),
                              label: email.name.valueOrNull?.isNotEmpty == true
                                  ? '${email.name.valueOrNull}: ${email.email}'
                                  : email.email,
                            ),
                        ],
                      ),
                    ),
                  ),
                ),
            ],
          ),
        );
      },
    );
  }
}
