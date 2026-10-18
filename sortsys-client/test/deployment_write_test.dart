import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/contract.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/api/model.dart';
import 'package:sortsys_client/api/wire.dart';
import 'package:sortsys_client/features/planning/deployment_receipt.dart';
import 'package:sortsys_client/features/planning/deployment_write_coordinator.dart';
import 'package:sortsys_client/features/planning/planning_draft.dart';

final _day = DateTime.utc(2026, 10, 12);

void main() {
  test(
    'receipt roundtrip preserves dates, ordered targets and immutable IDs',
    () {
      final receipt = _receipt(
        users: ['u2', 'u1'],
      ).started().confirmed('known');
      final decoded = DeploymentWriteReceipt.decode(receipt.encode());

      expect(
        decoded.targets.map((target) {
          return target.userId;
        }),
        ['u2', 'u1'],
      );
      expect(
        readRpcDate(decoded.targets.first.from),
        DateTime.utc(2026, 10, 12, 7),
      );
      expect(decoded.confirmedIds, ['known']);
      expect(decoded.dispatching, isFalse);
      expect(() {
        decoded.confirmedIds.add('other');
      }, throwsUnsupportedError);
      expect(() {
        decoded.targets.clear();
      }, throwsUnsupportedError);
    },
  );

  test(
    'receipt rejects unknown fields, impossible stages and inconsistent updates',
    () {
      final receipt = _receipt();
      final envelope = jsonMap(jsonDecode(receipt.encode()));
      final original = jsonMap(deserializeWire(envelope));
      final extra = <String, Object?>{...original, 'unexpected': true};

      expect(() {
        DeploymentWriteReceipt.decode(jsonEncode(serializeWire(extra)));
      }, throwsFormatException);
      expect(() {
        _receipt().confirmed('known').started().encode();
      }, throwsFormatException);
      expect(() {
        _receipt(
          users: ['u1', 'u2'],
        ).confirmed('same').confirmed('same').encode();
      }, throwsFormatException);

      final baseline = _record(
        'existing',
        _draft(note: 'old').createInputs().single,
      );
      final target = _draft(note: 'desired').createInputs().single;
      final invalid = DeploymentWriteReceipt(
        scope: 'scope',
        nonce: '00000000000000000000000000000000',
        createdAt: _day,
        targets: [target],
        baseline: baseline,
        updateInput: _draft(note: 'different').updateInput(baseline),
      );

      expect(invalid.encode, throwsFormatException);
    },
  );

  test(
    'each user dispatch has a durable stage and acknowledgement in order',
    () async {
      final fixture = _Fixture();
      final result = await fixture.coordinator.save(
        _draft(users: ['u2', 'u1']),
      );

      expect(result.ids, ['new-1', 'new-2']);
      expect(result.complete, isTrue);
      expect(fixture.store.value, isNull);
      expect(fixture.events, [
        'journal-read',
        'receipt:0:false',
        'receipt:0:true',
        'create:u2',
        'receipt:1:false',
        'receipt:1:true',
        'create:u1',
        'receipt:2:false',
        'read:new-1',
        'read:new-2',
        'clear',
      ]);
    },
  );

  test(
    'failed initial durable storage prevents every business dispatch',
    () async {
      final fixture = _Fixture();
      fixture.store.failWriteAt = 1;

      await expectLater(fixture.coordinator.save(_draft()), throwsStateError);

      expect(fixture.access.createdInputs, isEmpty);
      expect(fixture.access.updatedInputs, isEmpty);
      expect(fixture.store.value, isNull);
    },
  );

  test(
    'unknown committed creation is neither matched by content nor replayed',
    () async {
      final fixture = _Fixture();
      fixture.access.failAfterCreate = true;

      await expectLater(fixture.coordinator.save(_draft()), _uncertain());

      expect(fixture.access.records, hasLength(1));
      expect(fixture.store.value?.dispatching, isTrue);
      expect(fixture.store.value?.confirmedIds, isEmpty);
      await expectLater(fixture.coordinator.recover(), _uncertain());
      await expectLater(
        fixture.coordinator.save(_draft()),
        _failure(DeploymentWriteFailure.outstanding),
      );

      expect(fixture.access.createdInputs, hasLength(1));
      expect(
        fixture.events.where((event) {
          return event.startsWith('read:');
        }),
        isEmpty,
      );
      expect(fixture.store.value, isNotNull);
    },
  );

  test(
    'known-ID readback recovery never repeats acknowledged creations',
    () async {
      final fixture = _Fixture();
      fixture.access.failRead = true;

      await expectLater(
        fixture.coordinator.save(_draft(users: ['u1', 'u2'])),
        _uncertain(),
      );

      expect(fixture.store.value?.confirmedIds, ['new-1', 'new-2']);
      expect(fixture.store.value?.dispatching, isFalse);
      fixture.access.failRead = false;
      final acknowledged = Map<String, models.Deployment>.of(
        fixture.access.records,
      );
      fixture.access.records.clear();

      await expectLater(fixture.coordinator.recover(), _uncertain());

      expect(fixture.store.value, isNotNull);
      expect(fixture.access.createdInputs, hasLength(2));
      fixture.access.records.addAll(acknowledged);

      final result = await fixture.coordinator.recover();

      expect(result.ids, ['new-1', 'new-2']);
      expect(result.complete, isTrue);
      expect(fixture.access.createdInputs, hasLength(2));
      expect(fixture.store.value, isNull);
    },
  );

  test(
    'partial recovery reports proven-unsent users without dispatching them',
    () async {
      final fixture = _Fixture();
      fixture.store.failWriteAt = 4;

      await expectLater(
        fixture.coordinator.save(_draft(users: ['u1', 'u2'])),
        _uncertain(),
      );

      expect(fixture.store.value?.confirmedIds, ['new-1']);
      expect(fixture.store.value?.dispatching, isFalse);
      final result = await fixture.coordinator.recover();

      expect(result.ids, ['new-1']);
      expect(result.complete, isFalse);
      expect(result.unsubmitted.single.userId, 'u2');
      expect(fixture.access.createdInputs, hasLength(1));
      expect(fixture.store.value, isNull);
    },
  );

  test(
    'fresh update sends only changed fields and a no-op has no journal',
    () async {
      final fixture = _Fixture();
      final baseline = _record(
        'existing',
        _draft(note: 'old').createInputs().single,
      );
      fixture.access.records[baseline.id] = baseline;

      final result = await fixture.coordinator.save(
        _draft(note: 'new'),
        baseline: baseline,
      );
      final update = fixture.access.updatedInputs.single;

      expect(result.ids, ['existing']);
      expect(jsonMap(update.data.toWire()), {'note': 'new'});
      expect(fixture.access.createdInputs, isEmpty);
      final writes = fixture.store.writeCount;
      final current = fixture.access.records['existing']!;

      final unchanged = await fixture.coordinator.save(
        _draft(note: 'new'),
        baseline: current,
      );

      expect(unchanged.ids, ['existing']);
      expect(fixture.access.updatedInputs, hasLength(1));
      expect(fixture.store.writeCount, writes);
      expect(fixture.store.value, isNull);
    },
  );

  test(
    'record moved outside baseline window is a conflict, not a write confirmation',
    () async {
      final fixture = _Fixture();
      final baseline = _record('existing', _draft().createInputs().single);
      final moved = DeploymentDraft(
        userIds: ['u1'],
        projectId: 'project',
        from: baseline.from.add(const Duration(days: 2)),
        to: baseline.to.add(const Duration(days: 2)),
        note: baseline.note ?? '',
      );
      fixture.access.records[baseline.id] = _record(
        baseline.id,
        moved.createInputs().single,
      );

      await expectLater(
        fixture.coordinator.save(_draft(note: 'change'), baseline: baseline),
        _failure(DeploymentWriteFailure.conflict),
      );

      expect(fixture.access.updatedInputs, isEmpty);
      expect(fixture.store.writeCount, 0);
    },
  );

  test(
    'fresh baseline mismatch prevents update and durable request creation',
    () async {
      final fixture = _Fixture();
      final baseline = _record(
        'existing',
        _draft(note: 'old').createInputs().single,
      );
      fixture.access.records[baseline.id] = _record(
        baseline.id,
        _draft(note: 'external').createInputs().single,
      );

      await expectLater(
        fixture.coordinator.save(_draft(note: 'new'), baseline: baseline),
        _failure(DeploymentWriteFailure.conflict),
      );

      expect(fixture.access.updatedInputs, isEmpty);
      expect(fixture.store.writeCount, 0);
    },
  );

  test(
    'stale identity and mismatched receipt scope fail before dispatch',
    () async {
      final stale = _Fixture();
      stale.access.current = false;

      await expectLater(stale.coordinator.save(_draft()), throwsStateError);

      expect(stale.store.writeCount, 0);
      expect(stale.access.createdInputs, isEmpty);
      final mismatch = _Fixture();
      mismatch.store.value = _receipt(scope: 'another-scope');

      await expectLater(
        mismatch.coordinator.save(_draft()),
        throwsFormatException,
      );

      expect(mismatch.store.writeCount, 0);
      expect(mismatch.access.createdInputs, isEmpty);
    },
  );

  test(
    'recovery reports a proven-unsent update without pretending confirmation',
    () async {
      final fixture = _Fixture();
      final baseline = _record(
        'existing',
        _draft(note: 'old').createInputs().single,
      );
      final draft = _draft(note: 'new');
      fixture.access.records[baseline.id] = baseline;
      fixture.store.value = DeploymentWriteReceipt(
        scope: fixture.access.scope,
        nonce: '00000000000000000000000000000000',
        createdAt: _day,
        targets: draft.createInputs(),
        baseline: baseline,
        updateInput: draft.updateInput(baseline),
      );

      final result = await fixture.coordinator.recover();

      expect(result.ids, isEmpty);
      expect(result.complete, isFalse);
      expect(result.unsubmitted, hasLength(1));
      expect(fixture.access.updatedInputs, isEmpty);
      expect(fixture.store.value, isNull);
    },
  );

  test(
    'uncertain update recovery verifies known ID without another mutation',
    () async {
      final fixture = _Fixture();
      final baseline = _record(
        'existing',
        _draft(note: 'old').createInputs().single,
      );
      fixture.access.records[baseline.id] = baseline;
      fixture.access.failAfterUpdate = true;

      await expectLater(
        fixture.coordinator.save(_draft(note: 'new'), baseline: baseline),
        _uncertain(),
      );

      expect(fixture.store.value?.dispatching, isTrue);
      expect(fixture.store.value?.confirmedIds, isEmpty);
      final result = await fixture.coordinator.recover();

      expect(result.ids, ['existing']);
      expect(result.complete, isTrue);
      expect(fixture.access.updatedInputs, hasLength(1));
      expect(fixture.store.value, isNull);
    },
  );

  test(
    'failed journal cleanup can be recovered without another creation',
    () async {
      final fixture = _Fixture();
      fixture.store.failClear = true;

      await expectLater(fixture.coordinator.save(_draft()), _uncertain());

      expect(fixture.store.value?.confirmedIds, ['new-1']);
      fixture.store.failClear = false;
      final result = await fixture.coordinator.recover();

      expect(result.ids, ['new-1']);
      expect(fixture.access.createdInputs, hasLength(1));
      expect(fixture.store.value, isNull);
    },
  );

  test(
    'default deployment lock rejects concurrent write without queuing it',
    () async {
      final fixture = _Fixture();
      final release = Completer<void>();
      fixture.access.createGate = release;
      final first = fixture.coordinator.save(_draft());
      await Future<void>.delayed(Duration.zero);

      try {
        await expectLater(fixture.coordinator.save(_draft()), throwsStateError);

        expect(fixture.access.createdInputs, hasLength(1));
      } finally {
        release.complete();
      }

      final result = await first;

      expect(result.ids, ['new-1']);
      expect(fixture.access.createdInputs, hasLength(1));
    },
  );
}

