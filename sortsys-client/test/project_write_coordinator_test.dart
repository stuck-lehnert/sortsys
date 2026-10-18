import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as api_models;
import 'package:sortsys_client/features/projects/project_draft.dart';
import 'package:sortsys_client/features/projects/project_receipt.dart';
import 'package:sortsys_client/features/projects/project_write_coordinator.dart';

api_models.Project project({String title = 'Harbor'}) {
  return api_models.Project(
    id: 'project-1',
    title: title,
    createdAt: DateTime.utc(2026, 1, 1),
    modifiedAt: DateTime.utc(2026, 1, 2),
  );
}

final class MemoryReceipts implements ProjectReceiptStore {
  ProjectWriteReceipt? value;
  bool failWrite = false;
  bool failClear = false;
  Future<void> Function()? beforeWrite;

  @override
  Future<ProjectWriteReceipt?> read(String scope) async {
    return value;
  }

  @override
  Future<void> write(ProjectWriteReceipt receipt) async {
    await beforeWrite?.call();

    if (failWrite) {
      throw StateError('TEST_STORAGE_FAILURE');
    }

    value = ProjectWriteReceipt.decode(receipt.encode());
  }

  @override
  Future<void> clear(String scope) async {
    if (failClear) {
      throw StateError('TEST_CLEAR_FAILURE');
    }

    value = null;
  }

}

final class RecordingAccess implements ProjectWriteAccess {
  RecordingAccess(this.store);

  final MemoryReceipts store;
  api_models.Project value = project();
  bool current = true;
  bool failCreateResponse = false;
  bool failReads = false;
  bool invalidateAfterCreate = false;
  int creates = 0;
  int updates = 0;
  api_models.ProjectsUpdateInput? update;

  @override
  String get scope {
    return 'instance/tenant/user';
  }

  @override
  void checkCurrent() {
    if (!current) {
      throw StateError('TEST_SESSION_CHANGED');
    }

  }

  @override
  Future<api_models.Project> getProject(String id) async {
    checkCurrent();

    if (failReads) {
      throw StateError('TEST_READ_FAILURE');
    }

    return value;
  }

  @override
  Future<String> createProject(api_models.ProjectsCreateInput input) async {
    expect(store.value?.createInput?.toWire(), input.toWire());
    creates++;
    value = project(title: input.title);

    if (invalidateAfterCreate) {
      current = false;
    }

    if (failCreateResponse) {
      throw StateError('TEST_LOST_RESPONSE');
    }

    return value.id;
  }

  @override
  Future<void> updateProject(api_models.ProjectsUpdateInput input) async {
    expect(store.value?.updateInput?.toWire(), input.toWire());
    updates++;
    update = input;
    value = api_models.Project.fromWire({
      ...value.toWire(),
      ...input.data.toWire(),
    });
  }

}

Matcher failure(ProjectWriteFailure value) {
  return isA<ProjectWriteException>().having(
    (error) {
      return error.failure;
    },

    'failure',
    value,
  );
}

