import 'dart:math';

import '../../api/generated/models.g.dart' as models;
import '../projects/project_write_lock.dart';
import 'tool_draft.dart';
import 'tool_receipt.dart';
import 'tool_write_access.dart';
import 'tool_write_inputs.dart';

enum ToolWriteFailure { outstanding, conflict, uncertain, cleanup }

final class ToolWriteException implements Exception {
  const ToolWriteException(this.failure, {this.cause, this.confirmedTool});

  final ToolWriteFailure failure;
  final Object? cause;
  final models.Tool? confirmedTool;
}

final class ToolWriteCoordinator {
  const ToolWriteCoordinator({required this.access, required this.receipts});

  final ToolWriteAccess access;
  final ToolReceiptStore receipts;

  _ToolWriteOwner _capture() {
    final owner = _ToolWriteOwner(access.scope, access.toolId);

    _check(owner);

    return owner;
  }

  void _check(_ToolWriteOwner owner) {
    access.checkCurrent();

    final target = owner.toolId;

    if (owner.scope.isEmpty ||
        !isToolScalarText(owner.scope) ||
        (target != null && (target.isEmpty || !isToolScalarText(target))) ||
        access.scope != owner.scope ||
        access.toolId != target) {
      throw StateError('TOOL_WRITE_SCOPE_CHANGED');
    }
  }

  void _checkWrite(
    _ToolWriteOwner owner,
    models.ToolsCreateInput? create,
    models.ToolsUpdateInput? update,
  ) {
    _check(owner);

    if (create != null && owner.toolId == null) {
      access.checkCreate(create);
    } else if (update != null && update.id == owner.toolId) {
      access.checkUpdate(update);
    } else {
      throw const FormatException('INVALID_TOOL_WRITE_CONTEXT');
    }

    _check(owner);
  }

  Future<ToolWriteReceipt?> outstanding() {
    return _outstanding(_capture());
  }

  Future<ToolWriteReceipt?> _outstanding(_ToolWriteOwner owner) async {
    _check(owner);

    final receipt = await receipts.read(owner.scope);

    _check(owner);

    if (receipt != null) {
      receipt.encode();

      final target = owner.toolId;
      final wrongMode = target == null
          ? receipt.createInput == null
          : receipt.updateInput?.id != target;

      if (receipt.scope != owner.scope || wrongMode) {
        throw const FormatException('TOOL_RECEIPT_SCOPE_MISMATCH');
      }
    }

    return receipt;
  }

  Future<models.Tool> save(ToolDraft draft, {models.Tool? baseline}) {
    final owner = _capture();
    final create = draft.isEditing
        ? null
        : copyToolCreateInput(draft.createInput());
    final update = draft.isEditing
        ? copyToolUpdateInput(draft.updateInput())
        : null;

    if (draft.toolId != owner.toolId ||
        (create != null && baseline != null) ||
        (update != null && (baseline == null || baseline.id != update.id))) {
      throw const FormatException('INVALID_TOOL_BASELINE');
    }

    final snapshot = baseline == null
        ? null
        : freezeToolWriteBaseline(baseline);

    _checkWrite(owner, create, update);

    return withProjectWriteLock('tools:${owner.scope}', () {
      return _saveLocked(owner, create, update, snapshot);
    });
  }

  Future<models.Tool> _saveLocked(
    _ToolWriteOwner owner,
    models.ToolsCreateInput? create,
    models.ToolsUpdateInput? update,
    models.Tool? baseline,
  ) async {
    if (await _outstanding(owner) != null) {
      throw const ToolWriteException(ToolWriteFailure.outstanding);
    }

    _checkWrite(owner, create, update);

    if (update != null) {
      final fresh = await access.getTool(update.id);

      _check(owner);
      _checkWrite(owner, create, update);

      if (fresh == null ||
          baseline == null ||
          !sameToolSnapshot(fresh, baseline)) {
        throw const ToolWriteException(ToolWriteFailure.conflict);
      }
    }

    // Unchanged numeric daily cost still fills waiting tracking-row defaults.
    final receipt = ToolWriteReceipt(
      scope: owner.scope,
      nonce: _nonce(),
      createdAt: DateTime.now().toUtc(),
      createInput: create,
      updateInput: update,
      baseline: baseline,
    );

    await _persist(owner, receipt);

    try {
      _checkWrite(owner, create, update);

      final started = receipt.started();

      await _persist(owner, started, previous: receipt);

      _checkWrite(owner, create, update);

      final ToolWriteReceipt acknowledged;

      if (create != null) {
        final result = await access.createTool(create);

        _check(owner);
        acknowledged = started.confirmedCreate(result);
      } else {
        final result = await access.updateTool(update!);

        _check(owner);
        acknowledged = started.confirmedUpdate(result);
      }

      await _persist(owner, acknowledged, previous: started);

      return await _verifyAndClear(owner, acknowledged);
    } catch (error) {
      if (error is ToolWriteException) {
        rethrow;
      }

      throw ToolWriteException(ToolWriteFailure.uncertain, cause: error);
    }
  }

