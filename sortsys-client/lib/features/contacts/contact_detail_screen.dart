import 'package:flutter/widgets.dart';
import 'package:provider/provider.dart';

import '../../api/generated/api.g.dart';
import '../../api/generated/models.g.dart' as models;
import '../../state/session_controller.dart';
import '../../ui/query_view.dart';
import '../entities/entity_presentation.dart';
import '../projects/project_history.dart';
import 'contact_detail_layout.dart';
import 'contact_related_sections.dart';

class ContactDetailScreen extends StatelessWidget {
  const ContactDetailScreen({super.key, required this.id});

  final String id;

  @override
  Widget build(BuildContext context) {
    final session = context.watch<SessionController>();
    final binding = session.binding;

    if (!session.authenticated ||
        session.info?.can('view:contacts') != true) {
      return const EntityAccessDenied();
    }

    return QueryView<models.Contact>(
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
        return ContactDetailLayout(
          contact: contact,
          child: KeyedSubtree(
            key: ValueKey((binding, contact.id, contact.modifiedAt)),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                ProjectRemarks(
                  projectId: contact.id,
                  resourceType: models.RemarksListRequestResourceType.contact,
                ),
                const SizedBox(height: 16),
                ContactRelatedSections(contactId: contact.id),
              ],
            ),
          ),
        );
      },
    );
  }
}
