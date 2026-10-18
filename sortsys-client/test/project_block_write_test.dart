import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/contract.dart' show jsonMap;
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/api/model.dart';
import 'package:sortsys_client/api/wire.dart';
import 'package:sortsys_client/features/planning/planning_draft.dart';
import 'package:sortsys_client/features/planning/project_block_receipt.dart';
import 'package:sortsys_client/features/planning/project_block_write_coordinator.dart';
import 'package:sortsys_client/features/planning/project_block_write_input.dart';

final _day = DateTime.utc(2026, 10, 12);
const _nonce = '0123456789abcdef0123456789abcdef';
const _otherNonce = 'abcdef0123456789abcdef0123456789';

void main() {
  test('strict nine-key receipts preserve canonical fields and stages', () {
    final receipt = _prepared(ProjectBlockWriteKind.update);
    final decoded = ProjectBlockReceipt.decode(receipt.encode());
    final target = projectBlockTargetDraft(
      decoded.baseline,
      decoded.updateInput,
    );

    expect(decoded.encode(), receipt.encode());
    expect(target.projectId, 'other-project');
    expect(target.from, DateTime.utc(2026, 10, 15));
    expect(target.to, DateTime.utc(2026, 10, 16));
    expect(target.note, '');
    expect(receipt.confirmed, throwsStateError);
    expect(receipt.started().started, throwsStateError);
    expect(receipt.started().confirmed().acknowledged, isTrue);

    final data = jsonMap(
      deserializeWire(jsonMap(jsonDecode(receipt.encode()))),
    );

    for (final key in data.keys) {
      final missing = Map<String, Object?>.from(data)..remove(key);
      expect(() {
        ProjectBlockReceipt.decode(jsonEncode(serializeWire(missing)));
      }, throwsFormatException);
    }

    final extra = Map<String, Object?>.from(data)..['unexpected'] = true;
    expect(() {
      ProjectBlockReceipt.decode(jsonEncode(serializeWire(extra)));
    }, throwsFormatException);

    for (final invalid in [
      const models.ProjectsUnavailabilityUpdateRequestData(),
      const models.ProjectsUnavailabilityUpdateRequestData(
        reason: RpcOptional.undefined(),
      ),
      const models.ProjectsUnavailabilityUpdateRequestData(
        projectId: RpcOptional.value(null),
      ),
    ]) {
      final bad = _prepared(
        ProjectBlockWriteKind.update,
        input: models.ProjectsUnavailabilityUpdateInput(
          id: 'block',
          data: invalid,
        ),
      );
      expect(bad.encode, throwsFormatException);
    }

    final missingInput = Map<String, Object?>.from(data)..['input'] = null;
    expect(() {
      ProjectBlockReceipt.decode(jsonEncode(serializeWire(missingInput)));
    }, throwsFormatException);
    expect(_prepared(ProjectBlockWriteKind.delete).encode, returnsNormally);
    expect(
      _prepared(
        ProjectBlockWriteKind.delete,
        scope: List.filled(131073, 'x').join(),
      ).encode,
      throwsFormatException,
    );
  });

  test('update journals one call and verifies the moved known ID', () async {
    final fixture = _Fixture();
    final result = await fixture.coordinator.save(_changed(), _row());

    expect(result.outcome, ProjectBlockWriteOutcome.verified);
    expect(result.record!.projectId, 'other-project');
    expect(result.record!.from, DateTime.utc(2026, 10, 15));
    expect(result.record!.to, DateTime.utc(2026, 10, 16));
    expect(result.record!.note, isNull);
    expect(fixture.access.updates, 1);
    expect(fixture.access.deletes, 0);
    expect(fixture.access.windows.last.from, DateTime.utc(2026, 10, 15));
    expect(fixture.access.windows.last.to, DateTime.utc(2026, 10, 16));
    expect(fixture.store.pending, isNull);
    expect(fixture.events, [
      'read',
      'record',
      'write:false:false',
      'write:true:false',
      'update',
      'write:false:true',
      'record',
      'clear',
    ]);
  });

  test('update acknowledgement cannot confirm a missing bounded row', () async {
    final fixture = _Fixture();
    fixture.access.dropUpdatedRow = true;

    await expectLater(
      fixture.coordinator.save(_changed(), _row()),
      _failure(ProjectBlockWriteFailure.uncertain),
    );
    final receipt = fixture.store.pending!;

    expect(receipt.acknowledged, isTrue);
    expect(fixture.access.updates, 1);
    await expectLater(
      fixture.coordinator.recover(expectedNonce: receipt.nonce),
      _failure(ProjectBlockWriteFailure.uncertain),
    );
    expect(fixture.store.pending, isNotNull);
    expect(fixture.access.updates, 1);

    fixture.access.row = _targetRow(_row(), receipt.updateInput);
    final result = await fixture.coordinator.recover(
      expectedNonce: receipt.nonce,
    );

    expect(result.outcome, ProjectBlockWriteOutcome.verified);
    expect(fixture.access.updates, 1);
    expect(fixture.store.pending, isNull);
  });

  test(
    'lost update acknowledgement recovers known ID without replay',
    () async {
      final fixture = _Fixture();
      fixture.access.loseUpdateAck = true;

      await expectLater(
        fixture.coordinator.save(_changed(), _row()),
        _failure(ProjectBlockWriteFailure.uncertain),
      );
      final receipt = fixture.store.pending!;

      expect(receipt.dispatching, isTrue);
      expect(receipt.acknowledged, isFalse);
      final result = await fixture.coordinator.recover(
        expectedNonce: receipt.nonce,
      );

      expect(result.outcome, ProjectBlockWriteOutcome.verified);
      expect(fixture.access.updates, 1);
      expect(fixture.access.windows.last.from, DateTime.utc(2026, 10, 15));
      expect(fixture.store.pending, isNull);
    },
  );

  test(
    'fresh no-op skips journaling; missing/changed baselines conflict',
    () async {
      final fixture = _Fixture();
      final result = await fixture.coordinator.save(_unchanged(), _row());

      expect(result.outcome, ProjectBlockWriteOutcome.unchanged);
      expect(result.record, same(fixture.access.row));
      expect(fixture.store.writes, 0);
      expect(fixture.access.updates, 0);

      for (final stale in [
        _Fixture(missing: true),
        _Fixture(row: _row(note: 'Changed')),
      ]) {
        await expectLater(
          stale.coordinator.save(_changed(), _row()),
          _failure(ProjectBlockWriteFailure.conflict),
        );
        await expectLater(
          stale.coordinator.remove(_row()),
          _failure(ProjectBlockWriteFailure.conflict),
        );
        expect(stale.store.writes, 0);
        expect(stale.access.updates, 0);
        expect(stale.access.deletes, 0);
      }

    },
  );

  test(
    'unreadable journals and initial storage failure prevent dispatch',
    () async {
      final unreadable = _Fixture();
      unreadable.store.failRead = true;
      await expectLater(
        unreadable.coordinator.save(_changed(), _row()),
        throwsStateError,
      );
      expect(unreadable.access.reads, 0);
      expect(unreadable.access.updates, 0);

      for (final kind in ProjectBlockWriteKind.values) {
        final fixture = _Fixture();
        fixture.store.failWrites.add(1);
        await expectLater(_run(fixture, kind), throwsStateError);
        expect(fixture.store.pending, isNull);
        expect(fixture.access.updates + fixture.access.deletes, 0);
      }

    },
  );

  test(
    'permissions are rechecked after prepared and dispatch-stage storage',
    () async {
      for (final kind in ProjectBlockWriteKind.values) {
        for (final stage in [1, 2]) {
          final fixture = _Fixture();
          fixture.store.afterWrite = (_, count) {
            if (count == stage) {
              if (kind == ProjectBlockWriteKind.update) {
                fixture.access.allowUpdate = false;
              } else {
                fixture.access.allowDelete = false;
              }

            }

          };

          await expectLater(
            _run(fixture, kind),
            _failure(ProjectBlockWriteFailure.uncertain),
          );
          final receipt = fixture.store.pending!;
          expect(receipt.dispatching, stage == 2);
          expect(fixture.access.updates + fixture.access.deletes, 0);

          if (stage == 1) {
            final result = await fixture.coordinator.recover(
              expectedNonce: receipt.nonce,
            );
            expect(result.outcome, ProjectBlockWriteOutcome.discarded);
            expect(fixture.access.reads, 1);
          } else {
            await expectLater(
              fixture.coordinator.recover(expectedNonce: receipt.nonce),
              _failure(ProjectBlockWriteFailure.uncertain),
            );
            expect(fixture.store.pending, isNotNull);
          }

        }

      }

    },
  );

  test(
    'one authoritative delete acknowledgement needs no absence inference',
    () async {
      final fixture = _Fixture();
      final result = await fixture.coordinator.remove(_row());

      expect(result.id, 'block');
      expect(result.outcome, ProjectBlockWriteOutcome.deleted);
      expect(result.record, isNull);
      expect(fixture.access.reads, 1);
      expect(fixture.access.deletes, 1);
      expect(fixture.store.pending, isNull);
      expect(fixture.events, [
        'read',
        'record',
        'write:false:false',
        'write:true:false',
        'delete',
        'write:false:true',
        'clear',
      ]);
    },
  );

  test(
    'lost delete acknowledgement stays blocked even when row is absent',
    () async {
      final fixture = _Fixture();
      fixture.access.loseDeleteAck = true;

      await expectLater(
        fixture.coordinator.remove(_row()),
        _failure(ProjectBlockWriteFailure.uncertain),
      );
      final receipt = fixture.store.pending!;

      expect(fixture.access.row, isNull);
      expect(receipt.dispatching, isTrue);
      await expectLater(
        fixture.coordinator.recover(expectedNonce: receipt.nonce),
        _failure(ProjectBlockWriteFailure.uncertain),
      );
      expect(fixture.access.reads, 1);
      expect(fixture.access.deletes, 1);
      expect(fixture.store.pending, isNotNull);
    },
  );

  test(
    'acknowledged cleanup and acknowledgement-storage failures never replay',
    () async {
      for (final kind in ProjectBlockWriteKind.values) {
        for (final failAcknowledgement in [false, true]) {
          final fixture = _Fixture();

          if (failAcknowledgement) {
            fixture.store.failWrites.add(3);
          } else {
            fixture.store.failClear = true;
          }

          await expectLater(
            _run(fixture, kind),
            _failure(ProjectBlockWriteFailure.uncertain),
          );
          final receipt = fixture.store.pending!;
          fixture.store.failClear = false;

          if (kind == ProjectBlockWriteKind.delete && failAcknowledgement) {
            await expectLater(
              fixture.coordinator.recover(expectedNonce: receipt.nonce),
              _failure(ProjectBlockWriteFailure.uncertain),
            );
            expect(fixture.access.reads, 1);
          } else {
            final reads = fixture.access.reads;
            final result = await fixture.coordinator.recover(
              expectedNonce: receipt.nonce,
            );
            expect(
              result.outcome,
              kind == ProjectBlockWriteKind.delete
                  ? ProjectBlockWriteOutcome.deleted
                  : ProjectBlockWriteOutcome.verified,
            );
            expect(
              fixture.access.reads,
              reads + (kind == ProjectBlockWriteKind.update ? 1 : 0),
            );
            expect(fixture.store.pending, isNull);
          }

          expect(fixture.access.updates + fixture.access.deletes, 1);
        }

      }

    },
  );

  test(
    'reviewed nonce and one journal block cross-kind replacement cleanup',
    () async {
      final fixture = _Fixture();
      final replacement = _prepared(
        ProjectBlockWriteKind.delete,
        nonce: _otherNonce,
      );
      fixture.store.stored = replacement.encode();

      await expectLater(
        fixture.coordinator.save(_changed(), _row()),
        _failure(ProjectBlockWriteFailure.outstanding),
      );
      await expectLater(
        fixture.coordinator.remove(_row()),
        _failure(ProjectBlockWriteFailure.outstanding),
      );
      await expectLater(
        fixture.coordinator.recover(expectedNonce: _nonce),
        _failure(ProjectBlockWriteFailure.outstanding),
      );
      expect(fixture.store.pending!.nonce, _otherNonce);
      expect(fixture.access.reads, 0);
      expect(fixture.store.clears, 0);

      final result = await fixture.coordinator.recover(
        expectedNonce: _otherNonce,
      );
      expect(result.outcome, ProjectBlockWriteOutcome.discarded);
      expect(fixture.access.reads, 0);
      expect(fixture.access.updates + fixture.access.deletes, 0);

      fixture.store.stored = _prepared(
        ProjectBlockWriteKind.delete,
        scope: 'other',
      ).encode();
      await expectLater(
        fixture.coordinator.outstanding(),
        throwsFormatException,
      );
      expect(fixture.store.pending!.scope, 'other');
    },
  );

  test(
    'closed scopes and concurrent operations cannot dispatch another call',
    () async {
      final fixture = _Fixture();
      fixture.access.active = false;
      await expectLater(
        fixture.coordinator.save(_changed(), _row()),
        throwsStateError,
      );
      expect(fixture.access.reads, 0);
      expect(fixture.store.writes, 0);

      fixture.access.active = true;
      final gate = Completer<void>();
      final started = Completer<void>();
      fixture.access.updateGate = gate;
      fixture.access.updateStarted = started;
      final pending = fixture.coordinator.save(_changed(), _row());

      try {
        await started.future;
        await expectLater(fixture.coordinator.remove(_row()), throwsStateError);
        expect(fixture.access.deletes, 0);
        expect(fixture.access.updates, 1);
      } finally {
        if (!gate.isCompleted) {
          gate.complete();
        }

        final result = await pending;
        expect(result.outcome, ProjectBlockWriteOutcome.verified);
      }

    },
  );

  test(
    'scope loss after dispatch retains intent until actor can verify',
    () async {
      final fixture = _Fixture();
      fixture.access.afterUpdate = () {
        fixture.access.active = false;
      };

      await expectLater(
        fixture.coordinator.save(_changed(), _row()),
        _failure(ProjectBlockWriteFailure.uncertain),
      );
      final receipt = fixture.store.pending!;
      final reads = fixture.access.reads;

      await expectLater(
        fixture.coordinator.recover(expectedNonce: receipt.nonce),
        throwsStateError,
      );
      expect(fixture.access.reads, reads);
      expect(receipt.dispatching, isTrue);

      fixture.access.active = true;
      final result = await fixture.coordinator.recover(
        expectedNonce: receipt.nonce,
      );
      expect(result.outcome, ProjectBlockWriteOutcome.verified);
      expect(fixture.access.updates, 1);
    },
  );
}

