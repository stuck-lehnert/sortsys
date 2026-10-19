import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/features/products/product_price_draft.dart';

void main() {
  test('price entry preserves signed comma conversion and canonical wire input', () {
    final draft = ProductPriceDraft(
      product: _product({'bag': 4}),
      totalPrice: ' -30,0 ',
      amount: ' 1,5 ',
      unit: 'bag',
      date: DateTime(2024, 2, 3, 19, 24),
      comment: '  invoice note  ',
    );

    expect(draft.validate(), isEmpty);
    expect(draft.pricePerBaseUnit, -5);
    expect(draft.createInput().toWire(), {
      'productId': 'product',
      'pricePerBaseUnit': -5,
      'timestamp': DateTime(2024, 2, 3),
      'isRealPurchase': false,
      'comment': '  invoice note  ',
    });
    expect(draft.createInput().toWire().containsKey('vendorId'), isFalse);
  });

  test('price units snapshot raw identity and retain zero and base-unit priority', () {
    final units = <String, num>{' bag ': 4, 'kg': 999};
    final draft = ProductPriceDraft(
      product: _product(units), totalPrice: '0', amount: '2',
      unit: ' bag ', date: DateTime(2024), isRealPurchase: true,
    );
    units[' bag '] = 8;
    units['new'] = 3;

    expect(draft.units, ['kg', ' bag ', 'kg']);
    expect(draft.otherUnits[' bag '], 4);
    expect(() => draft.otherUnits['new'] = 3, throwsUnsupportedError);
    expect(() => draft.units.add('new'), throwsUnsupportedError);
    expect(draft.createInput().pricePerBaseUnit, 0);
    expect(draft.createInput().isRealPurchase, isTrue);
    expect(draft.createInput().toWire()['comment'], '');

    final base = ProductPriceDraft(
      product: _product({'kg': 999}), totalPrice: '10', amount: '2',
      date: DateTime(2024),
    );

    expect(base.unit, 'kg');
    expect(base.createInput().pricePerBaseUnit, 5);
  });

  test('price entry validates required values exact decimal grammar and unit conversion', () {
    final empty = ProductPriceDraft(product: _product({}));

    expect(empty.validate(), {
      'price': ProductPriceDraftIssue.required,
      'amount': ProductPriceDraftIssue.required,
      'date': ProductPriceDraftIssue.required,
    });
    expect(empty.createInput, throwsStateError);

    for (final invalid in ['.5', '1.', '+2', '1e2', 'NaN', 'Infinity']) {
      final draft = ProductPriceDraft(
        product: _product({}), totalPrice: invalid, amount: '2',
        date: DateTime(2024),
      );

      expect(draft.validate()['price'], ProductPriceDraftIssue.number);
      expect(draft.createInput, throwsStateError);
    }

    for (final quantity in ['-1', '.5', '1.', '+2', '1e2']) {
      final draft = ProductPriceDraft(
        product: _product({}), totalPrice: '2', amount: quantity,
        date: DateTime(2024),
      );

      expect(draft.validate()['amount'], ProductPriceDraftIssue.nonnegativeNumber);
    }

    for (final unit in ['zero', 'missing']) {
      final draft = ProductPriceDraft(
        product: _product({'zero': 0}), totalPrice: '2', amount: '1',
        unit: unit, date: DateTime(2024),
      );

      expect(draft.validate(), isNotEmpty);
      expect(draft.createInput, throwsStateError);
    }

    final zero = ProductPriceDraft(
      product: _product({}), totalPrice: '2', amount: '0', date: DateTime(2024),
    );

    expect(zero.validate()['price'], ProductPriceDraftIssue.finitePrice);
    expect(zero.createInput, throwsStateError);
  });

  test('price comments use trimmed UTF-8 limits but preserve raw wire content', () {
    final accepted = '  ${List.filled(127, 'é').join()}  ';
    final rejected = List.filled(128, 'é').join();
    final valid = ProductPriceDraft(
      product: _product({}), totalPrice: '2', amount: '1',
      date: DateTime(2024), comment: accepted,
    );
    final invalid = ProductPriceDraft(
      product: _product({}), totalPrice: '2', amount: '1',
      date: DateTime(2024), comment: rejected,
    );

    expect(valid.createInput().toWire()['comment'], accepted);
    expect(invalid.validate()['comment'], ProductPriceDraftIssue.tooLong);
    expect(invalid.createInput, throwsStateError);
    expect(() => invalid.validate()['date'] = ProductPriceDraftIssue.required,
      throwsUnsupportedError);
  });

  test('price arithmetic rejects nonfinite results and preserves finite overflow fallback', () {
    final large = '1${List.filled(308, '0').join()}';
    final small = '0,${List.filled(307, '0').join()}1';
    final overflow = ProductPriceDraft(
      product: _product({}), totalPrice: large, amount: small,
      date: DateTime(2024),
    );
    final finite = ProductPriceDraft(
      product: _product({'bag': 4}), totalPrice: '2', amount: large,
      unit: 'bag', date: DateTime(2024),
    );

    expect(overflow.validate()['price'], ProductPriceDraftIssue.finitePrice);
    expect(overflow.createInput, throwsStateError);
    expect(finite.createInput().pricePerBaseUnit, 0);
  });
}

models.Product _product(Map<String, num> units) {
  return models.Product(
    id: 'product', customId: 1, name: 'Product', baseUnit: 'kg',
    otherUnits: models.ApplyPriceImportRowOtherUnits(units), categories: const [],
  );
}
