import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/contract.dart' show jsonMap;
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/api/wire.dart';
import 'package:sortsys_client/features/planning/deployment_delete_coordinator.dart';
import 'package:sortsys_client/features/planning/deployment_delete_receipt.dart';
import 'package:sortsys_client/features/planning/deployment_receipt.dart';
import 'package:sortsys_client/features/planning/deployment_write_coordinator.dart';

final _day = DateTime.utc(2026, 10, 12);

void main() {
  test(
    'delete receipt roundtrip preserves baseline and strict stages/keys',
    () {
      final receipt = _receipt();
      final confirmed = receipt.started().confirmed();
      final decoded = DeploymentDeleteReceipt.decode(confirmed.encode());
      final data = jsonMap(
        deserializeWire(jsonMap(jsonDecode(receipt.encode()))),
      );
      final unknown = {...data, 'unexpected': true};
      final missing = {...data}..remove('acknowledged');

      expect(decoded.acknowledged, isTrue);
      expect(decoded.dispatching, isFalse);
      expect(
        deploymentDeleteKey(decoded.baseline),
        deploymentDeleteKey(receipt.baseline),
      );
      expect(decoded.started, throwsStateError);
      expect(receipt.confirmed, throwsStateError);
      expect(() {
        DeploymentDeleteReceipt.decode(jsonEncode(serializeWire(unknown)));
      }, throwsFormatException);
      expect(() {
        DeploymentDeleteReceipt.decode(jsonEncode(serializeWire(missing)));
      }, throwsFormatException);
    },
  );

  test(
    'only authoritative delete acknowledgement confirms after one dispatch',
    () async {
      final fixture = _Fixture();
      final result = await fixture.writer.remove(_baseline());

      expect(result.id, 'deployment');
      expect(result.deleted, isTrue);
      expect(fixture.deletes, 1);
      expect(fixture.reads, 1);
      expect(fixture.record, isNull);
      expect(fixture.encoded, isNull);
      expect(fixture.stages, ['false:false', 'true:false', 'false:true']);
    },
  );

  test(
    'lost acknowledgement cannot be recovered from a missing bounded row',
    () async {
      final fixture = _Fixture();
      fixture.failAfterDelete = true;

      await expectLater(
        fixture.writer.remove(_baseline()),
        _failure(DeploymentDeleteFailure.uncertain),
      );

      expect(fixture.record, isNull);
      final receipt = await fixture.writer.outstanding();

      await expectLater(
        fixture.writer.recover(expectedNonce: receipt!.nonce),
        _failure(DeploymentDeleteFailure.uncertain),
      );
      await expectLater(
        fixture.writer.remove(_baseline()),
        _failure(DeploymentDeleteFailure.outstanding),
      );

      expect(fixture.deletes, 1);
      expect(fixture.reads, 1);
      expect(fixture.encoded, isNotNull);
    },
  );

  test(
    'acknowledged cleanup recovery needs neither a row read nor replay',
    () async {
      final fixture = _Fixture();
      fixture.failClear = true;

      await expectLater(
        fixture.writer.remove(_baseline()),
        _failure(DeploymentDeleteFailure.uncertain),
      );

      final receipt = await fixture.writer.outstanding();

      expect(receipt?.acknowledged, isTrue);
      fixture.failClear = false;

      final recovered = await fixture.writer.recover(
        expectedNonce: receipt!.nonce,
      );

      expect(recovered.deleted, isTrue);
      expect(fixture.deletes, 1);
      expect(fixture.reads, 1);
      expect(fixture.encoded, isNull);
    },
  );

  test(
    'missing or changed fresh baseline is a conflict not deletion proof',
    () async {
      final missing = _Fixture();
      missing.record = null;

      await expectLater(
        missing.writer.remove(_baseline()),
        _failure(DeploymentDeleteFailure.conflict),
      );

      expect(missing.deletes, 0);
      expect(missing.encoded, isNull);

      final changed = _Fixture();
      changed.record = _baseline(note: 'Changed by another user');

      await expectLater(
        changed.writer.remove(_baseline()),
        _failure(DeploymentDeleteFailure.conflict),
      );

      expect(changed.deletes, 0);
      expect(changed.encoded, isNull);
    },
  );

  test(
    'prepared recovery is nonce-bound and explicitly reports not deleted',
    () async {
      final fixture = _Fixture();
      fixture.encoded = _receipt().encode();

      await expectLater(
        fixture.writer.recover(
          expectedNonce: 'ffffffffffffffffffffffffffffffff',
        ),
        _failure(DeploymentDeleteFailure.outstanding),
      );

      expect(fixture.encoded, isNotNull);

      final result = await fixture.writer.recover(
        expectedNonce: _receipt().nonce,
      );

      expect(result.deleted, isFalse);
      expect(fixture.deletes, 0);
      expect(fixture.reads, 0);
      expect(fixture.encoded, isNull);
    },
  );

  test(
    'role loss during prepared-journal I/O never dispatches deletion',
    () async {
      final fixture = _Fixture();
      fixture.afterWrite = (receipt) {
        fixture.allowed = false;
      };

      await expectLater(
        fixture.writer.remove(_baseline()),
        _failure(DeploymentDeleteFailure.uncertain),
      );

      final receipt = await fixture.writer.outstanding();

      expect(receipt?.dispatching, isFalse);
      expect(fixture.deletes, 0);

      final result = await fixture.writer.recover(
        expectedNonce: receipt!.nonce,
      );

      expect(result.deleted, isFalse);
      expect(fixture.encoded, isNull);
    },
  );

  test(
    'cross-kind pending or unreadable journals block business dispatch',
    () async {
      final fixture = _Fixture();
      fixture.encoded = _receipt().encode();
      final guarded = DeletionGuardedDeploymentReceipts(
        writes: fixture.existing,
        deletions: fixture,
      );

      await expectLater(
        guarded.read('scope'),
        throwsA(
          isA<DeploymentWriteException>().having(
            (error) {
              return error.failure;
            },
            'failure',
            DeploymentWriteFailure.outstanding,
          ),
        ),
      );

      expect(fixture.existing.reads, 0);

      final unreadable = _Fixture();
      unreadable.existing.failRead = true;

      await expectLater(
        unreadable.writer.remove(_baseline()),
        throwsStateError,
      );

      expect(unreadable.deletes, 0);
      expect(unreadable.reads, 0);
      expect(unreadable.encoded, isNull);
    },
  );
}

