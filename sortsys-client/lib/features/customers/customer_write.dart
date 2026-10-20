import 'dart:convert';
import 'dart:math';

import '../../api/generated/models.g.dart' as models;
import '../../api/model.dart';
import '../projects/project_write_lock.dart';
import 'customer_draft.dart';

abstract interface class CustomerWriteAccess {
  String get scope;

  bool get canSelectContacts;

  void checkCurrent();

  Future<void> validateContactIds(List<String> ids);

  Future<models.Customer> getCustomer(String id);

  Future<List<models.Contact>> getContacts(String id);

  Future<String> createCustomer(models.CustomersCreateInput input);

  Future<void> updateCustomer(models.CustomersUpdateInput input);

  Future<void> setContacts(models.CustomersContactsSetInput input);
}

final class CustomerEditorSeed {
  const CustomerEditorSeed._({required this.customer, required this.contacts});

  final models.Customer? customer;
  final List<models.Contact>? contacts;
}

enum CustomerWriteStage { basePending, contactsPending }

enum CustomerWriteFailure { outstanding, conflict, uncertain, cleanup }

final class CustomerWriteException implements Exception {
  const CustomerWriteException(
    this.failure, {
    this.cause,
    this.confirmedCustomerId,
  });

  final CustomerWriteFailure failure;
  final Object? cause;
  final String? confirmedCustomerId;
}

final class CustomerWriteReceipt {
  const CustomerWriteReceipt({
    required this.scope,
    required this.nonce,
    required this.stage,
    required this.target,
    this.createInput,
    this.updateInput,
    this.customerId,
    this.contactIds,
    this.baselineContactIds,
  });

  final String scope;
  final String nonce;
  final CustomerWriteStage stage;
  final models.CustomersCreateInput target;
  final models.CustomersCreateInput? createInput;
  final models.CustomersUpdateInput? updateInput;
  final String? customerId;
  final List<String>? contactIds;
  final List<String>? baselineContactIds;

  CustomerWriteReceipt advance(CustomerWriteStage next, String id) {
    return CustomerWriteReceipt(
      scope: scope,
      nonce: nonce,
      stage: next,
      target: target,
      createInput: createInput,
      updateInput: updateInput,
      customerId: id,
      contactIds: contactIds,
      baselineContactIds: baselineContactIds,
    );
  }

  String encode() {
    final encoded = jsonEncode({
      'version': 1,
      'scope': scope,
      'nonce': nonce,
      'stage': stage.name,
      'target': target.toWire(),
      'createInput': createInput?.toWire(),
      'updateInput': updateInput?.toWire(),
      'customerId': customerId,
      'contactIds': contactIds,
      'baselineContactIds': baselineContactIds,
    });

    if (utf8.encode(encoded).length > 131072) {
      throw const FormatException('CUSTOMER_RECEIPT_TOO_LARGE');
    }

    return encoded;
  }

  factory CustomerWriteReceipt.decode(String encoded) {
    if (utf8.encode(encoded).length > 131072) {
      throw const FormatException('CUSTOMER_RECEIPT_TOO_LARGE');
    }

    final data = readRpcObject(jsonDecode(encoded), const {
      'version', 'scope', 'nonce', 'stage', 'target', 'createInput',
      'updateInput', 'customerId', 'contactIds', 'baselineContactIds',
    });
    readRpcLiteral(data['version'], 1);

    final scope = readRpcString(data['scope']);
    final nonce = readRpcString(data['nonce']);
    final stage = CustomerWriteStage.values.byName(readRpcString(data['stage']));
    final id = readRpcNullable(data['customerId'], readRpcString);
    final contacts = readRpcNullable(
      data['contactIds'], rpcArray(rpcString).decode,
    );
    final baseline = readRpcNullable(
      data['baselineContactIds'], rpcArray(rpcString).decode,
    );
    final create = readRpcNullable(
      data['createInput'], models.CustomersCreateInput.fromWire,
    );
    final update = readRpcNullable(
      data['updateInput'], models.CustomersUpdateInput.fromWire,
    );

    if (scope.isEmpty || nonce.isEmpty || id == '' ||
        (create != null && update != null) ||
        (create == null && id == null) ||
        (contacts != null && baseline == null) ||
        (stage == CustomerWriteStage.contactsPending &&
            (contacts == null || id == null)) ||
        (update != null && update.id != id)) {
      throw const FormatException('INVALID_CUSTOMER_RECEIPT');
    }

    return CustomerWriteReceipt(
      scope: scope,
      nonce: nonce,
      stage: stage,
      target: models.CustomersCreateInput.fromWire(data['target']),
      createInput: create,
      updateInput: update,
      customerId: id,
      contactIds: contacts == null ? null : List.unmodifiable(contacts),
      baselineContactIds: baseline == null ? null : List.unmodifiable(baseline),
    );
  }
}

