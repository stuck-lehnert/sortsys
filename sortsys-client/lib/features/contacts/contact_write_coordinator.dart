import 'dart:math';

import '../../api/generated/models.g.dart' as models;
import '../projects/project_write_lock.dart';
import 'contact_draft.dart';
import 'contact_receipt.dart';
import 'contact_write_access.dart';

enum ContactWriteFailure { outstanding, conflict, uncertain, cleanup }

final class ContactWriteException implements Exception {
  const ContactWriteException(
    this.failure, {
    this.cause,
    this.confirmedContact,
  });

  final ContactWriteFailure failure;
  final Object? cause;
  final models.Contact? confirmedContact;
}

final class ContactWriteCoordinator {
  const ContactWriteCoordinator({required this.access, required this.receipts});

  final ContactWriteAccess access;
  final ContactReceiptStore receipts;

  void _check(String scope) {
    access.checkCurrent();

    if (scope.isEmpty || access.scope != scope) {
      throw StateError('CONTACT_WRITE_SCOPE_CHANGED');
    }
  }

  Future<ContactWriteReceipt?> outstanding() {
    return _outstanding(access.scope);
  }

  Future<ContactWriteReceipt?> _outstanding(String scope) async {
    _check(scope);

    final receipt = await receipts.read(scope);
    _check(scope);

    if (receipt != null) {
      receipt.encode();

      if (receipt.scope != scope) {
        throw const FormatException('CONTACT_RECEIPT_SCOPE_MISMATCH');
      }
    }

    return receipt;
  }

  Future<models.Contact> save(
    ContactDraft draft, {
    models.Contact? baseline,
  }) async {
    final scope = access.scope;
    _check(scope);

    final create = draft.contactId == null ? draft.createInput() : null;
    final update = draft.contactId == null ? null : draft.updateInput();

    if ((create != null && baseline != null) ||
        (update != null && (baseline == null || baseline.id != update.id))) {
      throw const FormatException('INVALID_CONTACT_BASELINE');
    }

    _checkWrite(create, update);

    return withProjectWriteLock('contacts:$scope', () {
      return _saveLocked(scope, create, update, baseline);
    });
  }

  void _checkWrite(
    models.ContactsCreateInput? create,
    models.ContactsUpdateInput? update,
  ) {
    if (create != null) {
      access.checkCreate(create);
    } else if (update != null) {
      access.checkUpdate(update);
    } else {
      throw const FormatException('INVALID_CONTACT_WRITE_KIND');
    }
  }

  Future<models.Contact> _saveLocked(
    String scope,
    models.ContactsCreateInput? create,
    models.ContactsUpdateInput? update,
    models.Contact? baseline,
  ) async {
    if (await _outstanding(scope) != null) {
      throw const ContactWriteException(ContactWriteFailure.outstanding);
    }

    _checkWrite(create, update);

    if (update != null) {
      final fresh = await access.getContact(update.id);
      _check(scope);
      access.checkUpdate(update);

      if (fresh == null ||
          baseline == null ||
          !sameContactSnapshot(fresh, baseline)) {
        throw const ContactWriteException(ContactWriteFailure.conflict);
      }

      if (contactUpdateMatches(update, fresh)) {
        return fresh;
      }
    }

    final receipt = ContactWriteReceipt(
      scope: scope,
      nonce: _operationNonce(),
      createdAt: DateTime.now().toUtc(),
      createInput: create,
      updateInput: update,
      baseline: baseline,
    );
    await _persist(scope, receipt);

    try {
      _checkWrite(create, update);

      final started = receipt.started();
      await _persist(scope, started);
      _checkWrite(create, update);

      final ContactWriteReceipt confirmed;

      if (create != null) {
        final result = await access.createContact(create);
        _check(scope);
        confirmed = started.confirmedCreate(result);
      } else {
        final result = await access.updateContact(update!);
        _check(scope);
        confirmed = started.confirmedUpdate(result);
      }

      await _persist(scope, confirmed);

      return await _verifyAndClear(scope, confirmed);
    } catch (error) {
      if (error is ContactWriteException &&
          error.failure == ContactWriteFailure.cleanup) {
        rethrow;
      }

      throw ContactWriteException(ContactWriteFailure.uncertain, cause: error);
    }
  }

  Future<void> _persist(String scope, ContactWriteReceipt receipt) async {
    _check(scope);
    receipt.encode();

    if (receipt.scope != scope) {
      throw const FormatException('CONTACT_RECEIPT_SCOPE_MISMATCH');
    }

    await receipts.write(receipt);
    _check(scope);
  }

  Future<models.Contact?> recover({required String expectedNonce}) async {
    final scope = access.scope;
    _check(scope);

    return withProjectWriteLock('contacts:$scope', () async {
      final receipt = await _outstanding(scope);

      if (receipt == null) {
        throw StateError('NO_CONTACT_RECEIPT');
      }

      if (receipt.nonce != expectedNonce) {
        throw const ContactWriteException(ContactWriteFailure.outstanding);
      }

      try {
        if (!receipt.dispatching && !receipt.acknowledged) {
          await receipts.clear(scope);
          _check(scope);

          return null;
        }

        return await _verifyAndClear(scope, receipt);
      } catch (error) {
        if (error is ContactWriteException &&
            error.failure == ContactWriteFailure.cleanup) {
          rethrow;
        }

        throw ContactWriteException(
          ContactWriteFailure.uncertain,
          cause: error,
        );
      }
    });
  }

  Future<models.Contact> _verifyAndClear(
    String scope,
    ContactWriteReceipt receipt,
  ) async {
    final id = receipt.creation?.id ?? receipt.updateInput?.id;

    if (id == null || id.isEmpty) {
      throw StateError('UNCONFIRMED_CONTACT_CREATION');
    }

    _check(scope);

    final contact = await access.getContact(id);
    _check(scope);

    if (contact == null || !receipt.confirms(contact)) {
      throw StateError('CONTACT_WRITE_NOT_CONFIRMED');
    }

    // Known success must not invite a second mutation after cleanup fails.
    try {
      await receipts.clear(scope);
    } catch (error) {
      _check(scope);

      throw ContactWriteException(
        ContactWriteFailure.cleanup,
        cause: error,
        confirmedContact: contact,
      );
    }

    _check(scope);

    return contact;
  }
}

String _operationNonce() {
  final random = Random.secure();
  final bytes = List<int>.generate(16, (index) {
    return random.nextInt(256);
  });

  return bytes.map((value) {
    return value.toRadixString(16).padLeft(2, '0');
  }).join();
}
