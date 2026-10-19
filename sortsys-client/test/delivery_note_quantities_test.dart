import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/features/delivery_notes/delivery_note_quantities.dart';

void main() {
  test('automatic delivery units use largest quarter-compatible factor and name ties', () {
    final units = <String, num>{'z': 8, 'a': 8, 'bag': 4, 'zero': 0};
    final product = _product(units);

    expect(upmatchedDeliveryQuantity(product, 10), (amount: 1.25, unit: 'a'));
    expect(upmatchedDeliveryQuantity(product, 3), (amount: 3, unit: 'kg'));
    expect(upmatchedDeliveryQuantity(product, 0), (amount: 0, unit: 'kg'));
    expect(upmatchedDeliveryQuantity(product, -8), (amount: -8, unit: 'kg'));
    expect(upmatchedDeliveryQuantity(null, 10), (amount: 10, unit: ''));
    expect(
      upmatchedDeliveryQuantity(product, double.infinity).amount,
      double.infinity,
    );
    expect(units.keys, ['z', 'a', 'bag', 'zero']);
  });

  test(
    'automatic delivery units retain JavaScript rounding for large ratios',
    () {
      expect(upmatchedDeliveryQuantity(_product({'bag': 4}), 1e100), (
        amount: 2.5e99,
        unit: 'bag',
      ));
      expect(upmatchedDeliveryQuantity(_product({'tiny': 1e-300}), 1e300), (
        amount: 1e300,
        unit: 'kg',
      ));
      expect(upmatchedDeliveryQuantity(_product({'single': 1}), 1e308), (
        amount: 1e308,
        unit: 'kg',
      ));
      expect(upmatchedDeliveryQuantity(_product({'bag': 4}), 1e308), (
        amount: 2.5e307,
        unit: 'bag',
      ));
    },
  );

  test('explicit delivery units preserve identity and fall back only for missing or zero factors', () {
    final product = _product({'bag': 4, 'zero': 0, ' spaced ': 2});

    expect(deliveryQuantityInUnit(product, 10, 'kg'), (amount: 10, unit: 'kg'));
    expect(deliveryQuantityInUnit(product, 10, 'bag'), (
      amount: 2.5,
      unit: 'bag',
    ));
    expect(deliveryQuantityInUnit(product, 10, ' spaced '), (
      amount: 5,
      unit: ' spaced ',
    ));

    for (final unit in [null, '', 'missing', 'zero']) {
      expect(deliveryQuantityInUnit(product, 10, unit), (
        amount: 2.5,
        unit: 'bag',
      ));
    }
  });

  test('delivery quantity text trims only displayed units and localizes two to four decimals', () {
    expect(formatDeliveryProductAmount(12.5, ' kg ', 'en'), '12.50 kg');
    expect(formatDeliveryProductAmount(12.5, ' kg ', 'de'), '12,50 kg');
    expect(formatDeliveryProductAmount(1.23456, '', 'en'), '1.2346');
    expect(formatDeliveryBaseQuantity(12, ' kg ', 'kg', 'en'), '-');
    expect(formatDeliveryBaseQuantity(12, ' kg ', 'bag', 'en'), '12.00 kg');
    expect(formatDeliveryBaseQuantity(12, '', 'bag', 'de'), '12,00');
  });

  test('delivery record costs preserve missing prices zero and on-screen average semantics', () {
    final costs = models.DeliveryNotesCostsGetOutput(
      noteId: 'note',
      totalCost: 0,
      specialRecords: const [],
      records: [
        const models.DeliveryNotesCostsGetResultRecordsItem(
          recordId: 'missing-price',
          productId: 'product',
          quantity: 2,
        ),
        models.DeliveryNotesCostsGetResultRecordsItem(
          recordId: 'priced',
          productId: 'product',
          quantity: 4,
          priceRecord: models.ProductsPriceRecordsListResultItem(
            id: 'price',
            productId: 'product',
            timestamp: DateTime.utc(2024),
            price: 3,
            isRealPurchase: true,
          ),
        ),
      ],
    );

    expect(deliveryRecordCost(null, 'priced'), isNull);
    expect(deliveryRecordCost(costs, 'unknown'), isNull);
    expect(deliveryRecordCost(costs, 'missing-price'), isNull);
    expect(deliveryRecordCost(costs, 'priced'), 12);
    expect(deliveryAverageUnitPrice(costs, 'priced', 0), isNull);
    expect(deliveryAverageUnitPrice(costs, 'priced', 4), 3);
    expect(deliveryAverageUnitPrice(costs, 'priced', -4), -3);
  });
}

models.Product _product(Map<String, num> units) {
  return models.Product(
    id: 'product',
    customId: 1,
    name: 'Product',
    baseUnit: 'kg',
    otherUnits: models.ApplyPriceImportRowOtherUnits(units),
    categories: const [],
  );
}
