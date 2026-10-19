import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/features/products/product_draft.dart';

void main() {
  test('product create preserves canonical normalization and zero values', () {
    final draft = ProductDraft(
      customId: ' 0 ',
      name: ' Cement ',
      brand: ' ACME ',
      description: ' ',
      regieReportName: ' Site cement ',
      baseUnit: ' kg ',
      units: const [
        ProductUnitDraft(name: ' bag ', amount: '0'),
        ProductUnitDraft(name: 'pallet', amount: '12,5'),
      ],
    );

    expect(draft.validate(), isEmpty);
    expect(draft.createInput().toWire(), {
      'customId': 0,
      'name': 'Cement',
      'brand': 'ACME',
      'description': null,
      'regieReportName': 'Site cement',
      'baseUnit': 'kg',
      'otherUnits': {'bag': 0.0, 'pallet': 12.5},
    });
    expect(draft.updateInput, throwsStateError);
  });

  test('product edit snapshots units and never sends the immutable number', () {
    final values = <String, num>{'bag': 25};
    final product = models.Product(
      id: 'product-1',
      customId: 12,
      name: 'Cement',
      baseUnit: 'kg',
      otherUnits: models.ApplyPriceImportRowOtherUnits(values),
      categories: const ['Dry goods'],
    );
    final draft = ProductDraft.fromProduct(product);

    values['bag'] = 99;

    expect(draft.units.single.amount, '25');
    expect(() => draft.units.clear(), throwsUnsupportedError);
    expect(draft.updateInput().toWire(), {
      'id': 'product-1',
      'data': {
        'name': 'Cement',
        'brand': null,
        'description': null,
        'regieReportName': null,
        'baseUnit': 'kg',
        'otherUnits': {'bag': 25.0},
      },
    });
    expect(draft.createInput, throwsStateError);
  });

  test('product text validation follows endpoint UTF8 and raw UI limits', () {
    ProductDraft draft(String unit, {bool editing = false}) {
      return ProductDraft(
        productId: editing ? 'product-1' : null,
        customId: '1',
        name: 'Cement',
        baseUnit: unit,
      );
    }

    expect(draft('abcdefgh').validate(), isEmpty);
    expect(
      draft('abcdefghi').validate()['baseUnit'],
      ProductDraftIssue.tooLong,
    );
    expect(draft('abcdefghij', editing: true).validate(), isEmpty);
    expect(
      draft('abcdefghijk', editing: true).validate()['baseUnit'],
      ProductDraftIssue.tooLong,
    );
    expect(draft('éééé').validate(), isEmpty);
    expect(draft('ééééé').validate()['baseUnit'], ProductDraftIssue.tooLong);
    expect(
      draft('                kg').validate()['baseUnit'],
      ProductDraftIssue.tooLong,
    );

    final long = ProductDraft(
      customId: '1',
      name: 'é' * 128,
      brand: 'é' * 64,
      description: 'é' * 256,
      regieReportName: 'é' * 128,
      baseUnit: 'kg',
    );

    expect(
      long.validate().keys,
      containsAll(['name', 'brand', 'description', 'regieReportName']),
    );
    expect(long.createInput, throwsFormatException);
  });

  test(
    'product numbers match zero-inclusive decimal rules and reject overflow',
    () {
      for (final number in ['-1', '1.0', '1e2', '+1', '2147483648']) {
        final draft = ProductDraft(
          customId: number,
          name: 'Cement',
          baseUnit: 'kg',
        );

        expect(
          draft.validate()['customId'],
          ProductDraftIssue.nonnegativeInteger,
        );
      }

      for (final amount in ['-1', '.5', '1e2', 'Infinity', '1,2,3']) {
        final draft = ProductDraft(
          customId: '1',
          name: 'Cement',
          baseUnit: 'kg',
          units: [ProductUnitDraft(name: 'bag', amount: amount)],
        );

        expect(
          draft.validate()['unit:0:value'],
          ProductDraftIssue.nonnegativeNumber,
        );
      }

      expect(
        ProductDraft().validate().keys,
        containsAll(['customId', 'name', 'baseUnit']),
      );
    },
  );

  test(
    'product units snapshot rows and preserve canonical last duplicate wins',
    () {
      final units = [
        const ProductUnitDraft(name: ' bag ', amount: '1'),
        const ProductUnitDraft(name: 'bag', amount: '2,5'),
      ];
      final draft = ProductDraft(
        customId: '1',
        name: 'Cement',
        baseUnit: 'kg',
        units: units,
      );

      units.clear();

      expect(draft.units, hasLength(2));
      expect(draft.createInput().toWire()['otherUnits'], {'bag': 2.5});

      final invalid = ProductDraft(
        productId: '',
        name: 'Cement',
        baseUnit: 'kg',
        units: const [ProductUnitDraft(name: ' ', amount: '')],
      );

      expect(
        invalid.validate().keys,
        containsAll(['id', 'unit:0:name', 'unit:0:value']),
      );
      expect(invalid.updateInput, throwsFormatException);
    },
  );
}
