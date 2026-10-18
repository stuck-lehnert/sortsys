import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/contract.dart' show jsonMap;
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/api/model.dart';
import 'package:sortsys_client/api/wire.dart';
import 'package:sortsys_client/features/planning/absence_receipt.dart';
import 'package:sortsys_client/features/planning/absence_write_coordinator.dart';
import 'package:sortsys_client/features/planning/planning_draft.dart';

final _day = DateTime.utc(2026, 10, 12);

void main() {
  test(
    'civil write input and acknowledgement survive strict wire roundtrip',
    () {
      final input = absenceWriteInput(_draft());
      final started = _receipt(input).started();
      final acknowledgement = models.UsersVacationsCreateResult(
        id: 'created',
        status: models.UsersVacationsListResultItemStatus.approved,
      );
      final confirmed = started.confirmed(acknowledgement);
      final decoded = AbsenceWriteReceipt.decode(confirmed.encode());

      expect(readRpcDate(input.from).isUtc, isTrue);
      expect(readRpcDate(input.from), _day);
      expect(readRpcDate(input.to), _day);
      expect(input.note.valueOrNull, 'Bring documents');
      expect(input.label.valueOrNull, isNull);
      expect(decoded.acknowledgement?.id, 'created');
      expect(decoded.acknowledgement?.status, acknowledgement.status);
      expect(absenceInputKey(decoded.input), absenceInputKey(input));
      expect(decoded.started, throwsStateError);
    },
  );

  test('receipt rejects unknown missing oversized and inconsistent fields', () {
    final receipt = _receipt(absenceWriteInput(_draft()));
    final data = <String, Object?>{
      ...jsonMap(deserializeWire(jsonMap(jsonDecode(receipt.encode())))),
    };
    final unknown = {...data, 'unexpected': true};
    final missing = {...data}..remove('acknowledgement');

    expect(() {
      AbsenceWriteReceipt.decode(jsonEncode(serializeWire(unknown)));
    }, throwsFormatException);
    expect(() {
      AbsenceWriteReceipt.decode(jsonEncode(serializeWire(missing)));
    }, throwsFormatException);
    expect(() {
      _receipt(
        absenceWriteInput(_draft(note: List.filled(131073, 'x').join())),
      ).encode();
    }, throwsFormatException);
    expect(() {
      receipt.started().confirmed(
        const models.UsersVacationsCreateResult(
          id: '',
          status: models.UsersVacationsListResultItemStatus.requested,
        ),
      );
    }, throwsFormatException);
  });

  test(
    'durable dispatch ack and readback order preserves actual status',
    () async {
      final fixture = _Fixture();
      final record = await fixture.writer.save(_draft());

      expect(record.status, models.UsersVacationsListResultItemStatus.approved);
      expect(fixture.access.creates, 1);
      expect(fixture.store.encoded, isNull);
      expect(fixture.events, [
        'journal.read',
        'journal.write:false:-',
        'journal.write:true:-',
        'mutation',
        'journal.write:false:created',
        'readback:created',
        'journal.clear',
      ]);
    },
  );

  test(
    'recipient denial and initial journal failure prevent dispatch',
    () async {
      final denied = _Fixture();

      await expectLater(
        denied.writer.save(_draft(userId: 'other')),
        throwsStateError,
      );

      expect(denied.events, isEmpty);
      expect(denied.access.creates, 0);
      final storage = _Fixture();
      storage.store.failWrite = 1;

      await expectLater(storage.writer.save(_draft()), throwsStateError);

      expect(storage.access.creates, 0);
      expect(storage.store.encoded, isNull);
    },
  );

  test('unknown committed creation is not matched or resubmitted', () async {
    final fixture = _Fixture();
    fixture.access.failAfterCreate = true;

    await expectLater(fixture.writer.save(_draft()), _uncertain());
    await expectLater(fixture.writer.recover(), _uncertain());
    await expectLater(
      fixture.writer.save(_draft()),
      throwsA(
        isA<AbsenceWriteException>().having(
          (error) {
            return error.failure;
          },
          'failure',
          AbsenceWriteFailure.outstanding,
        ),
      ),
    );

    expect(fixture.access.creates, 1);
    expect(fixture.access.reads, 0);
    expect(fixture.access.record, isNotNull);
    expect((await fixture.writer.outstanding())?.dispatching, isTrue);
  });

  test(
    'recipient permission lost during journal I/O leaves proven-unsent intent',
    () async {
      final fixture = _Fixture();
      fixture.access.canManage = true;
      fixture.store.afterWrite = (count) {
        if (count == 1) {
          fixture.access.canManage = false;
        }
      };

      await expectLater(
        fixture.writer.save(_draft(userId: 'other')),
        _uncertain(),
      );

      expect(fixture.access.creates, 0);
      expect((await fixture.writer.outstanding())?.dispatching, isFalse);
      expect(await fixture.writer.recover(), isNull);
      expect(fixture.store.encoded, isNull);
    },
  );

  test(
    'known-ID recovery reads latest approval without repeating creation',
    () async {
      final fixture = _Fixture();
      fixture.access.status =
          models.UsersVacationsListResultItemStatus.requested;
      fixture.access.failRead = true;

      await expectLater(fixture.writer.save(_draft()), _uncertain());

      expect(
        (await fixture.writer.outstanding())?.acknowledgement?.id,
        'created',
      );
      fixture.access.failRead = false;
      fixture.access.record = _record(
        absenceWriteInput(_draft()),
        models.UsersVacationsListResultItemStatus.approved,
      );

      final recovered = await fixture.writer.recover();

      expect(
        recovered?.status,
        models.UsersVacationsListResultItemStatus.approved,
      );
      expect(fixture.access.creates, 1);
      expect(fixture.store.encoded, isNull);
    },
  );

  test(
    'recovery cannot clear a different intent than the reviewed nonce',
    () async {
      final fixture = _Fixture();
      final receipt = _receipt(absenceWriteInput(_draft()));
      fixture.store.encoded = receipt.encode();

      await expectLater(
        fixture.writer.recover(
          expectedNonce: 'ffffffffffffffffffffffffffffffff',
        ),
        throwsA(
          isA<AbsenceWriteException>().having(
            (error) {
              return error.failure;
            },
            'failure',
            AbsenceWriteFailure.outstanding,
          ),
        ),
      );

      expect(fixture.store.encoded, isNotNull);
      expect(fixture.access.creates, 0);
      expect(fixture.access.reads, 0);
      expect(
        await fixture.writer.recover(expectedNonce: receipt.nonce),
        isNull,
      );
      expect(fixture.store.encoded, isNull);
    },
  );

  test('proven-unsent intent clears without any business mutation', () async {
    final fixture = _Fixture();
    fixture.store.encoded = _receipt(absenceWriteInput(_draft())).encode();

    final recovered = await fixture.writer.recover();

    expect(recovered, isNull);
    expect(fixture.access.creates, 0);
    expect(fixture.access.reads, 0);
    expect(fixture.store.encoded, isNull);
  });

  test(
    'missing readback remains uncertain and closed scope cannot recover',
    () async {
      final fixture = _Fixture();
      fixture.access.failRead = true;

      await expectLater(fixture.writer.save(_draft()), _uncertain());

      fixture.access.failRead = false;
      fixture.access.record = null;

      await expectLater(fixture.writer.recover(), _uncertain());

      fixture.access.current = false;

      await expectLater(fixture.writer.recover(), throwsStateError);

      expect(fixture.access.creates, 1);
      expect(fixture.store.encoded, isNotNull);
    },
  );

  test(
    'acknowledgement storage failure never guesses creation ownership',
    () async {
      final fixture = _Fixture();
      fixture.store.failWrite = 3;

      await expectLater(fixture.writer.save(_draft()), _uncertain());
      await expectLater(fixture.writer.recover(), _uncertain());

      expect(fixture.access.creates, 1);
      expect(fixture.access.reads, 0);
      expect((await fixture.writer.outstanding())?.acknowledgement, isNull);
    },
  );

  test('cleanup recovery only rereads confirmed record', () async {
    final fixture = _Fixture();
    fixture.store.failClear = true;

    await expectLater(fixture.writer.save(_draft()), _uncertain());

    fixture.store.failClear = false;
    final recovered = await fixture.writer.recover();

    expect(recovered?.id, 'created');
    expect(fixture.access.creates, 1);
    expect(fixture.access.reads, 2);
    expect(fixture.store.encoded, isNull);
  });
}

