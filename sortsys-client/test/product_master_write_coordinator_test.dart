import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/features/products/product_draft.dart';
import 'package:sortsys_client/features/products/product_master_inputs.dart';
import 'package:sortsys_client/features/products/product_master_receipt.dart';
import 'package:sortsys_client/features/products/product_master_write_access.dart';
import 'package:sortsys_client/features/products/product_master_write_coordinator.dart';

void main() {
  test(
    'product save journals each stage before one create and readback',
    () async {
      final fixture = _Fixture();
      final product = await fixture.coordinator.save(_draft());

      expect(product.name, 'After');
      expect(product.otherUnits.values, {'box': 2});
      expect(fixture.access.creates, 1);
      expect(fixture.access.updates, 0);
      expect(fixture.store.events, [
        'read',
        'prepared',
        'dispatching',
        'create',
        'acknowledged',
        'get:product',
        'clear',
      ]);
      expect(fixture.store.encoded, isNull);
    },
  );

  test(
    'product edit checks fresh baseline and verifies known changed fields',
    () async {
      final fixture = _Fixture();
      final baseline = fixture.access.product;
      final product = await fixture.coordinator.save(
        _draft(update: true),
        baseline: baseline,
      );

      expect(product.id, baseline.id);
      expect(product.customId, baseline.customId);
      expect(product.name, 'After');
      expect(product.otherUnits.values, {'box': 2});
      expect(fixture.access.creates, 0);
      expect(fixture.access.updates, 1);
      expect(fixture.access.reads, 2);
      expect(fixture.store.encoded, isNull);
    },
  );

  test(
    'product conflict and unchanged edits neither journal nor mutate',
    () async {
      final fixture = _Fixture();
      final baseline = fixture.access.product;
      fixture.access.product = _product(name: 'Concurrent change');

      await expectLater(
        fixture.coordinator.save(_draft(update: true), baseline: baseline),
        _fails(ProductMasterWriteFailure.conflict),
      );
      fixture.access.product = baseline;
      final product = await fixture.coordinator.save(
        ProductDraft.fromProduct(baseline),
        baseline: baseline,
      );

      expect(product.name, 'Before');
      expect(fixture.store.writes, 0);
      expect(fixture.access.creates, 0);
      expect(fixture.access.updates, 0);
    },
  );

  test(
    'product lost acknowledgements never replay create or known-ID edit',
    () async {
      for (final update in [false, true]) {
        final fixture = _Fixture();
        final baseline = fixture.access.product;
        fixture.access.loseAcknowledgement = true;

        await expectLater(
          fixture.coordinator.save(
            _draft(update: update),
            baseline: update ? baseline : null,
          ),
          _fails(ProductMasterWriteFailure.uncertain),
        );
        final receipt = (await fixture.coordinator.outstanding())!;

        if (update) {
          fixture.access.manage = false;
          final recovered = await fixture.coordinator.recover(
            expectedNonce: receipt.nonce,
          );

          expect(recovered?.name, 'After');
          expect(recovered?.otherUnits.values, {'box': 2});
          expect(fixture.access.updates, 1);
          expect(fixture.access.creates, 0);
          expect(fixture.access.reads, 2);
        } else {
          await expectLater(
            fixture.coordinator.recover(expectedNonce: receipt.nonce),
            _fails(ProductMasterWriteFailure.uncertain),
          );
          await expectLater(
            fixture.coordinator.save(_draft()),
            _fails(ProductMasterWriteFailure.outstanding),
          );

          expect(fixture.access.creates, 1);
          expect(fixture.access.reads, 0);
          expect(fixture.store.encoded, isNotNull);
        }
      }
    },
  );

  test(
    'product storage boundaries retain unsent or uncertain evidence',
    () async {
      for (final failedWrite in [1, 2, 3]) {
        for (final afterWrite in [false, true]) {
          final fixture = _Fixture();
          fixture.store.failWrite = failedWrite;
          fixture.store.failAfterWrite = afterWrite;

          await expectLater(
            fixture.coordinator.save(_draft()),
            failedWrite == 1
                ? throwsStateError
                : _fails(ProductMasterWriteFailure.uncertain),
          );

          expect(fixture.access.creates, failedWrite == 3 ? 1 : 0);
          expect(fixture.access.reads, 0);
          final receipt = await fixture.coordinator.outstanding();

          if (receipt == null) {
            expect(failedWrite, 1);
            expect(afterWrite, isFalse);
            continue;
          }

          if (!receipt.dispatching && !receipt.acknowledged) {
            expect(
              await fixture.coordinator.recover(expectedNonce: receipt.nonce),
              isNull,
            );
            expect(fixture.access.creates, 0);
            expect(fixture.store.encoded, isNull);
          } else if (receipt.acknowledged) {
            final recovered = await fixture.coordinator.recover(
              expectedNonce: receipt.nonce,
            );

            expect(recovered?.id, 'product');
            expect(fixture.access.creates, 1);
            expect(fixture.access.reads, 1);
          } else {
            await expectLater(
              fixture.coordinator.recover(expectedNonce: receipt.nonce),
              _fails(ProductMasterWriteFailure.uncertain),
            );
            expect(fixture.store.encoded, isNotNull);
            expect(fixture.access.reads, 0);
          }
        }
      }
    },
  );

  test(
    'product verified cleanup failures carry known success without replay',
    () async {
      for (final afterClear in [false, true]) {
        final fixture = _Fixture();
        fixture.store.failClear = true;
        fixture.store.failAfterClear = afterClear;

        await expectLater(
          fixture.coordinator.save(_draft()),
          throwsA(
            isA<ProductMasterWriteException>()
                .having(
                  (error) => error.failure,
                  'failure',
                  ProductMasterWriteFailure.cleanup,
                )
                .having(
                  (error) => error.confirmedProduct?.id,
                  'confirmed target',
                  'product',
                ),
          ),
        );
        fixture.access.manage = false;
        fixture.store.failClear = false;

        if (!afterClear) {
          final receipt = (await fixture.coordinator.outstanding())!;
          final recovered = await fixture.coordinator.recover(
            expectedNonce: receipt.nonce,
          );

          expect(recovered?.id, 'product');
        }

        expect(fixture.access.creates, 1);
        expect(fixture.store.encoded, isNull);
      }
    },
  );

  test(
    'product recovery pins nonce and exact readback after manage revocation',
    () async {
      final fixture = _Fixture();
      fixture.access.foreignReadback = true;

      await expectLater(
        fixture.coordinator.save(_draft()),
        _fails(ProductMasterWriteFailure.uncertain),
      );
      final receipt = (await fixture.coordinator.outstanding())!;

      await expectLater(
        fixture.coordinator.recover(expectedNonce: 'other-operation'),
        _fails(ProductMasterWriteFailure.outstanding),
      );
      fixture.access.foreignReadback = false;
      fixture.access.manage = false;
      final recovered = await fixture.coordinator.recover(
        expectedNonce: receipt.nonce,
      );

      expect(recovered?.id, 'product');
      expect(fixture.access.creates, 1);
      expect(fixture.access.reads, 2);
      expect(fixture.store.encoded, isNull);
    },
  );

  test(
    'product scope and permission changes suppress dispatch or stale success',
    () async {
      for (final changeScope in [false, true]) {
        final fixture = _Fixture();

        if (changeScope) {
          fixture.access.onMutation = () {
            fixture.access.owner = 'other-actor';
          };
        } else {
          fixture.store.onWrite = (count) {
            if (count == 2) {
              fixture.access.manage = false;
            }
          };
        }

        await expectLater(
          fixture.coordinator.save(_draft()),
          _fails(ProductMasterWriteFailure.uncertain),
        );

        expect(fixture.access.creates, changeScope ? 1 : 0);
        expect(fixture.access.reads, 0);
        expect(fixture.store.writes, 2);
        expect(
          ProductMasterWriteReceipt.decode(fixture.store.encoded!).dispatching,
          isTrue,
        );
        expect(fixture.store.events.contains('clear'), isFalse);
      }
    },
  );
}

