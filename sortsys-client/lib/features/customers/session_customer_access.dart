import 'dart:convert';

import '../../api/generated/api.g.dart';
import '../../api/generated/models.g.dart' as models;
import '../../api/model.dart';
import '../../state/session_controller.dart';
import 'customer_write.dart';

final class SessionCustomerAccess implements CustomerWriteAccess {
  SessionCustomerAccess(this.session)
    : _binding = session.binding,
      scope = jsonEncode([
        session.instance?.origin.toString(),
        session.tenant,
        session.info?.userId,
      ]);

  final SessionController session;
  final String _binding;

  @override
  final String scope;

  @override
  bool get canSelectContacts {
    return session.info?.can('view:contacts') == true;
  }

  @override
  void checkCurrent() {
    if (!session.authenticated ||
        session.binding != _binding ||
        session.info?.can('manage:customers') != true ||
        session.info?.can('view:customers') != true) {
      throw StateError('CUSTOMER_WRITE_SCOPE_CHANGED');
    }
  }

  @override
  Future<void> validateContactIds(List<String> ids) async {
    for (final id in ids) {
      checkCurrent();

      if (!canSelectContacts) {
        throw StateError('CUSTOMER_CONTACT_READ_FORBIDDEN');
      }

      final contact = await session.read(
        ApiQueries.contactsGet,
        models.ContactsGetInput(id: id),
      );
      checkCurrent();

      if (!canSelectContacts || contact.id != id) {
        throw const FormatException('CUSTOMER_CONTACT_RESPONSE_MISMATCH');
      }
    }
  }

  @override
  Future<models.Customer> getCustomer(String id) async {
    checkCurrent();

    final customer = await session.read(
      ApiQueries.customersGet,
      models.CustomersGetInput(id: id),
    );
    checkCurrent();

    if (customer.id != id) {
      throw const FormatException('CUSTOMER_RESPONSE_ID_MISMATCH');
    }

    return customer;
  }

  @override
  Future<List<models.Contact>> getContacts(String id) async {
    checkCurrent();

    if (!canSelectContacts) {
      throw StateError('CUSTOMER_CONTACT_READ_FORBIDDEN');
    }

    final contacts = await session.read(
      ApiQueries.customersContactsList,
      models.CustomersContactsListInput(customerId: id),
    );
    checkCurrent();

    if (!canSelectContacts) {
      throw StateError('CUSTOMER_CONTACT_READ_FORBIDDEN');
    }

    return contacts;
  }

  Future<List<models.Contact>> searchContacts(String query) async {
    checkCurrent();

    if (!canSelectContacts) {
      throw StateError('CUSTOMER_CONTACT_READ_FORBIDDEN');
    }

    final contacts = await session.read(
      ApiQueries.contactsList,
      models.ContactsListInput(search: RpcOptional.value(query)),
    );
    checkCurrent();

    if (!canSelectContacts) {
      throw StateError('CUSTOMER_CONTACT_READ_FORBIDDEN');
    }

    return contacts;
  }

  @override
  Future<String> createCustomer(models.CustomersCreateInput input) async {
    checkCurrent();

    final result = await session.write(ApiMutations.customersCreate, input);
    checkCurrent();

    if (result.id.isEmpty) {
      throw const FormatException('INVALID_CUSTOMER_CREATE_RESULT');
    }

    return result.id;
  }

  @override
  Future<void> updateCustomer(models.CustomersUpdateInput input) async {
    checkCurrent();

    final result = await session.write(ApiMutations.customersUpdate, input);
    checkCurrent();

    if (!result.success) {
      throw const FormatException('INVALID_CUSTOMER_UPDATE_RESULT');
    }
  }

  @override
  Future<void> setContacts(models.CustomersContactsSetInput input) async {
    checkCurrent();

    if (!canSelectContacts) {
      throw StateError('CUSTOMER_CONTACT_WRITE_FORBIDDEN');
    }

    final result = await session.write(ApiMutations.customersContactsSet, input);
    checkCurrent();

    if (!result.success) {
      throw const FormatException('INVALID_CUSTOMER_CONTACT_RESULT');
    }
  }
}