Matcher _failure(ProjectBlockWriteFailure failure) {
  return throwsA(
    isA<ProjectBlockWriteException>().having(
      (error) {
        return error.failure;
      },
      'failure',
      failure,
    ),
  );
}

Future<ProjectBlockWriteResult> _run(
  _Fixture fixture,
  ProjectBlockWriteKind kind,
) {
  if (kind == ProjectBlockWriteKind.delete) {
    return fixture.coordinator.remove(_row());
  }

  return fixture.coordinator.save(_changed(), _row());
}

ProjectBlockReceipt _prepared(
  ProjectBlockWriteKind kind, {
  String scope = 'scope',
  String nonce = _nonce,
  models.ProjectsUnavailabilityUpdateInput? input,
}) {
  return ProjectBlockReceipt(
    scope: scope,
    nonce: nonce,
    createdAt: _day,
    kind: kind,
    baseline: _row(),
    input: kind == ProjectBlockWriteKind.update
        ? input ?? projectBlockWriteInput(_changed(), _row())
        : null,
  );
}

ProjectBlockDraft _changed() {
  return ProjectBlockDraft(
    projectId: 'other-project',
    from: DateTime.utc(2026, 10, 15),
    to: DateTime.utc(2026, 10, 16),
    reason: 'Maintenance',
    note: '',
  );
}

