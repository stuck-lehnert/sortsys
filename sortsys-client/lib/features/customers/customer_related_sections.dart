import 'package:flutter/widgets.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

import '../../api/generated/api.g.dart';
import '../../api/generated/models.g.dart' as models;
import '../../api/model.dart';
import '../../state/session_controller.dart';
import '../../ui/entity_external_link.dart';
import '../../ui/text.dart';
import '../projects/project_related_sections.dart';
import 'customer_list_state.dart';

class CustomerRelatedSections extends HookWidget {
  const CustomerRelatedSections({super.key, required this.customerId});

  final String customerId;

  @override
  Widget build(BuildContext context) {
    final session = context.watch<SessionController>();
    final binding = session.binding;
    final canViewContacts = session.info?.can('view:contacts') == true;
    final canViewProjects = session.info?.can('view:projects') == true;
    final revision = useState(0);

    void checkScope(String permission) {
      if (!session.authenticated ||
          session.binding != binding ||
          session.info?.can('view:customers') != true ||
          session.info?.can(permission) != true) {
        throw StateError('CUSTOMER_RELATED_SCOPE_CHANGED');
      }
    }

    final contactsFuture = useMemoized(() {
      if (!canViewContacts) {
        return null;
      }

      return () async {
        checkScope('view:contacts');

        final contacts = await session.read(
          ApiQueries.customersContactsList,
          models.CustomersContactsListInput(customerId: customerId),
        );
        checkScope('view:contacts');

        return contacts;
      }();
    }, [binding, customerId, canViewContacts, revision.value]);
    final projectsFuture = useMemoized(() {
      if (!canViewProjects) {
        return null;
      }

      return () async {
        checkScope('view:projects');

        final projects = await session.read(
          ApiQueries.projectsList,
          models.ProjectsListInput(customerId: RpcOptional.value(customerId)),
        );
        checkScope('view:projects');

        if (projects.any((project) {
          return project.customerId != customerId;
        })) {
          throw const FormatException('CUSTOMER_PROJECT_RESPONSE_MISMATCH');
        }

        return projects;
      }();
    }, [binding, customerId, canViewProjects, revision.value]);
    final contacts = useFuture(contactsFuture, preserveState: false);
    final projects = useFuture(projectsFuture, preserveState: false);

    return CustomerRelatedContent(
      contacts: contacts.data ?? const [],
      projects: projects.data ?? const [],
      hasError: contacts.hasError || projects.hasError,
      onRetry: () {
        revision.value++;
      },
    );
  }
}

class CustomerRelatedContent extends StatelessWidget {
  const CustomerRelatedContent({
    super.key,
    required this.contacts,
    required this.projects,
    this.hasError = false,
    this.onRetry,
  });

  final List<models.Contact> contacts;
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
                    style: SsTheme.of(context).body
                        .copyWith(color: SsTheme.of(context).danger),
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
        if (contacts.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(bottom: 16),
            child: SsDisclosure(
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
                      padding: const EdgeInsets.only(bottom: 8),
                      child: _ContactTile(contact: contact),
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
                    padding: const EdgeInsets.only(bottom: 8),
                    child: _ProjectTile(project: project),
                  ),
              ],
            ),
          ),
      ],
    );
  }
}

class _RelatedTitle extends StatelessWidget {
  const _RelatedTitle({required this.location, required this.title});

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

class _ContactTile extends StatelessWidget {
  const _ContactTile({required this.contact});

  final models.Contact contact;

  @override
  Widget build(BuildContext context) {
    final name = [contact.salutation, contact.firstName, contact.lastName]
        .whereType<String>()
        .where((part) {
          return part.isNotEmpty;
        })
        .join(' ');
    final address = contact.address;

    return SsSurface(
      padding: const EdgeInsets.all(9.6),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _RelatedTitle(
            location: '/contacts/${Uri.encodeComponent(contact.id)}',
            title: name,
          ),
          SsAttributeList(
            children: [
              if (address != null)
                SsAttribute(
                  label: text(context, 'Anschrift', 'Address'),
                  child: EntityExternalLink(
                    uri: projectAddressUrl(address),
                    label: customerAddress(address),
                  ),
                ),
              for (final (index, email) in contact.emailAddresses.indexed)
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
              for (final (index, phone) in contact.phoneNumbers.indexed)
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
      ),
    );
  }
}

class _ProjectTile extends StatelessWidget {
  const _ProjectTile({required this.project});

  final models.Project project;

  @override
  Widget build(BuildContext context) {
    final address = project.address;

    return SsSurface(
      padding: const EdgeInsets.all(9.6),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _RelatedTitle(
            location: '/projects/${Uri.encodeComponent(project.id)}',
            title: project.title,
          ),
          SsAttributeList(
            children: [
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
        ],
      ),
    );
  }
}
