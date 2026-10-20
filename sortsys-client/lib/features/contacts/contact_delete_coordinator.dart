import 'dart:math';

import '../../api/generated/models.g.dart' as models;
import '../projects/project_write_lock.dart';
import 'contact_delete_receipt.dart';

abstract interface class ContactDeleteAccess {
  String get scope;

  String get contactId;

  void checkCurrent();

  void checkDelete(models.ContactsDeleteInput input);

  Future<models.Contact> getContact(String id);

  Future<models.ContactsDeleteOutput> deleteContact(
    models.ContactsDeleteInput input,
  );
}

enum ContactDeleteFailure { outstanding, conflict, uncertain, cleanup }

final class ContactDeleteException implements Exception {
  const ContactDeleteException(
    this.failure, {
    this.cause,
    this.confirmedContactId,
  });

  final ContactDeleteFailure failure;
  final Object? cause;
  final String? confirmedContactId;
}

final class ContactDeleteCoordinator {
  const ContactDeleteCoordinator({
    required this.access,
    required this.receipts,
  });

  final ContactDeleteAccess access;
  final ContactDeleteReceiptStore receipts;

  void _check(String scope, String contactId) {
    access.checkCurrent();

    if (scope.isEmpty ||
        contactId.isEmpty ||
        access.scope != scope ||
        access.contactId != contactId) {
      throw StateError('CONTACT_DELETE_SCOPE_CHANGED');
    }
  }

  Future<ContactDeleteReceipt?> outstanding() {
    return _outstanding(access.scope, access.contactId);
  }

  Future<ContactDeleteReceipt?> _outstanding(
    String scope,
    String contactId,
  ) async {
    _check(scope, contactId);

    final receipt = await receipts.read(scope);

    _check(scope, contactId);

    if (receipt != null) {
      receipt.encode();

      if (receipt.scope != scope || receipt.input.id != contactId) {
        throw const FormatException('CONTACT_DELETE_RECEIPT_SCOPE_MISMATCH');
      }
    }

    return receipt;
  }

  Future<String> delete({
    required models.Contact baseline,
    required bool confirmed,
  }) {
    final scope = access.scope;
    final contactId = access.contactId;

    _check(scope, contactId);

    if (!confirmed || baseline.id.isEmpty) {
      throw const FormatException('CONTACT_DELETE_CONFIRMATION_REQUIRED');
    }

    if (baseline.id != contactId) {
      throw const FormatException('CONTACT_DELETE_CONTEXT_MISMATCH');
    }

    final snapshot = freezeContactDeleteBaseline(baseline);
    final input = models.ContactsDeleteInput(id: snapshot.id);

    access.checkDelete(input);

    // Use the same target-scoped lock as the existing contact writer.
    return withProjectWriteLock('contacts:$scope', () {
      return _deleteLocked(scope, input, snapshot);
    });
  }

  Future<String> _deleteLocked(
    String scope,
    models.ContactsDeleteInput input,
    models.Contact baseline,
  ) async {
    final contactId = input.id;

    if (await _outstanding(scope, contactId) != null) {
      throw const ContactDeleteException(ContactDeleteFailure.outstanding);
    }

    access.checkDelete(input);

    final fresh = await access.getContact(input.id);

    _check(scope, contactId);
    access.checkDelete(input);

    if (!sameContactDeleteBaseline(fresh, baseline)) {
      throw const ContactDeleteException(ContactDeleteFailure.conflict);
    }

    final receipt = ContactDeleteReceipt(
      scope: scope,
      nonce: _nonce(),
      createdAt: DateTime.now().toUtc(),
      input: input,
      baseline: baseline,
    );

    await _persist(scope, receipt);

    try {
      access.checkDelete(input);

      final started = receipt.started();

      await _persist(scope, started, previous: receipt);
      access.checkDelete(input);

      final result = await access.deleteContact(input);

      _check(scope, contactId);

      final acknowledged = started.confirmed(result);

      await _persist(scope, acknowledged, previous: started);

      return await _finishAcknowledged(scope, acknowledged);
    } catch (error) {
      if (error is ContactDeleteException &&
          error.failure == ContactDeleteFailure.cleanup) {
        rethrow;
      }

      throw ContactDeleteException(
        ContactDeleteFailure.uncertain,
        cause: error,
      );
    }
  }

  Future<void> _persist(
    String scope,
    ContactDeleteReceipt receipt, {
    ContactDeleteReceipt? previous,
  }) async {
    final contactId = receipt.input.id;

    _check(scope, contactId);

    final encoded = receipt.encode();

    final current = await _outstanding(scope, contactId);

    if (receipt.scope != scope ||
        (previous == null && current != null) ||
        (previous != null && current?.encode() != previous.encode())) {
      throw const ContactDeleteException(ContactDeleteFailure.outstanding);
    }

    await receipts.write(receipt);

    _check(scope, contactId);

    final persisted = await _outstanding(scope, contactId);

    if (persisted?.encode() != encoded) {
      throw StateError('CONTACT_DELETE_RECEIPT_NOT_PERSISTED');
    }
  }

  Future<String?> recover({required String expectedNonce}) {
    final scope = access.scope;
    final contactId = access.contactId;

    _check(scope, contactId);

    return withProjectWriteLock('contacts:$scope', () async {
      final receipt = await _outstanding(scope, contactId);

      if (receipt == null) {
        throw StateError('NO_CONTACT_DELETE_RECEIPT');
      }

      if (receipt.nonce != expectedNonce) {
        throw const ContactDeleteException(ContactDeleteFailure.outstanding);
      }

      if (receipt.acknowledged) {
        return _finishAcknowledged(scope, receipt);
      }

      if (receipt.dispatching) {
        throw const ContactDeleteException(ContactDeleteFailure.uncertain);
      }

      // Only an intent that never entered dispatch can be safely discarded.
      final current = await _outstanding(scope, contactId);

      if (current?.encode() != receipt.encode()) {
        throw const ContactDeleteException(ContactDeleteFailure.outstanding);
      }

      await receipts.clear(scope);

      _check(scope, contactId);

      if (await _outstanding(scope, contactId) != null) {
        throw StateError('CONTACT_DELETE_RECEIPT_NOT_CLEARED');
      }

      return null;
    });
  }

  Future<String> _finishAcknowledged(
    String scope,
    ContactDeleteReceipt receipt,
  ) async {
    final contactId = receipt.input.id;

    _check(scope, contactId);

    if (!receipt.acknowledged || receipt.dispatching) {
      throw const ContactDeleteException(ContactDeleteFailure.uncertain);
    }

    final id = receipt.input.id;

    try {
      final current = await _outstanding(scope, contactId);

      if (current?.encode() != receipt.encode()) {
        throw StateError('CONTACT_DELETE_RECEIPT_CHANGED');
      }

      await receipts.clear(scope);

      _check(scope, contactId);

      if (await _outstanding(scope, contactId) != null) {
        throw StateError('CONTACT_DELETE_RECEIPT_NOT_CLEARED');
      }

      return id;
    } catch (error) {
      throw ContactDeleteException(
        ContactDeleteFailure.cleanup,
        cause: error,
        confirmedContactId: id,
      );
    }
  }
}

String _nonce() {
  final random = Random.secure();

  return List.generate(16, (_) {
    return random.nextInt(256).toRadixString(16).padLeft(2, '0');
  }).join();
}