ProjectBlockDraft _unchanged() {
  return ProjectBlockDraft(
    projectId: 'project',
    from: _day,
    to: _day,
    reason: 'Closed',
    note: 'Old note',
  );
}

models.ProjectsUnavailabilityListResultItem _row({String? note = 'Old note'}) {
  return models.ProjectsUnavailabilityListResultItem(
    id: 'block',
    projectId: 'project',
    from: _day,
    to: _day,
    reason: 'Closed',
    note: note,
    createdAt: _day,
    modifiedAt: _day,
  );
}

models.ProjectsUnavailabilityListResultItem _targetRow(
  models.ProjectsUnavailabilityListResultItem baseline,
  models.ProjectsUnavailabilityUpdateInput input,
) {
  final target = projectBlockTargetDraft(baseline, input);

  return models.ProjectsUnavailabilityListResultItem(
    id: baseline.id,
    projectId: target.projectId,
    from: target.from,
    to: target.to,
    reason: target.reason,
    note: target.note.isEmpty ? null : target.note,
    createdByUserId: baseline.createdByUserId,
    createdAt: baseline.createdAt,
    modifiedAt: baseline.modifiedAt.add(const Duration(hours: 1)),
  );
}

final class _Fixture {
  _Fixture({
    models.ProjectsUnavailabilityListResultItem? row,
    bool missing = false,
  }) {
    access = _Access(events, missing ? null : row ?? _row());
    store = _Store(events);
    coordinator = ProjectBlockWriteCoordinator(access: access, receipts: store);
  }