Matcher _uncertain() {
  return _failure(DeploymentWriteFailure.uncertain);
}

Matcher _failure(DeploymentWriteFailure failure) {
  final exception = isA<DeploymentWriteException>().having(
    (error) {
      return error.failure;
    },
    'failure',
    failure,
  );

  return throwsA(exception);
}

DeploymentDraft _draft({
  Iterable<String> users = const ['u1'],
  String note = 'note',
}) {
  return DeploymentDraft(
    userIds: users,
    projectId: 'project',
    from: DateTime.utc(2026, 10, 12, 7),
    to: DateTime.utc(2026, 10, 12, 16),
    note: note,
  );
}

DeploymentWriteReceipt _receipt({
  Iterable<String> users = const ['u1'],
  String scope = 'scope',
}) {
  return DeploymentWriteReceipt(
    scope: scope,
    nonce: '00000000000000000000000000000000',
    createdAt: _day,
    targets: _draft(users: users).createInputs(),
  );
}

models.Deployment _record(
  String id,
  models.ProjectsDeploymentsCreateInput input,
) {
  return models.Deployment(
    id: id,
    projectId: input.projectId,
    userId: input.userId,
    from: readRpcDate(input.from),
    to: readRpcDate(input.to),
    note: input.note.valueOrNull,
    createdAt: _day,
    modifiedAt: _day,
  );
}