abstract interface class CustomerReceiptStore {
  Future<CustomerWriteReceipt?> read(String scope);

  Future<void> write(CustomerWriteReceipt receipt);

  Future<void> clear(String scope);
}

typedef CustomerWriteLock = Future<String> Function(
  String scope, Future<String> Function() operation,
);

final class CustomerWriteCoordinator {
  CustomerWriteCoordinator({
    required this.access,
    required this.receipts,
    CustomerWriteLock? lock,
  }) : lock = lock ?? withProjectWriteLock<String>;

  final CustomerWriteAccess access;
  final CustomerReceiptStore receipts;
  final CustomerWriteLock lock;
  CustomerEditorSeed? _seed;

  Future<CustomerEditorSeed> load(String? id) async {
    access.checkCurrent();

    final customer = id == null ? null : await access.getCustomer(id);
    List<models.Contact>? contacts;

    if (access.canSelectContacts) {
      contacts = id == null ? <models.Contact>[] : await access.getContacts(id);
      access.checkCurrent();

      if (!access.canSelectContacts) {
        throw StateError('CUSTOMER_CONTACT_READ_FORBIDDEN');
      }
    }

    access.checkCurrent();

    if (customer != null && customer.id != id) {
      throw const FormatException('CUSTOMER_RESPONSE_ID_MISMATCH');
    }

    final seed = CustomerEditorSeed._(
      customer: customer,
      contacts: contacts == null ? null : List.unmodifiable(contacts),
    );
    _seed = seed;

    return seed;
  }

  Future<CustomerWriteReceipt?> outstanding() async {
    access.checkCurrent();

    final receipt = await receipts.read(access.scope);
    access.checkCurrent();

    if (receipt != null && receipt.scope != access.scope) {
      throw const FormatException('CUSTOMER_RECEIPT_SCOPE_MISMATCH');
    }

    return receipt;
  }

  Future<String> save(CustomerDraft draft) async {
    draft.validate();
    access.checkCurrent();

    final seed = _seed;

    if (seed == null) {
      throw StateError('CUSTOMER_EDITOR_NOT_LOADED');
    }

    final baseline = seed.customer;
    final baselineContactIds = seed.contacts?.map((contact) {
      return contact.id;
    }).toList();

    return lock('customer:${access.scope}', () async {
      if (await outstanding() != null) {
        throw const CustomerWriteException(CustomerWriteFailure.outstanding);
      }

      models.CustomersUpdateInput? update;
      final selected = draft.contactIds;
      final previous = baseline == null ? <String>[] : baselineContactIds;

      if (baseline != null) {
        final fresh = await access.getCustomer(baseline.id);
        access.checkCurrent();

        if (fresh.id != baseline.id ||
            customerBaselineKey(fresh) != customerBaselineKey(baseline)) {
          throw const CustomerWriteException(CustomerWriteFailure.conflict);
        }

        update = draft.updateInput(baseline);
      }

      if (selected != null &&
          (seed.contacts == null || !access.canSelectContacts)) {
        throw StateError('CUSTOMER_CONTACT_BASELINE_REQUIRED');
      }

      if (selected == null && seed.contacts != null) {
        throw StateError('CUSTOMER_CONTACT_SELECTION_MISSING');
      }

      final contactsChanged = selected != null &&
          !customerContactIdsEqual(selected, previous!);

      if (contactsChanged) {
        await access.validateContactIds(selected);
        access.checkCurrent();

        if (!access.canSelectContacts) {
          throw StateError('CUSTOMER_CONTACT_WRITE_FORBIDDEN');
        }

        if (baseline != null) {
          await _checkContacts(baseline.id, previous);
        }
      }

      final baseChanged = baseline == null || update!.data.toWire().isNotEmpty;

      if (!baseChanged && !contactsChanged) {
        return baseline.id;
      }

      final random = Random.secure();
      final nonce = List.generate(16, (_) {
        return random.nextInt(256).toRadixString(16).padLeft(2, '0');
      }).join();
      var receipt = CustomerWriteReceipt(
        scope: access.scope,
        nonce: nonce,
        stage: CustomerWriteStage.basePending,
        target: draft.createInput(),
        createInput: baseline == null ? draft.createInput() : null,
        updateInput: baseChanged ? update : null,
        customerId: baseline?.id,
        contactIds: contactsChanged ? selected : null,
        baselineContactIds: contactsChanged ? previous : null,
      );

      // A failed durable intent write prevents dispatch.
      await receipts.write(receipt);

      try {
        access.checkCurrent();
        var id = baseline?.id;

        if (baseChanged) {
          if (baseline == null) {
            id = await access.createCustomer(receipt.createInput!);
          } else {
            await access.updateCustomer(receipt.updateInput!);
          }

          access.checkCurrent();

          if (id == null || id.isEmpty) {
            throw const FormatException('INVALID_CUSTOMER_WRITE_RESULT');
          }

          // Store the acknowledged ID before any follow-up read or mutation.
          receipt = receipt.advance(CustomerWriteStage.basePending, id);
          await receipts.write(receipt);
        }

        await _verifyBase(receipt);

        if (receipt.contactIds != null) {
          await _checkContacts(id!, receipt.baselineContactIds!);
          receipt = receipt.advance(CustomerWriteStage.contactsPending, id);
          await receipts.write(receipt);
          access.checkCurrent();

          await access.setContacts(
            models.CustomersContactsSetInput(
              customerId: id,
              contactIds: receipt.contactIds!,
            ),
          );
          access.checkCurrent();
          await _verifyContacts(receipt);
        }

        await _clearConfirmed(id!);

        return id;
      } catch (error) {
        if (error is CustomerWriteException &&
            error.failure == CustomerWriteFailure.cleanup) {
          rethrow;
        }

        throw CustomerWriteException(
          CustomerWriteFailure.uncertain, cause: error,
        );
      }
    });
  }