Matcher _fails(ProductMasterWriteFailure failure) {
  return throwsA(
    isA<ProductMasterWriteException>().having(
      (error) => error.failure,
      'failure',
      failure,
    ),
  );
}

ProductDraft _draft({bool update = false}) {
  return ProductDraft(
    productId: update ? 'product' : null,
    customId: '10',
    name: 'After',
    baseUnit: 'kg',
    units: const [ProductUnitDraft(name: 'box', amount: '2')],
  );
}

models.Product _product({
  String id = 'product',
  String name = 'Before',
  Map<String, num> units = const {'box': 1},
}) {
  return models.Product(
    id: id,
    customId: 10,
    name: name,
    baseUnit: 'kg',
    otherUnits: models.ApplyPriceImportRowOtherUnits(units),
    categories: [],
  );
}

final class _Fixture {
  final store = _Store();
  late final access = _Access(store);
  late final coordinator = ProductMasterWriteCoordinator(
    access: access,
    receipts: store,
  );
}

final class _Store implements ProductMasterReceiptStore {
  final events = <String>[];
  String? encoded;
  int writes = 0;
  int failWrite = 0;
  bool failAfterWrite = false;
  bool failClear = false;
  bool failAfterClear = false;
  void Function(int count)? onWrite;

  @override
  Future<ProductMasterWriteReceipt?> read(String scope) async {
    events.add('read');

    return encoded == null ? null : ProductMasterWriteReceipt.decode(encoded!);
  }

