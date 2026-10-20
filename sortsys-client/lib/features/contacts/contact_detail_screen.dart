import 'package:flutter/widgets.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';

import '../../api/generated/api.g.dart';
import '../../api/generated/models.g.dart' as models;
import '../../state/session_controller.dart';
import '../../ui/query_view.dart';
import '../entities/entity_presentation.dart';
import '../projects/project_history.dart';
import 'contact_detail_layout.dart';
import 'contact_detail_location.dart';
import 'contact_edit_action.dart';
import 'contact_related_sections.dart';

class ContactDetailScreen extends StatelessWidget {
  const ContactDetailScreen({super.key, required this.id});

  final String id;

  @override
  Widget build(BuildContext context) {
    final session = context.watch<SessionController>();
    final binding = session.binding;

    if (!session.authenticated || session.info?.can('view:contacts') != true) {
      return const EntityAccessDenied();
    }

    return QueryView<models.Contact>(
      key: ValueKey((binding, id)),
      requestKey: ApiQueries.contactsGet.path,
      identity: id,
      load: (current) async {
        void checkScope() {
          if (!current.authenticated ||
              current.binding != binding ||
              current.info?.can('view:contacts') != true) {
            throw StateError('CONTACT_DETAIL_SCOPE_CHANGED');
          }
        }

        checkScope();

        final contact = await current.read(
          ApiQueries.contactsGet,
          models.ContactsGetInput(id: id),
        );
        checkScope();

        if (contact.id != id) {
          throw const FormatException('CONTACT_RESPONSE_ID_MISMATCH');
        }

        return contact;
      },
      builder: (context, contact, reload) {
        return KeyedSubtree(
          key: ValueKey((binding, id, contact.modifiedAt)),
          child: Builder(
            builder: (ownerContext) {
              final router = GoRouter.of(ownerContext);
              final ownedLocation = router.routeInformationProvider.value.uri;

              bool pageCurrent() {
                if (!ownerContext.mounted ||
                    !session.authenticated ||
                    session.binding != binding ||
                    session.info?.can('view:contacts') != true) {
                  return false;
                }

                final current = router.routeInformationProvider.value.uri;

                return current == ownedLocation &&
                    isContactDetailLocation(current, id);
              }

              return ContactDetailLayout(
                contact: contact,
                // Keep the dialog owner alive when only delete permission is lost.
                editAction: ContactEditAction(
                  contact: contact,
                  ownerContext: ownerContext,
                  isActive: pageCurrent,
                  onSaved: (record) {
                    if (pageCurrent() && record.id == id) {
                      reload();
                    }
                  },
                  onDeleted: (acknowledgedId) {
                    if (!pageCurrent() || acknowledgedId != id) {
                      return;
                    }

                    final destination = contactDeletedLocation(
                      router.routeInformationProvider.value.uri,
                      ownedLocation: ownedLocation,
                      displayedId: id,
                      acknowledgedId: acknowledgedId,
                    );

                    if (destination != null) {
                      router.go(destination);
                    }
                  },
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    ProjectRemarks(
                      projectId: contact.id,
                      resourceType:
                          models.RemarksListRequestResourceType.contact,
                    ),
                    const SizedBox(height: 16),
                    ContactRelatedSections(contactId: contact.id),
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