  final events = <String>[];
  late final _Access access;
  late final _Store store;
  late final ProjectBlockWriteCoordinator coordinator;
}

final class _Access implements ProjectBlockWriteAccess {
  _Access(this.events, this.row);

  final List<String> events;
  models.ProjectsUnavailabilityListResultItem? row;
  bool active = true;
  bool allowUpdate = true;
  bool allowDelete = true;
  bool dropUpdatedRow = false;
  bool loseUpdateAck = false;
  bool loseDeleteAck = false;
  int reads = 0;
  int updates = 0;
  int deletes = 0;
  final windows = <({String id, DateTime from, DateTime to})>[];
  Completer<void>? updateGate;
  Completer<void>? updateStarted;
  void Function()? afterUpdate;

  @override
  String get scope {
    return 'scope';
  }

  @override
  void checkCurrent() {
    if (!active) {
      throw StateError('TEST_BLOCK_SCOPE_CLOSED');
    }

  }

  @override
  void checkUpdate() {
    checkCurrent();

    if (!allowUpdate) {
      throw StateError('TEST_BLOCK_UPDATE_NOT_ALLOWED');
    }

  }

  @override
  void checkDelete() {
    checkCurrent();

    if (!allowDelete) {
      throw StateError('TEST_BLOCK_DELETE_NOT_ALLOWED');
    }

  }

