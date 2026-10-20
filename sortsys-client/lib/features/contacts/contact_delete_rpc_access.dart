import '../../api/generated/api.g.dart';
import '../../api/generated/models.g.dart' as models;
import '../../api/procedure.dart';
import 'contact_delete_coordinator.dart';
import 'contact_delete_receipt.dart';

typedef ContactDeleteRead =
    Future<O> Function<I, O>(RpcQuery<I, O> query, I input);
typedef ContactDeleteWrite =
    Future<O> Function<I, O>(RpcMutation<I, O> mutation, I input);

final class ContactDeleteRpcAccess implements ContactDeleteAccess {
  const ContactDeleteRpcAccess({
    required this.scope,
    required this.contactId,
    required this.read,
    required this.write,
    required this.isCurrent,
    required this.can,
  });

  @override
  final String scope;

  @override
  final String contactId;

  final ContactDeleteRead read;
  final ContactDeleteWrite write;
  final bool Function() isCurrent;
  final bool Function(String permission) can;

  @override
  void checkCurrent() {
    if (scope.isEmpty || contactId.isEmpty) {
      throw const FormatException('INVALID_CONTACT_DELETE_OWNER');
    }

    if (!isCurrent() || !can('view:contacts')) {
      throw StateError('CONTACT_DELETE_SCOPE_CHANGED');
    }
  }

  @override
  void checkDelete(models.ContactsDeleteInput input) {
    checkCurrent();

    if (input.id != contactId) {
      throw const FormatException('INVALID_CONTACT_DELETE_TARGET');
    }

    if (!can('delete:contacts')) {
      throw StateError('CONTACT_DELETE_FORBIDDEN');
    }
  }

  @override
  Future<models.Contact> getContact(String id) async {
    checkCurrent();

    if (id != contactId) {
      throw const FormatException('INVALID_CONTACT_DELETE_READ_TARGET');
    }

    final contact = await read(
      ApiQueries.contactsGet,
      models.ContactsGetInput(id: id),
    );

    checkCurrent();

    if (contact.id != id) {
      throw const FormatException('CONTACT_DELETE_RESPONSE_ID_MISMATCH');
    }

    return freezeContactDeleteBaseline(contact);
  }

  @override
  Future<models.ContactsDeleteOutput> deleteContact(
    models.ContactsDeleteInput input,
  ) async {
    checkDelete(input);

    final request = models.ContactsDeleteInput(id: input.id);

    final result = await write(ApiMutations.contactsDelete, request);

    // Losing delete permission must not erase a genuine acknowledgement.
    checkCurrent();

    if (!result.success) {
      throw const FormatException('INVALID_CONTACT_DELETE_RESULT');
    }

    return result;
  }
}
