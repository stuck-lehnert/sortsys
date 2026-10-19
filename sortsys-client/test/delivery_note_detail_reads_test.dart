import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/api/procedure.dart';
import 'package:sortsys_client/features/delivery_notes/delivery_note_detail_reads.dart';

void main() {
  test('delivery detail and costs send actual ID inputs and preserve zero', () async {
    final reads = _Reads()..response = _note();
    final repository = _repository(reads);

    final note = await repository.get();
    reads.response = _costs(records: [_record()]);

    final costs = await repository.costs();

    expect(note.id, 'owner');
    expect(costs.totalCost, 0);
    expect(costs.records.single.quantity, 0);
    expect(costs.records.single.priceRecord, isNull);
    expect(reads.requests.map((request) {
      return request.$1;
    }), ['deliveryNotes.get', 'deliveryNotes.costs.get']);
    expect((reads.requests[0].$2 as models.DeliveryNotesGetInput).toWire(), {
      'id': 'owner',
    });
    expect((reads.requests[1].$2 as models.DeliveryNotesCostsGetInput).toWire(), {
      'id': 'owner',
    });
    expect(() => note.records.clear(), throwsUnsupportedError);
    expect(() => note.specialRecords.clear(), throwsUnsupportedError);
    expect(() => costs.records.clear(), throwsUnsupportedError);
    expect(() => costs.specialRecords.clear(), throwsUnsupportedError);
  });

  test('delivery detail and costs reject changed owner scope or page visibility', () async {
    for (final costs in [false, true]) {
      for (final scope in [false, true]) {
        final reads = _Reads();
        final repository = _repository(reads);
        reads.current = !scope;
        reads.allowed = scope;

        final blocked = costs ? repository.costs() : repository.get();

        await expectLater(blocked, throwsStateError);
        expect(reads.requests, isEmpty);

        reads.current = true;
        reads.allowed = true;
        final pending = Completer<Object?>();
        reads.response = pending.future;

        final result = costs ? repository.costs() : repository.get();

        if (scope) {
          reads.current = false;
        } else {
          reads.allowed = false;
        }

        pending.complete(costs ? _costs() : _note());
        await expectLater(result, throwsStateError);
      }
    }
  });

  test('delivery reads reject empty selections and mismatched response owners', () async {
    final reads = _Reads()..response = _note(id: 'wrong');
    final repository = _repository(reads);

    await expectLater(_repository(reads, owner: '').get(), throwsStateError);
    await expectLater(_repository(reads, owner: '').costs(), throwsStateError);
    expect(reads.requests, isEmpty);

    await expectLater(repository.get(), throwsStateError);
    reads.response = _costs(owner: 'wrong');

    await expectLater(repository.costs(), throwsStateError);
  });

  test('delivery costs reject duplicate empty and wrong-product record identities', () async {
    final reads = _Reads();
    final repository = _repository(reads);
    final wrongPrice = models.ProductsPriceRecordsListResultItem(
      id: 'price',
      productId: 'wrong-product',
      timestamp: DateTime.utc(2024),
      price: 0,
      isRealPurchase: true,
    );

    for (final records in [
      [_record(id: '')],
      [_record(), _record()],
      [_record(price: wrongPrice)],
    ]) {
      reads.response = _costs(records: records);

      await expectLater(repository.costs(), throwsFormatException);
    }

    for (final records in [
      [_special(id: '')],
      [_special(), _special()],
    ]) {
      reads.response = _costs(special: records);

      await expectLater(repository.costs(), throwsFormatException);
    }
  });

  test('delivery costs snapshot both record lists without extra price permissions', () async {
    final records = [_record()];
    final special = [_special()];
    final reads = _Reads()..response = _costs(records: records, special: special);
    final repository = _repository(reads);

    final costs = await repository.costs();
    records.clear();
    special.clear();

    expect(costs.records, hasLength(1));
    expect(costs.specialRecords, hasLength(1));
    expect(costs.specialRecords.single.pricePerUnit, 0);
    expect(costs.specialRecords.single.totalCost, 0);
    expect(reads.requests, hasLength(1));
  });
}

DeliveryNoteDetailReads _repository(_Reads reads, {String owner = 'owner'}) {
  return DeliveryNoteDetailReads(
    noteId: owner,
    read: reads.read,
    isCurrent: () {
      return reads.current;
    },
    canView: () {
      return reads.allowed;
    },
  );
}

models.DeliveryNote _note({String id = 'owner'}) {
  return models.DeliveryNote(
    id: id,
    autoId: 0,
    projectId: 'project',
    createdAt: DateTime.utc(2024),
    effectiveTimestamp: DateTime.utc(2024),
    records: const [],
    specialRecords: const [],
  );
}

models.DeliveryNotesCostsGetOutput _costs({
  String owner = 'owner',
  List<models.DeliveryNotesCostsGetResultRecordsItem> records = const [],
  List<models.DeliveryNotesCostsGetResultSpecialRecordsItem> special = const [],
}) {
  return models.DeliveryNotesCostsGetOutput(
    noteId: owner,
    totalCost: 0,
    records: records,
    specialRecords: special,
  );
}

models.DeliveryNotesCostsGetResultRecordsItem _record({
  String id = 'record',
  models.ProductsPriceRecordsListResultItem? price,
}) {
  return models.DeliveryNotesCostsGetResultRecordsItem(
    recordId: id,
    productId: 'product',
    quantity: 0,
    priceRecord: price,
  );
}

models.DeliveryNotesCostsGetResultSpecialRecordsItem _special({
  String id = 'special',
}) {
  return models.DeliveryNotesCostsGetResultSpecialRecordsItem(
    recordId: id,
    name: 'Special',
    unit: 'kg',
    amount: 0,
    pricePerUnit: 0,
    totalCost: 0,
  );
}

class _Reads {
  Object? response;
  bool current = true;
  bool allowed = true;
  final requests = <(String, Object?)>[];

  Future<O> read<I, O>(RpcQuery<I, O> query, I input) async {
    requests.add((query.path, input));

    final value = response;

    if (value is Future<Object?>) {
      return await value as O;
    }

    return value as O;
  }
}