  Future<void> _checkContacts(String id, List<String> baseline) async {
    final fresh = await access.getContacts(id);
    access.checkCurrent();

    if (!customerContactIdsEqual(fresh.map((contact) => contact.id), baseline)) {
      throw const CustomerWriteException(CustomerWriteFailure.conflict);
    }
  }

  Future<void> _verifyBase(CustomerWriteReceipt receipt) async {
    final id = receipt.customerId;

    if (id == null) {
      throw const CustomerWriteException(CustomerWriteFailure.uncertain);
    }

    final row = await access.getCustomer(id);
    access.checkCurrent();

    if (row.id != id || !customerMatchesTarget(row, receipt.target)) {
      throw StateError('CUSTOMER_WRITE_NOT_CONFIRMED');
    }
  }

  Future<void> _verifyContacts(CustomerWriteReceipt receipt) async {
    final contacts = await access.getContacts(receipt.customerId!);
    access.checkCurrent();

    if (!customerContactIdsEqual(
      contacts.map((contact) => contact.id), receipt.contactIds!,
    )) {
      throw StateError('CUSTOMER_CONTACT_WRITE_NOT_CONFIRMED');
    }
  }

  Future<void> _clearConfirmed(String id) async {
    access.checkCurrent();

    try {
      await receipts.clear(access.scope);

      access.checkCurrent();
    } catch (error) {
      throw CustomerWriteException(
        CustomerWriteFailure.cleanup,
        cause: error,
        confirmedCustomerId: id,
      );
    }
  }

  Future<String> recover(CustomerWriteReceipt reviewed) {
    access.checkCurrent();

    return lock('customer:${access.scope}', () async {
      final current = await outstanding();

      if (current == null ||
          current.nonce != reviewed.nonce ||
          current.encode() != reviewed.encode()) {
        throw StateError('CUSTOMER_RECEIPT_CHANGED');
      }

      try {
        // Recovery only reads known IDs. It never dispatches a mutation.
        await _verifyBase(current);

        if (current.contactIds != null) {
          await _verifyContacts(current);
        }

        await _clearConfirmed(current.customerId!);

        return current.customerId!;
      } catch (error) {
        if (error is CustomerWriteException &&
            error.failure == CustomerWriteFailure.cleanup) {
          rethrow;
        }

        throw CustomerWriteException(
          CustomerWriteFailure.uncertain, cause: error,
        );
      }
    });
  }
}