final class _Fixture {
  _Fixture() {
    store = _Store(events);
    access = _Access(events);
    coordinator = DeploymentWriteCoordinator(access: access, receipts: store);
  }

  final List<String> events = [];
  late final _Store store;
  late final _Access access;
  late final DeploymentWriteCoordinator coordinator;
}

final class _Store implements DeploymentReceiptStore {
  _Store(this.events);

  final List<String> events;
  DeploymentWriteReceipt? value;
  int writeCount = 0;
  int? failWriteAt;
  bool failClear = false;

  @override
  Future<DeploymentWriteReceipt?> read(String scope) async {
    events.add('journal-read');

    return value;
  }

  @override
  Future<void> write(DeploymentWriteReceipt receipt) async {
    final detached = DeploymentWriteReceipt.decode(receipt.encode());
    writeCount++;

    if (writeCount == failWriteAt) {
      throw StateError('STORAGE_WRITE_FAILED');
    }

    value = detached;
    events.add('receipt:${receipt.confirmedIds.length}:${receipt.dispatching}');
  }

  @override
  Future<void> clear(String scope) async {
    if (failClear) {
      throw StateError('STORAGE_CLEAR_FAILED');
    }

    value = null;
    events.add('clear');
  }
}

final class _Access implements DeploymentWriteAccess {
  _Access(this.events);