models.Deployment _baseline({String? note}) {
  return models.Deployment(
    id: 'deployment',
    userId: 'user',
    projectId: 'project',
    from: _day.add(const Duration(hours: 7)),
    to: _day.add(const Duration(hours: 16)),
    note: note,
    createdAt: _day,
    modifiedAt: _day,
  );
}

DeploymentDeleteReceipt _receipt() {
  return DeploymentDeleteReceipt(
    scope: 'scope',
    nonce: '0123456789abcdef0123456789abcdef',
    createdAt: _day,
    baseline: _baseline(),
  );
}

Matcher _failure(DeploymentDeleteFailure failure) {
  return throwsA(
    isA<DeploymentDeleteException>().having(
      (error) {
        return error.failure;
      },
      'failure',
      failure,
    ),
  );
}

final class _ExistingWrites implements DeploymentReceiptStore {
  bool failRead = false;
  int reads = 0;

  @override
  Future<DeploymentWriteReceipt?> read(String scope) async {
    reads++;

    if (failRead) {
      throw StateError('JOURNAL_UNAVAILABLE');
    }

    return null;
  }

  @override
  Future<void> write(DeploymentWriteReceipt receipt) async {
    throw StateError('UNEXPECTED_OTHER_JOURNAL_WRITE');
  }

  @override
  Future<void> clear(String scope) async {
    throw StateError('UNEXPECTED_OTHER_JOURNAL_CLEAR');
  }
}

final class _Fixture implements DeploymentDeleteAccess, DeploymentDeleteStore {
  _Fixture() {
    writer = DeploymentDeleteCoordinator(
      access: this,
      receipts: this,
      pendingWrites: existing,
    );
  }

  final existing = _ExistingWrites();
  late final DeploymentDeleteCoordinator writer;
  models.Deployment? record = _baseline();
  String? encoded;
  bool current = true;
  bool allowed = true;
  bool failAfterDelete = false;
  bool failClear = false;
  void Function(DeploymentDeleteReceipt)? afterWrite;
  int deletes = 0;
  int reads = 0;
  final stages = <String>[];

  @override
  String get scope {
    return 'scope';
  }

  @override
  void checkCurrent() {
    if (!current) {
      throw StateError('SCOPE_CHANGED');
    }
  }

  @override
  void checkDelete() {
    checkCurrent();

    if (!allowed) {
      throw StateError('DELETE_NOT_ALLOWED');
    }
  }

  @override
  Future<models.Deployment?> getDeployment(models.Deployment baseline) async {
    checkDelete();
    reads++;

    return record;
  }

  @override
  Future<void> deleteDeployment(String id) async {
    checkDelete();
    deletes++;
    record = null;

    if (failAfterDelete) {
      throw StateError('RESPONSE_LOST');
    }
  }

  @override
  Future<DeploymentDeleteReceipt?> read(String scope) async {
    final value = encoded;

    if (value == null) {
      return null;
    }

    return DeploymentDeleteReceipt.decode(value);
  }

  @override
  Future<void> write(DeploymentDeleteReceipt receipt) async {
    stages.add('${receipt.dispatching}:${receipt.acknowledged}');
    encoded = receipt.encode();

    afterWrite?.call(receipt);
  }

  @override
  Future<void> clear(String scope) async {
    if (failClear) {
      throw StateError('CLEANUP_FAILED');
    }

    encoded = null;
  }
}