  Future<void> _persist(
    _ToolWriteOwner owner,
    ToolWriteReceipt receipt, {
    ToolWriteReceipt? previous,
  }) async {
    _check(owner);

    final encoded = receipt.encode();

    final current = await _outstanding(owner);

    if (receipt.scope != owner.scope ||
        (previous == null && current != null) ||
        (previous != null && current?.encode() != previous.encode())) {
      throw const ToolWriteException(ToolWriteFailure.outstanding);
    }

    if (!receipt.acknowledged) {
      _checkWrite(owner, receipt.createInput, receipt.updateInput);
    }

    await receipts.write(receipt);

    _check(owner);

    final persisted = await _outstanding(owner);

    if (persisted?.encode() != encoded) {
      throw StateError('TOOL_RECEIPT_NOT_PERSISTED');
    }
  }

  Future<models.Tool?> recover({required String expectedNonce}) {
    final owner = _capture();

    return withProjectWriteLock('tools:${owner.scope}', () async {
      final receipt = await _outstanding(owner);

      if (receipt == null) {
        throw StateError('NO_TOOL_RECEIPT');
      }

      if (receipt.nonce != expectedNonce) {
        throw const ToolWriteException(ToolWriteFailure.outstanding);
      }

      if (receipt.acknowledged) {
        return _verifyAndClear(owner, receipt);
      }

      if (receipt.dispatching) {
        // A matching Tool cannot prove the separate tracking write completed.
        throw const ToolWriteException(ToolWriteFailure.uncertain);
      }

      final current = await _outstanding(owner);

      if (current?.encode() != receipt.encode()) {
        throw const ToolWriteException(ToolWriteFailure.outstanding);
      }

      await receipts.clear(owner.scope);

      _check(owner);

      if (await _outstanding(owner) != null) {
        throw StateError('TOOL_RECEIPT_NOT_CLEARED');
      }

      return null;
    });
  }

  Future<models.Tool> _verifyAndClear(
    _ToolWriteOwner owner,
    ToolWriteReceipt receipt,
  ) async {
    _check(owner);

    if (!receipt.acknowledged || receipt.dispatching) {
      throw const ToolWriteException(ToolWriteFailure.uncertain);
    }

    final id = receipt.creation?.id ?? receipt.updateInput?.id;

    if (id == null || id.isEmpty) {
      throw StateError('UNCONFIRMED_TOOL_WRITE');
    }

    final models.Tool verified;

    try {
      final tool = await access.getTool(id);

      _check(owner);

      if (tool == null || !receipt.confirms(tool)) {
        throw StateError('TOOL_WRITE_NOT_CONFIRMED');
      }

      verified = freezeToolWriteBaseline(tool);
    } catch (error) {
      _check(owner);

      throw ToolWriteException(ToolWriteFailure.uncertain, cause: error);
    }

    try {
      final current = await _outstanding(owner);

      if (current?.encode() != receipt.encode()) {
        throw StateError('TOOL_RECEIPT_CHANGED');
      }

      await receipts.clear(owner.scope);

      _check(owner);

      if (await _outstanding(owner) != null) {
        throw StateError('TOOL_RECEIPT_NOT_CLEARED');
      }

      return verified;
    } catch (error) {
      _check(owner);

      throw ToolWriteException(
        ToolWriteFailure.cleanup,
        cause: error,
        confirmedTool: verified,
      );
    }
  }
}

final class _ToolWriteOwner {
  const _ToolWriteOwner(this.scope, this.toolId);

  final String scope;
  final String? toolId;
}

String _nonce() {
  final random = Random.secure();

  return List.generate(16, (_) {
    return random.nextInt(256).toRadixString(16).padLeft(2, '0');
  }).join();
}
