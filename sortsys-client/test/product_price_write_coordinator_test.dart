import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/features/products/product_price_draft.dart';
import 'package:sortsys_client/features/products/product_price_receipt.dart';
import 'package:sortsys_client/features/products/product_price_write_coordinator.dart';

void main() {
  test(
    'price save persists dispatch and acknowledgement before exact readback',
    () async {
      final store = _Store();
      final access = _Access(store);
      final coordinator = ProductPriceWriteCoordinator(
        access: access,
        receipts: store,
      );

      final record = await coordinator.save(_draft());

      expect(record.id, 'price');
      expect(access.creates, 1);
      expect(access.reads, 1);
      expect(store.events, [
        'read',
        'prepared',
        'dispatching',
        'create',
        'acknowledged',
        'get:price:product',
        'clear',
      ]);
      expect(store.encoded, isNull);
    },
  );

  test(
    'price save does not dispatch when pre-dispatch persistence fails',
    () async {
      final store = _Store()..failWrite = 1;
      final access = _Access(store);
      final coordinator = ProductPriceWriteCoordinator(
        access: access,
        receipts: store,
      );

      await expectLater(coordinator.save(_draft()), throwsStateError);

      expect(access.creates, 0);
      expect(access.reads, 0);
    },
  );

  test(
    'price recovery clears only proven pre-dispatch receipt without replay',
    () async {
      final store = _Store()..failWrite = 2;
      final access = _Access(store);
      final coordinator = ProductPriceWriteCoordinator(
        access: access,
        receipts: store,
      );

      await expectLater(coordinator.save(_draft()), _uncertain());

      expect(access.creates, 0);
      expect((await coordinator.outstanding())!.dispatching, isFalse);
      expect(await coordinator.recover(), isNull);
      expect(access.creates, 0);
      expect(access.reads, 0);
      expect(store.encoded, isNull);
    },
  );

  test(
    'lost price acknowledgement blocks new writes and never infers IDs',
    () async {
      final store = _Store();
      final access = _Access(store)..loseAcknowledgement = true;
      final coordinator = ProductPriceWriteCoordinator(
        access: access,
        receipts: store,
      );

      await expectLater(coordinator.save(_draft()), _uncertain());
      await expectLater(coordinator.recover(), _uncertain());
      await expectLater(coordinator.save(_draft()), _outstanding());

      expect(access.creates, 1);
      expect(access.reads, 0);
      expect((await coordinator.outstanding())!.dispatching, isTrue);
    },
  );

  test(
    'price acknowledgement persistence failure does not read or replay',
    () async {
      final store = _Store()..failWrite = 3;
      final access = _Access(store);
      final coordinator = ProductPriceWriteCoordinator(
        access: access,
        receipts: store,
      );

      await expectLater(coordinator.save(_draft()), _uncertain());
      await expectLater(coordinator.recover(), _uncertain());

      expect(access.creates, 1);
      expect(access.reads, 0);
      expect((await coordinator.outstanding())!.acknowledgement, isNull);
    },
  );

  test(
    'price readback mismatch retains confirmed receipt for read-only retry',
    () async {
      final store = _Store();
      final access = _Access(store)..wrongRecord = true;
      final coordinator = ProductPriceWriteCoordinator(
        access: access,
        receipts: store,
      );

      await expectLater(coordinator.save(_draft()), _uncertain());

      final receipt = (await coordinator.outstanding())!;

      expect(receipt.acknowledgement?.id, 'price');
      await expectLater(
        coordinator.recover(expectedNonce: 'different'),
        _outstanding(),
      );

      expect(access.reads, 1);
      access.wrongRecord = false;
      final record = await coordinator.recover(expectedNonce: receipt.nonce);

      expect(record?.id, 'price');
      expect(access.creates, 1);
      expect(access.reads, 2);
      expect(store.encoded, isNull);
    },
  );

  test(
    'price permission revocation during persistence prevents dispatch',
    () async {
      final store = _Store();
      final access = _Access(store);
      store.afterWrite = () {
        if (store.writes == 2) {
          access.canCreate = false;
        }
      };
      final coordinator = ProductPriceWriteCoordinator(
        access: access,
        receipts: store,
      );

      await expectLater(coordinator.save(_draft()), _uncertain());

      expect(access.creates, 0);
      expect(access.reads, 0);
      expect((await coordinator.outstanding())!.dispatching, isTrue);
    },
  );

  test(
    'price scope change after submission preserves receipt and blocks readback',
    () async {
      final store = _Store();
      final access = _Access(store)..changeScopeAfterCreate = true;
      final coordinator = ProductPriceWriteCoordinator(
        access: access,
        receipts: store,
      );

      await expectLater(coordinator.save(_draft()), _uncertain());

      expect(access.creates, 1);
      expect(access.reads, 0);
      expect(store.encoded, isNotNull);
      expect(store.events.contains('clear'), isFalse);
    },
  );

  test(
    'verified price survives receipt cleanup failure without resubmission',
    () async {
      for (final clearBeforeFailure in [false, true]) {
        final store = _Store()
          ..failClear = true
          ..clearBeforeFailure = clearBeforeFailure;
        final access = _Access(store);
        final coordinator = ProductPriceWriteCoordinator(
          access: access,
          receipts: store,
        );

        await expectLater(
          coordinator.save(_draft()),
          throwsA(
            isA<ProductPriceWriteException>()
                .having(
                  (error) => error.failure,
                  'failure',
                  ProductPriceWriteFailure.cleanup,
                )
                .having(
                  (error) => error.confirmedRecord?.id,
                  'verified record',
                  'price',
                ),
          ),
        );

        if (clearBeforeFailure) {
          expect(store.encoded, isNull);
        } else {
          expect(store.encoded, isNotNull);
          store.failClear = false;

          final record = await coordinator.recover();

          expect(record?.id, 'price');
        }

        expect(access.creates, 1);
        expect(access.reads, clearBeforeFailure ? 1 : 2);
      }
    },
  );
}

