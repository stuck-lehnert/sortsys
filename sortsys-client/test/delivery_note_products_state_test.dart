import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/features/delivery_notes/delivery_note_products_state.dart';

void main() {
  test('delivery products validate first URL values and sortable indices', () {
    final uri = Uri.parse('/products/deliveryNotes/n').replace(
      queryParameters: {
        'pageProducts': ['2', '9'],
        'pageSizeProducts': ['50', '100'],
        'sortProducts': [
          jsonEncode([3, 'DESC']),
          jsonEncode([4, 'ASC']),
        ],
      },
    );
    final state = DeliveryNoteProductsState.fromUri(uri);

    expect(state.page, 2);
    expect(state.pageSize, 50);
    expect(state.column, DeliveryProductSort.averagePrice);
    expect(state.descending, isTrue);

    for (final sorting in [
      'invalid',
      '[0,"ASC"]',
      '[2,"DESC"]',
      '[5,"ASC"]',
      '[3.0,"ASC"]',
      '[3,"asc"]',
      '[4,"DESC",0]',
    ]) {
      final invalid = DeliveryNoteProductsState.fromUri(
        uri.replace(
          queryParameters: {
            'pageProducts': '-2',
            'pageSizeProducts': '30',
            'sortProducts': sorting,
          },
        ),
      );

      expect(invalid.page, 0);
      expect(invalid.pageSize, 25);
      expect(invalid.column, isNull);
      expect(invalid.descending, isFalse);
    }
  });

  test(
    'delivery product URL changes keep unrelated values and cycle sorting',
    () {
      var uri = Uri.parse('/products/deliveryNotes/n?keep=a&keep=b#records');
      var state = DeliveryNoteProductsState.fromUri(uri);
      uri = state.apply(
        uri,
        page: 2,
        pageSize: 50,
        toggleColumn: DeliveryProductSort.cost,
      );
      state = DeliveryNoteProductsState.fromUri(uri);

      expect(uri.queryParametersAll['keep'], ['a', 'b']);
      expect(uri.fragment, 'records');
      expect(uri.queryParameters['sortProducts'], '[4,"ASC"]');
      expect(state.page, 2);
      expect(state.pageSize, 50);
      uri = state.apply(
        uri,
        pageSize: 100,
        toggleColumn: DeliveryProductSort.cost,
      );
      state = DeliveryNoteProductsState.fromUri(uri);

      expect(state.page, 2);
      expect(state.pageSize, 100);
      expect(uri.queryParameters['sortProducts'], '[4,"DESC"]');
      uri = state.apply(
        uri,
        page: 0,
        pageSize: 25,
        toggleColumn: DeliveryProductSort.cost,
      );

      expect(uri.queryParametersAll, {
        'keep': ['a', 'b'],
      });
      expect(uri.fragment, 'records');
    },
  );

  test('delivery product costs sort stably without changing server order', () {
    final records = [
      _record('priced', quantity: 2),
      _record('missing', quantity: 1),
      _record('zero', quantity: 0),
      _record('tie', quantity: 2),
    ];
    final costs = models.DeliveryNotesCostsGetOutput(
      noteId: 'note',
      totalCost: 12,
      specialRecords: const [],
      records: [
        for (final id in ['priced', 'tie'])
          models.DeliveryNotesCostsGetResultRecordsItem(
            recordId: id,
            productId: 'product',
            quantity: 2,
            priceRecord: models.ProductsPriceRecordsListResultItem(
              id: 'price-$id',
              productId: 'product',
              timestamp: DateTime.utc(2024),
              price: 3,
              isRealPurchase: true,
            ),
          ),
      ],
    );

    for (final column in DeliveryProductSort.values) {
      final sorted = sortedDeliveryProducts(
        records,
        costs,
        DeliveryNoteProductsState(column: column),
      );
      final descending = sortedDeliveryProducts(
        records,
        costs,
        DeliveryNoteProductsState(column: column, descending: true),
      );

      expect(sorted.map((row) => row.id), ['missing', 'zero', 'priced', 'tie']);
      expect(descending.map((row) => row.id), [
        'priced',
        'tie',
        'missing',
        'zero',
      ]);
    }

    expect(
      sortedDeliveryProducts(
        records,
        null,
        const DeliveryNoteProductsState(column: DeliveryProductSort.cost),
      ),
      orderedEquals(records),
    );
    final reset = sortedDeliveryProducts(
      records,
      costs,
      const DeliveryNoteProductsState(),
    );

    expect(reset, orderedEquals(records));
    expect(identical(reset, records), isFalse);
    expect(records.map((row) => row.id), ['priced', 'missing', 'zero', 'tie']);
  });
}

models.DeliveryNoteRecordsItem _record(String id, {required num quantity}) {
  return models.DeliveryNoteRecordsItem(
    id: id,
    noteId: 'note',
    productId: 'product',
    quantity: quantity,
    unit: 'kg',
  );
}