AbsenceDraft _draft({
  String userId = 'actor',
  String note = '  Bring documents  ',
}) {
  return AbsenceDraft(
    userId: userId,
    from: DateTime(2026, 10, 12, 17),
    to: DateTime(2026, 10, 12, 19),
    type: models.UsersVacationsListResultItemType.vacation,
    label: 'Hidden label',
    note: note,
  );
}

AbsenceWriteReceipt _receipt(models.UsersVacationsCreateInput input) {
  return AbsenceWriteReceipt(
    scope: 'scope',
    nonce: '0123456789abcdef0123456789abcdef',
    createdAt: _day,
    input: input,
  );
}

Matcher _uncertain() {
  return throwsA(
    isA<AbsenceWriteException>().having(
      (error) {
        return error.failure;
      },
      'failure',
      AbsenceWriteFailure.uncertain,
    ),
  );
}

models.UsersVacationsListResultItem _record(
  models.UsersVacationsCreateInput input,
  models.UsersVacationsListResultItemStatus status,
) {
  return models.UsersVacationsListResultItem(
    id: 'created',
    userId: input.userId.valueOrNull!,
    from: readRpcDate(input.from),
    to: readRpcDate(input.to),
    type: input.type.valueOrNull!,
    label: input.label.valueOrNull,
    note: input.note.valueOrNull,
    status: status,
    canApprove: false,
    canDeny: false,
    canDelete: false,
    vacationUsage: const [],
    createdAt: _day,
    modifiedAt: _day,
  );
}