  @override
  Future<void> write(ProductMasterWriteReceipt receipt) async {
    writes++;
    events.add(
      receipt.acknowledged
          ? 'acknowledged'
          : receipt.dispatching
          ? 'dispatching'
          : 'prepared',
    );

    if (writes == failWrite && !failAfterWrite) {
      throw StateError('WRITE_FAILED');
    }

    encoded = receipt.encode();
    onWrite?.call(writes);

    if (writes == failWrite && failAfterWrite) {
      throw StateError('WRITE_FAILED_AFTER_PERSIST');
    }
  }

  @override
  Future<void> clear(String scope) async {
    events.add('clear');

    if (failClear && !failAfterClear) {
      throw StateError('CLEAR_FAILED');
    }

    encoded = null;

    if (failClear && failAfterClear) {
      throw StateError('CLEAR_FAILED_AFTER_DELETE');
    }
  }
}

final class _Access implements ProductMasterWriteAccess {
  _Access(this.store);

  final _Store store;
  String owner = 'scope';
  bool current = true;
  bool manage = true;
  bool loseAcknowledgement = false;
  bool foreignReadback = false;
  int creates = 0;
  int updates = 0;
  int reads = 0;
  models.Product product = _product();
  void Function()? onMutation;

  @override
  String get scope {
    return owner;
  }

  @override
  void checkCurrent() {
    if (!current) {
      throw StateError('STALE_SCOPE');
    }
  }

  void _checkManage() {
    checkCurrent();

    if (!manage) {
      throw StateError('MANAGE_NOT_ALLOWED');
    }
  }

  @override
  void checkCreate(models.ProductsCreateInput input) {
    _checkManage();
    checkProductMasterCreateInput(input);
  }

  @override
  void checkUpdate(models.ProductsUpdateInput input) {
    _checkManage();
    checkProductMasterUpdateInput(input);
  }

  @override
  Future<models.ProductsCreateOutput> createProduct(
    models.ProductsCreateInput input,
  ) async {
    checkCreate(input);
    creates++;
    store.events.add('create');
    product = models.Product(
      id: 'product',
      customId: input.customId,
      name: input.name,
      brand: input.brand.valueOrNull,
      description: input.description.valueOrNull,
      regieReportName: input.regieReportName.valueOrNull,
      baseUnit: input.baseUnit,
      otherUnits: input.otherUnits.value,
      categories: [],
    );
    onMutation?.call();

    if (loseAcknowledgement) {
      throw StateError('ACKNOWLEDGEMENT_LOST');
    }

    return const models.ProductsCreateOutput(id: 'product');
  }

  @override
  Future<models.ProductsUpdateOutput> updateProduct(
    models.ProductsUpdateInput input,
  ) async {
    checkUpdate(input);
    updates++;
    store.events.add('update');
    final data = input.data;
    product = models.Product(
      id: input.id,
      customId: product.customId,
      name: data.name.value,
      brand: data.brand.valueOrNull,
      description: data.description.valueOrNull,
      regieReportName: data.regieReportName.valueOrNull,
      baseUnit: data.baseUnit.value,
      otherUnits: data.otherUnits.value,
      categories: product.categories,
    );
    onMutation?.call();

    if (loseAcknowledgement) {
      throw StateError('ACKNOWLEDGEMENT_LOST');
    }

    return const models.ProductsUpdateOutput(success: true);
  }

  @override
  Future<models.Product?> getProduct(String id) async {
    checkCurrent();
    reads++;
    store.events.add('get:$id');

    if (foreignReadback) {
      return _product(id: 'foreign', name: 'After', units: {'box': 2});
    }

    return product;
  }
}