  final List<String> events;
  final Map<String, models.Deployment> records = {};
  final List<models.ProjectsDeploymentsCreateInput> createdInputs = [];
  final List<models.ProjectsDeploymentsUpdateInput> updatedInputs = [];
  bool current = true;
  bool failRead = false;
  bool failAfterCreate = false;
  bool failAfterUpdate = false;
  Completer<void>? createGate;

  @override
  String get scope => 'scope';

  @override
  void checkCurrent() {
    if (!current) {
      throw StateError('DEPLOYMENT_WRITE_SCOPE_CHANGED');
    }
  }

  @override
  Future<models.Deployment?> getDeployment(
    String id, {
    required DateTime from,
    required DateTime to,
  }) async {
    events.add('read:$id');

    if (failRead) {
      throw StateError('READ_FAILED');
    }

    final record = records[id];

    if (record == null ||
        !record.to.isAfter(from) ||
        !record.from.isBefore(to)) {
      return null;
    }

    return models.Deployment.fromWire(record.toWire());
  }

  @override
  Future<String> createDeployment(
    models.ProjectsDeploymentsCreateInput input,
  ) async {
    createdInputs.add(input);
    events.add('create:${input.userId}');
    await createGate?.future;

    final id = 'new-${createdInputs.length}';
    records[id] = _record(id, input);

    if (failAfterCreate) {
      throw StateError('RESPONSE_LOST');
    }

    return id;
  }

  @override
  Future<void> updateDeployment(
    models.ProjectsDeploymentsUpdateInput input,
  ) async {
    updatedInputs.add(input);
    events.add('update:${input.id}');
    final previous = records[input.id];

    if (previous == null) {
      throw StateError('DEPLOYMENT_NOT_FOUND');
    }

    final changed = <String, Object?>{
      ...jsonMap(previous.toWire()),
      ...jsonMap(input.data.toWire()),
      'modifiedAt': _day.add(const Duration(minutes: 1)),
    };
    records[input.id] = models.Deployment.fromWire(changed);

    if (failAfterUpdate) {
      throw StateError('RESPONSE_LOST');
    }
  }
}