Matcher _uncertain() {
  return throwsA(
    isA<ProductPriceWriteException>().having(
      (error) => error.failure,
      'failure',
      ProductPriceWriteFailure.uncertain,
    ),
  );
}

Matcher _outstanding() {
  return throwsA(
    isA<ProductPriceWriteException>().having(
      (error) => error.failure,
      'failure',
      ProductPriceWriteFailure.outstanding,
    ),
  );
}

ProductPriceDraft _draft() {
  return ProductPriceDraft(
    product: models.Product(
      id: 'product',
      customId: 1,
      name: 'Product',
      baseUnit: 'kg',
      otherUnits: const models.ApplyPriceImportRowOtherUnits({}),
      categories: const [],
    ),
    totalPrice: '10',
    amount: '2',
    date: DateTime.utc(2024, 2, 3),
    comment: ' invoice ',
  );
}

final class _Store implements ProductPriceReceiptStore {
  final events = <String>[];
  String? encoded;
  int writes = 0;
  int? failWrite;
  bool failClear = false;
  bool clearBeforeFailure = false;
  void Function()? afterWrite;

  @override
  Future<ProductPriceWriteReceipt?> read(String scope) async {
    events.add('read');
    final value = encoded;

    return value == null ? null : ProductPriceWriteReceipt.decode(value);
  }

  @override
  Future<void> write(ProductPriceWriteReceipt receipt) async {
    writes++;

    if (writes == failWrite) {
      throw StateError('storage unavailable');
    }

    encoded = receipt.encode();
    events.add(
      receipt.acknowledgement != null
          ? 'acknowledged'
          : receipt.dispatching
          ? 'dispatching'
          : 'prepared',
    );
    afterWrite?.call();
  }

  @override
  Future<void> clear(String scope) async {
    events.add('clear');

    if (clearBeforeFailure) {
      encoded = null;
    }

    if (failClear) {
      throw StateError('receipt cleanup unavailable');
    }

    encoded = null;
  }
}

final class _Access implements ProductPriceWriteAccess {
  _Access(this.store);

  final _Store store;
  String owner = 'scope';
  bool canCreate = true;
  bool loseAcknowledgement = false;
  bool wrongRecord = false;
  bool changeScopeAfterCreate = false;
  int creates = 0;
  int reads = 0;
  models.ProductsPriceRecordsCreateInput? submitted;

  @override
  String get scope {
    return owner;
  }

  @override
  void checkCurrent() {}

  @override
  void checkCreate(models.ProductsPriceRecordsCreateInput input) {
    if (!canCreate || input.productId != 'product') {
      throw StateError('permission or owner changed');
    }
  }

  @override
  Future<models.ProductsPriceRecordsCreateOutput> createPrice(
    models.ProductsPriceRecordsCreateInput input,
  ) async {
    creates++;
    submitted = input;
    store.events.add('create');

    if (loseAcknowledgement) {
      throw StateError('connection lost');
    }

    if (changeScopeAfterCreate) {
      owner = 'other';
    }

    return const models.ProductsPriceRecordsCreateOutput(id: 'price');
  }

  @override
  Future<models.ProductsPriceRecordsListResultItem?> priceRecord(
    String recordId,
    String productId,
  ) async {
    reads++;
    store.events.add('get:$recordId:$productId');
    final input = submitted!;

    return models.ProductsPriceRecordsListResultItem(
      id: wrongRecord ? 'foreign' : recordId,
      productId: input.productId,
      timestamp: input.timestamp,
      price: input.pricePerBaseUnit,
      isRealPurchase: input.isRealPurchase,
      comment: input.comment.valueOrNull!.trim(),
    );
  }
}
