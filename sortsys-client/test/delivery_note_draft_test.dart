import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/features/delivery_notes/delivery_note_draft.dart';

void main() {
  test('delivery create preserves signed comma quantities and zero prices', () {
    final date = DateTime.utc(2025, 2, 3);
    final draft = DeliveryNoteDraft(
      projectId: 'project',
      deliveryDate: date,
      comment: ' Header ',
      records: [_line(amount: '-2,5', comment: ' Product comment ')],
      specialRecords: const [
        DeliverySpecialLineDraft(
          name: ' Service ',
          amount: '1,5',
          unit: ' hr ',
          pricePerUnit: '0',
          comment: ' ',
        ),
      ],
    );

    expect(draft.validate(), isEmpty);
    expect(draft.createInput().toWire(), {
      'projectId': 'project',
      'effectiveTimestamp': date,
      'comment': 'Header',
      'records': [
        {
          'productId': 'product',
          'quantity': -10.0,
          'unit': 'bag',
          'comment': 'Product comment',
        },
      ],
      'specialRecords': [
        {
          'name': ' Service ',
          'unit': ' hr ',
          'amount': 1.5,
          'pricePerUnit': 0.0,
          'comment': null,
        },
      ],
    });
    expect(draft.updateInput, throwsStateError);
  });

  test('delivery edit omits date and line comments but retains raw header', () {
    final draft = DeliveryNoteDraft(
      noteId: 'note',
      projectId: 'project',
      deliveryDate: DateTime.utc(2030),
      comment: ' Header ',
      records: [_line(amount: '1', comment: 'ignored')],
      specialRecords: const [
        DeliverySpecialLineDraft(
          name: 'Service',
          amount: '-2',
          unit: 'hr',
          comment: 'ignored',
        ),
      ],
    );

    expect(draft.validate(), isEmpty);
    expect(draft.updateInput().toWire(), {
      'id': 'note',
      'data': {
        'projectId': 'project',
        'comment': ' Header ',
        'records': [
          {'productId': 'product', 'quantity': 4.0, 'unit': 'bag'},
        ],
        'specialRecords': [
          {
            'name': 'Service',
            'unit': 'hr',
            'amount': -2.0,
            'pricePerUnit': null,
          },
        ],
      },
    });
    expect(draft.createInput, throwsStateError);
  });

  test(
    'delivery numeric validation rejects zero malformed and overflow values',
    () {
      for (final amount in [
        '0',
        '-0',
        '+1',
        '1e3',
        '.5',
        '1.',
        'NaN',
        '1,2,3',
      ]) {
        final draft = _draft(records: [_line(amount: amount)]);

        expect(draft.validate(), contains('record:0:amount'), reason: amount);
        expect(draft.createInput, throwsStateError);
      }

      final zeroFactor = _draft(
        records: [
          _line(amount: '2', units: {'bag': 0}),
        ],
      );
      final overflow = _draft(
        records: [
          _line(amount: '10', units: {'bag': 1e308}),
        ],
      );

      expect(zeroFactor.validate(), isEmpty);
      expect(zeroFactor.createInput().toWire()['records'], [
        {
          'productId': 'product',
          'quantity': 0.0,
          'unit': 'bag',
          'comment': null,
        },
      ]);
      expect(overflow.validate(), contains('record:0:amount'));
      expect(
        _draft(records: [_line(unit: 'missing')]).validate(),
        contains('record:0:unit'),
      );
    },
  );

  test(
    'delivery drafts enforce endpoint UTF8 and required selection limits',
    () {
      final fitting = _draft(comment: List.filled(255, 'ä').join());
      final oversized = _draft(comment: List.filled(256, 'ä').join());

      expect(fitting.validate(), isEmpty);
      expect(oversized.validate(), contains('comment'));
      expect(
        _draft(records: [_line(comment: List.filled(128, 'ä').join())])
            .validate(),
        contains('record:0:comment'),
      );

      final special = DeliveryNoteDraft(
        projectId: '',
        records: const [],
        specialRecords: [
          DeliverySpecialLineDraft(
            name: List.filled(128, 'ä').join(),
            amount: '0',
            unit: List.filled(17, 'ä').join(),
            pricePerUnit: '+1',
            comment: List.filled(128, 'ä').join(),
          ),
        ],
      );

      expect(
        special.validate().keys,
        containsAll([
          'project',
          'deliveryDate',
          'specialRecord:0:name',
          'specialRecord:0:amount',
          'specialRecord:0:unit',
          'specialRecord:0:pricePerUnit',
          'specialRecord:0:comment',
        ]),
      );
      expect(_draft(records: const []).validate(), contains('records'));
    },
  );

  test('delivery drafts snapshot rows and selected unit factors', () {
    final units = <String, num>{'bag': 4};
    final lines = [_line(units: units)];
    final draft = _draft(records: lines);
    units['bag'] = 99;
    lines.clear();

    expect(draft.records, hasLength(1));
    expect(draft.records.single.product!.otherUnits['bag'], 4);
    expect(() => draft.records.clear(), throwsUnsupportedError);
    expect(() => draft.specialRecords.clear(), throwsUnsupportedError);
    expect(
      () => draft.records.single.product!.otherUnits.clear(),
      throwsUnsupportedError,
    );
    expect(draft.createInput().toWire()['records'], [
      {'productId': 'product', 'quantity': 4.0, 'unit': 'bag', 'comment': null},
    ]);
  });
}

DeliveryNoteDraft _draft({
  List<DeliveryProductLineDraft>? records,
  String comment = '',
}) {
  return DeliveryNoteDraft(
    projectId: 'project',
    deliveryDate: DateTime.utc(2025),
    comment: comment,
    records: records ?? [_line()],
    specialRecords: const [],
  );
}

DeliveryProductLineDraft _line({
  String amount = '1',
  String unit = 'bag',
  String comment = '',
  Map<String, num> units = const {'bag': 4},
}) {
  return DeliveryProductLineDraft(
    product: DeliveryProductSelection(
      models.Product(
        id: 'product',
        customId: 0,
        name: 'Product',
        baseUnit: 'kg',
        otherUnits: models.ApplyPriceImportRowOtherUnits(units),
        categories: const [],
      ),
    ),
    amount: amount,
    unit: unit,
    comment: comment,
  );
}