final class _Fixture {
  _Fixture() {
    access = _Access(events);
    store = _Store(events);
    writer = AbsenceWriteCoordinator(access: access, receipts: store);
  }

  final events = <String>[];
  late final _Access access;
  late final _Store store;
  late final AbsenceWriteCoordinator writer;
}

final class _Store implements AbsenceReceiptStore {
  _Store(this.events);

  final List<String> events;
  String? encoded;
  int writes = 0;
  int? failWrite;
  bool failClear = false;
  void Function(int)? afterWrite;

  @override
  Future<AbsenceWriteReceipt?> read(String scope) async {
    events.add('journal.read');
    final value = encoded;

    if (value == null) {
      return null;
    }

    return AbsenceWriteReceipt.decode(value);
  }

  @override
  Future<void> write(AbsenceWriteReceipt receipt) async {
    writes++;
    events.add(
      'journal.write:${receipt.dispatching}:${receipt.acknowledgement?.id ?? '-'}',
    );

    if (writes == failWrite) {
      throw StateError('STORAGE_FAILED');
    }

    encoded = receipt.encode();
    afterWrite?.call(writes);
  }

  @override
  Future<void> clear(String scope) async {
    events.add('journal.clear');

    if (failClear) {
      throw StateError('CLEANUP_FAILED');
    }

    encoded = null;
  }
}

final class _Access implements AbsenceWriteAccess {
  _Access(this.events);

  final List<String> events;
  bool current = true;
  bool canManage = false;
  bool failAfterCreate = false;
  bool failRead = false;
  int creates = 0;
  int reads = 0;
  models.UsersVacationsListResultItem? record;
  models.UsersVacationsListResultItemStatus status =
      models.UsersVacationsListResultItemStatus.approved;

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
  void checkCreate(models.UsersVacationsCreateInput input) {
    checkCurrent();

    if (input.userId.valueOrNull != 'actor' && !canManage) {
      throw StateError('RECIPIENT_NOT_ALLOWED');
    }
  }

  @override
  Future<models.UsersVacationsCreateResult> createAbsence(
    models.UsersVacationsCreateInput input,
  ) async {
    checkCreate(input);
    creates++;
    events.add('mutation');
    record = _record(input, status);

    if (failAfterCreate) {
      throw StateError('RESPONSE_LOST');
    }

    return models.UsersVacationsCreateResult(id: 'created', status: status);
  }

  @override
  Future<models.UsersVacationsListResultItem?> getAbsence(
    String id,
    models.UsersVacationsCreateInput target,
  ) async {
    checkCurrent();
    reads++;
    events.add('readback:$id');

    if (failRead) {
      throw StateError('READ_FAILED');
    }

    final value = record;

    if (value == null ||
        value.id != id ||
        !absenceMatchesInput(value, target)) {
      return null;
    }

    return models.UsersVacationsListResultItem.fromWire(value.toWire());
  }
}
