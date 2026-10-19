import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/features/delivery_notes/delivery_note_form_values.dart';

void main() {
  test(
    'delivery create form starts with one product and the supplied date',
    () {
      final date = DateTime.utc(2025, 2, 3);
      final values = DeliveryNoteFormValues.create(
        project: _project(),
        date: date,
      );
      addTearDown(values.dispose);

      expect(values.noteId, isNull);
      expect(values.date, date);
      expect(values.records, hasLength(1));
      expect(values.specialRecords, isEmpty);
      expect(values.records.single.product, isNull);
      expect(values.records.single.unit, isNull);
      final row = values.records.single;
      row.selectProduct(_product('product'));
      row.amount.text = '2,5';
      row.unit = 'bag';
      row.comment.text = ' Line ';
      values.comment.text = ' Header ';

      expect(values.draft().validate(), isEmpty);
      expect(values.draft().createInput().toWire()['records'], [
        {
          'productId': 'product',
          'quantity': 10.0,
          'unit': 'bag',
          'comment': 'Line',
        },
      ]);
    },
  );

  test(
    'delivery product unit selection keeps valid units or selects the first',
    () {
      final row = DeliveryProductLineValues();
      addTearDown(row.dispose);
      row.selectProduct(_product('first'));

      expect(row.units, ['kg', 'bag']);
      expect(row.unit, 'kg');
      row.unit = 'bag';
      row.selectProduct(_product('second', base: 'm', units: {'bag': 8}));

      expect(row.unit, 'bag');
      row.selectProduct(_product('third', base: 'hr', units: {'day': 8}));

      expect(row.unit, 'hr');
      row.selectProduct(null);

      expect(row.units, isEmpty);
      expect(row.unit, isNull);
    },
  );

  test(
    'delivery edit prefills selected quantities and rejects wrong references',
    () {
      final note = _note();
      final values = DeliveryNoteFormValues.edit(
        note,
        project: _project(),
        products: {'product': _product('product')},
      );
      addTearDown(values.dispose);

      expect(values.noteId, 'note');
      expect(values.date, isNull);
      expect(values.comment.text, ' Header ');
      expect(values.records.single.amount.text, '2.5');
      expect(values.records.single.unit, 'bag');
      expect(values.records.single.comment.text, '');
      expect(values.specialRecords.single.name.text, ' Service ');
      expect(values.specialRecords.single.pricePerUnit.text, '0');
      expect(values.specialRecords.single.comment.text, '');
      expect(values.draft().validate(), isEmpty);
      final input = values.draft().updateInput().toWire();
      final data = input['data'] as Map<String, Object?>;

      expect(data.containsKey('effectiveTimestamp'), isFalse);
      expect(data['records'], [
        {'productId': 'product', 'quantity': 10.0, 'unit': 'bag'},
      ]);
      final missing = DeliveryNoteFormValues.edit(
        note,
        project: _project('wrong'),
        products: {'product': _product('wrong')},
      );
      addTearDown(missing.dispose);

      expect(missing.project, isNull);
      expect(missing.records.single.product, isNull);
      expect(missing.records.single.amount.text, '10');
      expect(missing.records.single.unit, isNull);
      expect(missing.draft().validate(), contains('record:0:product'));
      expect(
        () => DeliveryNoteFormValues.edit(_note(owner: 'wrong')),
        throwsFormatException,
      );
    },
  );

  test('removed delivery rows retain controllers until form disposal', () {
    final values = DeliveryNoteFormValues.create(date: DateTime.utc(2025));
    final product = values.records.single;
    final special = DeliverySpecialLineValues(name: 'Service');
    values.specialRecords.add(special);
    values.removeProduct(product);
    values.removeProduct(product);
    values.removeSpecial(special);
    values.removeSpecial(special);
    product.amount.text = '2';
    special.name.text = 'Still attached';

    expect(values.records, isEmpty);
    expect(values.specialRecords, isEmpty);
    expect(product.amount.text, '2');
    expect(special.name.text, 'Still attached');
    expect(values.draft().validate(), contains('records'));
    values.dispose();

    expect(() => product.amount.addListener(_listener), throwsFlutterError);
    expect(() => special.name.addListener(_listener), throwsFlutterError);
  });
}

void _listener() {}

models.Product _product(
  String id, {
  String base = 'kg',
  Map<String, num> units = const {'bag': 4},
}) {
  return models.Product(
    id: id,
    customId: 0,
    name: 'Product',
    baseUnit: base,
    otherUnits: models.ApplyPriceImportRowOtherUnits(units),
    categories: const [],
  );
}

models.Project _project([String id = 'project']) {
  return models.Project(
    id: id,
    title: 'Project',
    createdAt: DateTime.utc(2025),
    modifiedAt: DateTime.utc(2025),
  );
}

models.DeliveryNote _note({String owner = 'note'}) {
  return models.DeliveryNote(
    id: 'note',
    autoId: 0,
    projectId: 'project',
    createdAt: DateTime.utc(2025),
    effectiveTimestamp: DateTime.utc(2025),
    comment: ' Header ',
    records: [
      models.DeliveryNoteRecordsItem(
        id: 'record',
        noteId: owner,
        productId: 'product',
        quantity: 10,
        unit: 'bag',
        comment: 'Original line',
      ),
    ],
    specialRecords: [
      models.DeliveryNoteSpecialRecordsItem(
        id: 'special',
        noteId: owner,
        name: ' Service ',
        unit: 'hr',
        amount: 2,
        pricePerUnit: 0,
        comment: 'Original special',
      ),
    ],
  );
}