void main() {
  late MemoryReceipts store;
  late RecordingAccess access;
  late ProjectWriteCoordinator writer;

  setUp(() {
    store = MemoryReceipts();
    access = RecordingAccess(store);
    writer = ProjectWriteCoordinator(access: access, receipts: store);
  });

  test(
    'create journals before exactly one dispatch and verifies readback',
    () async {
      final id = await writer.save(const ProjectDraft(title: '  Harbor  '));

      expect(id, 'project-1');
      expect(access.creates, 1);
      expect(access.value.title, '  Harbor  ');
      expect(store.value, isNull);
    },

  );

  test('failed durable storage prevents mutation dispatch', () async {
    store.failWrite = true;

    await expectLater(
      writer.save(const ProjectDraft(title: 'Harbor')),
      throwsStateError,
    );

    expect(access.creates, 0);
    expect(access.updates, 0);
  });

  test(
    'unknown create result is retained and never inferred or replayed',
    () async {
      access.failCreateResponse = true;

      await expectLater(
        writer.save(const ProjectDraft(title: 'Harbor')),
        throwsA(failure(ProjectWriteFailure.uncertain)),
      );

      expect(store.value?.confirmedProjectId, isNull);
      expect(access.value.title, 'Harbor');

      await expectLater(
        writer.recover(),
        throwsA(failure(ProjectWriteFailure.uncertain)),
      );
      await expectLater(
        writer.save(const ProjectDraft(title: 'Other')),
        throwsA(failure(ProjectWriteFailure.outstanding)),
      );

      expect(access.creates, 1);
      expect(store.value, isNotNull);
    },

  );

  test(
    'confirmed create ID survives failed verification for read-only recovery',
    () async {
      access.failReads = true;

      await expectLater(
        writer.save(const ProjectDraft(title: 'Harbor')),
        throwsA(failure(ProjectWriteFailure.uncertain)),
      );

      expect(store.value?.confirmedProjectId, 'project-1');
      access.failReads = false;

      expect(await writer.recover(), 'project-1');
      expect(access.creates, 1);
      expect(store.value, isNull);
    },

  );

  test('fresh edit conflict prevents receipt and dispatch', () async {
    final baseline = access.value;
    access.value = project(title: 'Changed remotely');

    await expectLater(
      writer.save(const ProjectDraft(title: 'Local'), baseline: baseline),
      throwsA(failure(ProjectWriteFailure.conflict)),
    );

    expect(access.updates, 0);
    expect(store.value, isNull);
  });

  test('title-only update omits unrelated fields and contacts', () async {
    final baseline = access.value;

    await writer.save(
      const ProjectDraft(title: 'New title'),
      baseline: baseline,
    );

    expect(access.updates, 1);
    expect(access.update!.toWire(), {
      'id': 'project-1',
      'data': {'title': 'New title'},
    });
    expect(store.value, isNull);
  });

  test('unchanged edit performs no mutation and writes no receipt', () async {
    final baseline = access.value;

    expect(
      await writer.save(ProjectDraft.fromProject(baseline), baseline: baseline),
      baseline.id,
    );
    expect(access.updates, 0);
    expect(store.value, isNull);
  });

  test('session change while journaling prevents dispatch', () async {
    store.beforeWrite = () async {
      access.current = false;
    };

    await expectLater(
      writer.save(const ProjectDraft(title: 'Harbor')),
      throwsA(failure(ProjectWriteFailure.uncertain)),
    );

    expect(access.creates, 0);
    expect(store.value, isNotNull);
  });

  test('recovery mismatch keeps receipt and does not dispatch', () async {
    access.failReads = true;

    await expectLater(
      writer.save(const ProjectDraft(title: 'Harbor')),
      throwsA(failure(ProjectWriteFailure.uncertain)),
    );

    access.failReads = false;
    access.value = project(title: 'Different');

    await expectLater(
      writer.recover(),
      throwsA(failure(ProjectWriteFailure.uncertain)),
    );

    expect(access.creates, 1);
    expect(store.value, isNotNull);
  });

  test(
    'cleanup failure retains confirmed ID without repeating create',
    () async {
      store.failClear = true;

      await expectLater(
        writer.save(const ProjectDraft(title: 'Harbor')),
        throwsA(failure(ProjectWriteFailure.uncertain)),
      );

      expect(store.value?.confirmedProjectId, 'project-1');
      store.failClear = false;

      expect(await writer.recover(), 'project-1');
      expect(access.creates, 1);
    },

  );

  test('concurrent same-scope writes reject instead of queueing', () async {
    final entered = Completer<void>();
    final release = Completer<void>();
    store.beforeWrite = () async {
      if (!entered.isCompleted) {
        entered.complete();
        await release.future;
      }

    };

    final first = writer.save(const ProjectDraft(title: 'Harbor'));
    await entered.future;

    await expectLater(
      writer.save(const ProjectDraft(title: 'Other')),
      throwsStateError,
    );

    release.complete();
    await first;

    expect(access.creates, 1);
  });

  test(
    'session change after dispatch retains uncertainty and blocks replay',
    () async {
      access.invalidateAfterCreate = true;

      await expectLater(
        writer.save(const ProjectDraft(title: 'Harbor')),
        throwsA(failure(ProjectWriteFailure.uncertain)),
      );

      access.current = true;

      await expectLater(
        writer.save(const ProjectDraft(title: 'Other')),
        throwsA(failure(ProjectWriteFailure.outstanding)),
      );

      expect(access.creates, 1);
    },

  );
}
