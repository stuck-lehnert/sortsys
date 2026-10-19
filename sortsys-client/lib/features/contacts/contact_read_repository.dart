import '../../api/generated/api.g.dart';
import '../../api/generated/models.g.dart' as models;
import '../../api/procedure.dart';

typedef ContactRead = Future<O> Function<I, O>(RpcQuery<I, O> query, I input);

models.ContactsCustomersListInput contactCustomersInput(String contactId) {
  return models.ContactsCustomersListInput(contactId: contactId);
}

models.ContactsProjectsListInput contactProjectsInput(String contactId) {
  return models.ContactsProjectsListInput(contactId: contactId);
}

final class ContactReadRepository {
  ContactReadRepository({
    required this.contactId,
    required this.read,
    required this.isCurrent,
    required this.can,
  });

  final String contactId;
  final ContactRead read;
  final bool Function() isCurrent;
  final bool Function(String permission) can;

  void _check(String permission) {
    if (contactId.isEmpty) {
      throw const FormatException('INVALID_CONTACT_ID');
    }

    if (!isCurrent() || !can('view:contacts') || !can(permission)) {
      throw StateError('CONTACT_RELATED_SCOPE_CHANGED');
    }
  }

  Future<List<models.Customer>> customers() async {
    _check('view:customers');

    final customers = await read(
      ApiQueries.contactsCustomersList,
      contactCustomersInput(contactId),
    );
    _check('view:customers');

    return customers;
  }

  Future<List<models.Project>> projects() async {
    _check('view:contacts');

    final canViewAll = can('view:projects');
    final projects = await read(
      ApiQueries.contactsProjectsList,
      contactProjectsInput(contactId),
    );
    _check('view:contacts');

    // A role change invalidates a snapshot with broader project visibility.
    if (can('view:projects') != canViewAll) {
      throw StateError('CONTACT_PROJECT_VISIBILITY_CHANGED');
    }

    return projects;
  }
}
