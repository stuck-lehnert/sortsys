import 'dart:math';

import '../../api/generated/models.g.dart' as models;
import '../projects/project_write_lock.dart';
import 'absence_receipt.dart';
import 'planning_draft.dart';

abstract interface class AbsenceWriteAccess {
  String get scope;

  void checkCurrent();

  void checkCreate(models.UsersVacationsCreateInput input);

  Future<models.UsersVacationsCreateResult> createAbsence(
    models.UsersVacationsCreateInput input,
  );

  Future<models.UsersVacationsListResultItem?> getAbsence(
    String id,
    models.UsersVacationsCreateInput target,
  );
}

enum AbsenceWriteFailure { outstanding, uncertain }

final class AbsenceWriteException implements Exception {
  const AbsenceWriteException(this.failure, {this.cause});

  final AbsenceWriteFailure failure;
  final Object? cause;
}

final class AbsenceWriteCoordinator {
  const AbsenceWriteCoordinator({required this.access, required this.receipts});

  final AbsenceWriteAccess access;
  final AbsenceReceiptStore receipts;

  Future<AbsenceWriteReceipt?> outstanding() async {
    access.checkCurrent();

    final receipt = await receipts.read(access.scope);
    access.checkCurrent();

    if (receipt != null) {
      receipt.encode();

      if (receipt.scope != access.scope) {
        throw const FormatException('ABSENCE_RECEIPT_SCOPE_MISMATCH');
      }
    }

    return receipt;
  }

  Future<models.UsersVacationsListResultItem> save(AbsenceDraft draft) async {
    access.checkCurrent();

    final input = absenceWriteInput(draft);

    access.checkCreate(input);

    return withProjectWriteLock('absences:${access.scope}', () {
      return _saveLocked(input);
    });
  }

  Future<models.UsersVacationsListResultItem> _saveLocked(
    models.UsersVacationsCreateInput input,
  ) async {
    final pending = await outstanding();

    if (pending != null) {
      throw const AbsenceWriteException(AbsenceWriteFailure.outstanding);
    }

    access.checkCreate(input);

    final receipt = AbsenceWriteReceipt(
      scope: access.scope,
      nonce: _operationNonce(),
      createdAt: DateTime.now().toUtc(),
      input: input,
    );

    await _persist(receipt);

    try {
      access.checkCreate(input);

      final started = receipt.started();

      await _persist(started);

      final acknowledgement = await access.createAbsence(input);

      access.checkCurrent();

      final confirmed = started.confirmed(acknowledgement);

      await _persist(confirmed);

      final record = await _verifyAndClear(confirmed);

      return record;
    } catch (error) {
      throw AbsenceWriteException(AbsenceWriteFailure.uncertain, cause: error);
    }
  }

  Future<void> _persist(AbsenceWriteReceipt receipt) async {
    access.checkCurrent();
    receipt.encode();

    await receipts.write(receipt);
    access.checkCurrent();
  }

  Future<models.UsersVacationsListResultItem?> recover({
    String? expectedNonce,
  }) async {
    access.checkCurrent();

    return withProjectWriteLock('absences:${access.scope}', () async {
      final receipt = await outstanding();

      if (receipt == null) {
        throw StateError('NO_ABSENCE_WRITE_RECEIPT');
      }

      if (expectedNonce != null && receipt.nonce != expectedNonce) {
        throw const AbsenceWriteException(AbsenceWriteFailure.outstanding);
      }

      try {
        if (receipt.acknowledgement != null) {
          return await _verifyAndClear(receipt);
        }

        if (receipt.dispatching) {
          throw StateError('UNCONFIRMED_ABSENCE_CREATION');
        }

        // The durable pre-dispatch stage proves no mutation was submitted.
        await receipts.clear(access.scope);
        access.checkCurrent();

        return null;
      } catch (error) {
        throw AbsenceWriteException(
          AbsenceWriteFailure.uncertain,
          cause: error,
        );
      }
    });
  }

  Future<models.UsersVacationsListResultItem> _verifyAndClear(
    AbsenceWriteReceipt receipt,
  ) async {
    final acknowledgement = receipt.acknowledgement;

    if (acknowledgement == null) {
      throw StateError('UNCONFIRMED_ABSENCE_CREATION');
    }

    access.checkCurrent();

    final record = await access.getAbsence(acknowledgement.id, receipt.input);
    access.checkCurrent();

    if (record == null ||
        record.id != acknowledgement.id ||
        !absenceMatchesInput(record, receipt.input)) {
      throw StateError('ABSENCE_WRITE_NOT_CONFIRMED');
    }

    await receipts.clear(access.scope);
    access.checkCurrent();

    return record;
  }
}

String _operationNonce() {
  final random = Random.secure();

  final bytes = List<int>.generate(16, (_) {
    return random.nextInt(256);
  });
  final nonce = bytes.map((value) {
    return value.toRadixString(16).padLeft(2, '0');
  }).join();

  return nonce;
}
