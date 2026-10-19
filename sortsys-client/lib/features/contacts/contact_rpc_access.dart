import '../../api/generated/api.g.dart';
import '../../api/generated/models.g.dart' as models;
import '../../api/procedure.dart';
import 'contact_read_repository.dart' show ContactRead;
import 'contact_write_access.dart';
import 'contact_write_inputs.dart';

typedef ContactWrite = Future<O> Function<I, O>(
  RpcMutation<I, O> mutation,
  I input,
);

final class ContactRpcAccess implements ContactWriteAccess {
  ContactRpcAccess({
    required this.scope,
    this.contactId,
    required this.read,
    required this.write,
    required this.isCurrent,
    required this.can,
  });

  @override
  final String scope;
  final String? contactId;
  final ContactRead read;
  final ContactWrite write;
  final bool Function() isCurrent;
  final bool Function(String permission) can;

  @override
  void checkCurrent() {
    if (scope.isEmpty || !isCurrent() || !can('view:contacts')) {
      throw StateError('CONTACT_WRITE_SCOPE_CHANGED');
    }
  }

  void _checkManage() {
    checkCurrent();

    if (!can('manage:contacts')) {
      throw StateError('CONTACT_WRITE_NOT_ALLOWED');
    }
  }

  @override
  void checkCreate(models.ContactsCreateInput input) {
    _checkManage();

    if (contactId != null) {
      throw const FormatException('CONTACT_CREATE_CONTEXT_MISMATCH');
    }

    copyContactWriteInput(input);
  }

  @override
  void checkUpdate(models.ContactsUpdateInput input) {
    _checkManage();

    if (contactId == null || input.id.isEmpty || input.id != contactId) {
      throw const FormatException('CONTACT_UPDATE_CONTEXT_MISMATCH');
    }

    copyContactWriteInput(input.data);
  }

  @override
  Future<models.ContactsCreateOutput> createContact(
    models.ContactsCreateInput input,
  ) async {
    checkCreate(input);

    final stable = copyContactWriteInput(input);
    final result = await write(ApiMutations.contactsCreate, stable);
    checkCreate(stable);

    if (result.id.isEmpty) {
      throw const FormatException('UNCONFIRMED_CONTACT_CREATION');
    }

    return result;
  }

  @override
  Future<models.ContactsUpdateOutput> updateContact(
    models.ContactsUpdateInput input,
  ) async {
    checkUpdate(input);

    final stable = models.ContactsUpdateInput(
      id: input.id,
      data: copyContactWriteInput(input.data),
    );
    final result = await write(ApiMutations.contactsUpdate, stable);
    checkUpdate(stable);

    if (!result.success) {
      throw const FormatException('UNCONFIRMED_CONTACT_UPDATE');
    }

    return result;
  }

  @override
  Future<models.Contact?> getContact(String id) async {
    checkCurrent();

    if (id.isEmpty || (contactId != null && id != contactId)) {
      throw const FormatException('CONTACT_READBACK_CONTEXT_MISMATCH');
    }

    final contact = await read(
      ApiQueries.contactsGet,
      models.ContactsGetInput(id: id),
    );
    checkCurrent();

    if (contact.id != id) {
      throw const FormatException('CONTACT_READBACK_ID_MISMATCH');
    }

    return models.Contact(
      id: contact.id,
      salutation: contact.salutation,
      firstName: contact.firstName,
      lastName: contact.lastName,
      address: contact.address,
      phoneNumbers: List.unmodifiable(contact.phoneNumbers),
      emailAddresses: List.unmodifiable(contact.emailAddresses),
      createdAt: contact.createdAt,
      modifiedAt: contact.modifiedAt,
    );
  }
}