  @override
  Future<models.ProjectsUnavailabilityListResultItem?> getBlock({
    required String id,
    required DateTime from,
    required DateTime to,
  }) async {
    checkCurrent();

    events.add('record');
    reads++;
    windows.add((id: id, from: from, to: to));

    final value = row;

    if (value == null ||
        value.id != id ||
        value.to.isBefore(from) ||
        value.from.isAfter(to)) {
      return null;
    }

    return value;
  }

  @override
  Future<void> updateBlock(
    models.ProjectsUnavailabilityUpdateInput input,
  ) async {
    checkUpdate();

    events.add('update');
    updates++;

    final started = updateStarted;

    if (started != null && !started.isCompleted) {
      started.complete();
    }

    final gate = updateGate;

    if (gate != null) {
      await gate.future;
    }

    final baseline = row;

    if (dropUpdatedRow || baseline == null) {
      row = null;
    } else {
      row = _targetRow(baseline, input);
    }

    afterUpdate?.call();

    if (loseUpdateAck) {
      throw StateError('TEST_BLOCK_UPDATE_ACK_LOST');
    }

  }

  @override
  Future<void> deleteBlock(String id) async {
    checkDelete();

    events.add('delete');
    deletes++;

    if (row?.id != id) {
      throw StateError('TEST_BLOCK_NOT_FOUND');
    }

    row = null;

    if (loseDeleteAck) {
      throw StateError('TEST_BLOCK_DELETE_ACK_LOST');
    }

  }
}

final class _Store implements ProjectBlockReceiptStore {
  _Store(this.events);

  final List<String> events;
  String? stored;
  bool failRead = false;
  bool failClear = false;
  final failWrites = <int>{};
  int writes = 0;
  int clears = 0;
  void Function(ProjectBlockReceipt receipt, int count)? afterWrite;

  ProjectBlockReceipt? get pending {
    final value = stored;

    if (value == null) {
      return null;
    }

    return ProjectBlockReceipt.decode(value);
  }

  @override
  Future<ProjectBlockReceipt?> read(String scope) async {
    events.add('read');

    if (failRead) {
      throw StateError('TEST_BLOCK_JOURNAL_UNREADABLE');
    }

    return pending;
  }

  @override
  Future<void> write(ProjectBlockReceipt receipt) async {
    final encoded = receipt.encode();

    writes++;

    if (failWrites.contains(writes)) {
      throw StateError('TEST_BLOCK_JOURNAL_WRITE_FAILED');
    }

    stored = encoded;
    events.add('write:${receipt.dispatching}:${receipt.acknowledged}');
    afterWrite?.call(receipt, writes);
  }

  @override
  Future<void> clear(String scope) async {
    events.add('clear');
    clears++;

    if (failClear) {
      throw StateError('TEST_BLOCK_JOURNAL_CLEAR_FAILED');
    }

    stored = null;
  }
}
