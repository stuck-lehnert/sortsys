import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/api/model.dart';
import 'package:sortsys_client/features/products/product_categories_receipt.dart';
import 'package:sortsys_client/features/products/product_delete_coordinator.dart';
import 'package:sortsys_client/features/products/product_delete_receipt.dart';
import 'package:sortsys_client/features/products/product_price_receipt.dart';
import 'package:sortsys_client/features/projects/project_write_lock.dart';

void main() {
  test('product delete reads back all stages before one dispatch', () async {
    final harness = _Harness();
    harness.access.beforeDelete = () {
      expect(harness.receipts.receipt!.dispatching, isTrue);
      expect(harness.receipts.readbackPending, isFalse);
      expect(harness.receipts.stages, ['prepared', 'dispatching']);
    };

    expect(await harness.delete(), 'product');
    expect(harness.access.getIds, ['product']);
    expect(harness.access.deleteIds, ['product']);
    expect(harness.receipts.stages, [
      'prepared',
      'dispatching',
      'acknowledged',
    ]);
    expect(harness.receipts.receipt, isNull);
    expect(harness.receipts.clears, 1);
  });

  test(
    'product delete rejects confirmation roles and foreign journals',
    () async {
      final harness = _Harness();

      await expectLater(
        Future.sync(() {
          return harness.delete(confirmed: false);
        }),
        throwsFormatException,
      );
      expect(harness.receipts.reads, 0);

      harness.access.canDelete = false;

      await expectLater(
        Future.sync(() {
          return harness.delete();
        }),
        throwsStateError,
      );
      expect(harness.receipts.reads, 0);

      harness.access.canDelete = true;
      harness.receipts.readError = const FormatException(
        'EXISTING_PRODUCT_WRITE',
      );

      await expectLater(harness.delete(), throwsFormatException);
      expect(harness.access.getIds, isEmpty);
      expect(harness.access.deleteIds, isEmpty);

      harness.receipts.readError = null;
      harness.receipts.encoded = _receipt(scope: 'foreign').encode();

      await expectLater(harness.delete(), throwsFormatException);
      expect(harness.receipts.stages, isEmpty);
      expect(harness.access.deleteIds, isEmpty);
    },
  );

  test(
    'product delete requires a full fresh baseline and known target',
    () async {
      for (final fresh in [
        _product(name: 'Changed'),
        _product(id: 'other'),
        _product(baseUnit: 'changed'),
        _product(units: const {'box': 99}),
        _product(categories: const ['changed']),
      ]) {
        final harness = _Harness();
        harness.access.product = fresh;

        await expectLater(
          harness.delete(),
          _failure(ProductDeleteFailure.conflict),
        );
        expect(harness.access.getIds, ['product']);
        expect(harness.access.deleteIds, isEmpty);
        expect(harness.receipts.stages, isEmpty);
      }
    },
  );

  test('product delete freezes baseline before the first await', () async {
    final entered = Completer<void>();
    final release = Completer<void>();
    final units = <String, num>{'box': 12};
    final categories = ['original'];
    final baseline = _product(units: units, categories: categories);
    final harness = _Harness();
    harness.access.product = _product(
      units: Map.of(units),
      categories: List.of(categories),
    );
    harness.receipts.beforeRead = (number) async {
      if (number == 1) {
        entered.complete();
        await release.future;
      }
    };

    final operation = harness.delete(baseline: baseline);

    await entered.future;

    units.clear();
    categories.clear();
    release.complete();

    expect(await operation, 'product');
    expect(harness.access.deleteIds, ['product']);
    expect(harness.receipts.snapshots.first.baseline.otherUnits.values, {
      'box': 12,
    });
    expect(harness.receipts.snapshots.first.baseline.categories, ['original']);
    expect(baseline.otherUnits.values, isEmpty);
    expect(baseline.categories, isEmpty);
  });

  test(
    'product delete rejects ignored writes at every durable stage',
    () async {
      for (final ignored in [1, 2, 3]) {
        final harness = _Harness();
        harness.receipts.ignoreWrite = ignored;

        await expectLater(
          harness.delete(),
          ignored == 1
              ? throwsStateError
              : _failure(ProductDeleteFailure.uncertain),
        );
        expect(harness.access.deleteIds.length, ignored == 3 ? 1 : 0);

        if (ignored == 1) {
          expect(harness.receipts.receipt, isNull);
        } else {
          final pending = harness.receipts.receipt!;

          expect(pending.acknowledged, isFalse);
          expect(pending.dispatching, ignored == 3);
        }
      }
    },
  );

  test('product delete ACK loss never infers absence or replays', () async {
    final harness = _Harness();
    harness.access.loseAcknowledgement = true;

    await expectLater(
      harness.delete(),
      _failure(ProductDeleteFailure.uncertain),
    );

    final pending = harness.receipts.receipt!;
    harness.access.canDelete = false;

    await expectLater(
      harness.coordinator.recover(expectedNonce: pending.nonce),
      _failure(ProductDeleteFailure.uncertain),
    );
    expect(harness.access.getIds, ['product']);
    expect(harness.access.deleteIds, ['product']);
    expect(harness.receipts.receipt!.encode(), pending.encode());

    harness.access.canDelete = true;

    await expectLater(
      harness.delete(),
      _failure(ProductDeleteFailure.outstanding),
    );
    expect(harness.access.getIds, ['product']);
    expect(harness.access.deleteIds, ['product']);
  });

  test(
    'product delete unsent discard needs nonce but not delete role',
    () async {
      final harness = _Harness();
      harness.receipts.failAfterWrite = 1;

      await expectLater(harness.delete(), throwsStateError);

      final pending = harness.receipts.receipt!;
      harness.access.canDelete = false;

      await expectLater(
        harness.coordinator.recover(expectedNonce: 'foreign'),
        _failure(ProductDeleteFailure.outstanding),
      );
      expect(harness.receipts.receipt!.encode(), pending.encode());
      expect(pending.dispatching, isFalse);
      expect(pending.acknowledged, isFalse);
      expect(
        await harness.coordinator.recover(expectedNonce: pending.nonce),
        isNull,
      );
      expect(harness.receipts.receipt, isNull);
      expect(harness.access.deleteIds, isEmpty);
      expect(harness.access.getIds, ['product']);
    },
  );

  test('product delete role loss after read prevents journal writes', () async {
    final harness = _Harness();
    harness.access.afterGet = () async {
      harness.access.canDelete = false;
    };

    await expectLater(harness.delete(), throwsStateError);
    expect(harness.receipts.stages, isEmpty);
    expect(harness.access.deleteIds, isEmpty);
    expect(harness.receipts.receipt, isNull);
  });

  test('product delete cleanup retains ID before and after removal', () async {
    for (final after in [false, true]) {
      final harness = _Harness();
      harness.receipts.clearFailureAfter = after;

      await expectLater(
        harness.delete(),
        throwsA(
          isA<ProductDeleteException>()
              .having(
                (error) {
                  return error.failure;
                },
                'failure',
                ProductDeleteFailure.cleanup,
              )
              .having(
                (error) {
                  return error.confirmedProductId;
                },
                'confirmed ID',
                'product',
              ),
        ),
      );
      expect(harness.access.deleteIds, ['product']);
      expect(harness.access.getIds, ['product']);

      if (after) {
        expect(harness.receipts.receipt, isNull);
      } else {
        final pending = harness.receipts.receipt!;
        harness.receipts.clearFailureAfter = null;
        harness.access.canDelete = false;

        expect(pending.acknowledged, isTrue);
        expect(
          await harness.coordinator.recover(expectedNonce: pending.nonce),
          'product',
        );
        expect(harness.receipts.receipt, isNull);
        expect(harness.access.deleteIds, ['product']);
        expect(harness.access.getIds, ['product']);
      }
    }
  });

  test(
    'product delete stale replies cannot confirm a replacement owner',
    () async {
      for (final phase in ['read', 'delete']) {
        final harness = _Harness();

        if (phase == 'read') {
          harness.access.afterGet = () async {
            harness.access.active = false;
          };
        } else {
          harness.access.afterDelete = () async {
            harness.access.active = false;
          };
        }

        await expectLater(
          harness.delete(),
          phase == 'read'
              ? throwsStateError
              : _failure(ProductDeleteFailure.uncertain),
        );
        expect(harness.access.deleteIds.length, phase == 'delete' ? 1 : 0);

        if (phase == 'read') {
          expect(harness.receipts.receipt, isNull);
        } else {
          expect(harness.receipts.receipt!.dispatching, isTrue);
          expect(harness.receipts.receipt!.acknowledged, isFalse);
        }
      }
    },
  );

  test('product delete preserves a replacement receipt nonce', () async {
    final harness = _Harness();
    final replacement = _receipt(nonce: 'ffffffffffffffffffffffffffffffff');
    String? originalNonce;
    harness.access.afterDelete = () async {
      originalNonce = harness.receipts.receipt!.nonce;
      harness.receipts.encoded = replacement.encode();
    };

    await expectLater(
      harness.delete(),
      _failure(ProductDeleteFailure.uncertain),
    );
    expect(harness.receipts.receipt!.encode(), replacement.encode());
    expect(harness.access.deleteIds, ['product']);

    await expectLater(
      harness.coordinator.recover(expectedNonce: originalNonce!),
      _failure(ProductDeleteFailure.outstanding),
    );
    expect(harness.receipts.receipt!.encode(), replacement.encode());
    expect(harness.receipts.clears, 0);
  });

  test(
    'product delete holds all three locks and releases partial claims',
    () async {
      for (final namespace in [
        'product-master',
        'product-prices',
        'product-categories',
      ]) {
        final harness = _Harness();
        final entered = Completer<void>();
        final release = Completer<void>();
        final holding = withProjectWriteLock(
          '$namespace:${harness.access.scope}',
          () async {
            entered.complete();
            await release.future;

            return 'released';
          },
        );

        await entered.future;

        try {
          await expectLater(
            harness.delete(),
            throwsA(
              isA<StateError>().having(
                (error) {
                  return error.message;
                },
                'message',
                'PROJECT_WRITE_BUSY',
              ),
            ),
          );
          expect(harness.receipts.reads, 0);
          expect(harness.priceReceipts.reads, 0);
          expect(harness.categoryReceipts.reads, 0);
          expect(harness.receipts.stages, isEmpty);
          expect(harness.access.deleteIds, isEmpty);
        } finally {
          release.complete();
          await holding;
        }

        expect(await harness.delete(), 'product');
        expect(harness.access.deleteIds, ['product']);
      }
    },
  );

  test(
    'product delete blocks related journals at every durable stage',
    () async {
      for (final kind in ['price', 'category']) {
        for (final stage in [0, 1, 2]) {
          final harness = _Harness();
          final original = _installRelated(harness, kind, stage: stage);

          await expectLater(
            harness.coordinator.outstanding(),
            _failure(ProductDeleteFailure.outstanding),
          );
          await expectLater(
            harness.delete(),
            _failure(ProductDeleteFailure.outstanding),
          );
          expect(harness.access.getIds, isEmpty);
          expect(harness.access.deleteIds, isEmpty);
          expect(harness.receipts.stages, isEmpty);
          expect(_relatedEncoded(harness, kind), original);
          expect(
            harness.priceReceipts.writes + harness.categoryReceipts.writes,
            0,
          );
          expect(
            harness.priceReceipts.clears + harness.categoryReceipts.clears,
            0,
          );
        }
      }
    },
  );

  test(
    'product delete rejects corrupt foreign and mismatched related owners',
    () async {
      for (final kind in ['price', 'category']) {
        for (final defect in ['corrupt', 'scope', 'target']) {
          final harness = _Harness();

          if (defect == 'corrupt') {
            if (kind == 'price') {
              harness.priceReceipts.readError = const FormatException(
                'CORRUPT_JOURNAL',
              );
            } else {
              harness.categoryReceipts.readError = const FormatException(
                'CORRUPT_JOURNAL',
              );
            }
          } else {
            _installRelated(
              harness,
              kind,
              scope: defect == 'scope' ? 'foreign' : harness.access.scope,
              productId: defect == 'target' ? 'other' : 'product',
            );
          }

          await expectLater(
            harness.coordinator.outstanding(),
            throwsFormatException,
          );
          await expectLater(harness.delete(), throwsFormatException);
          expect(harness.access.getIds, isEmpty);
          expect(harness.access.deleteIds, isEmpty);
          expect(harness.receipts.stages, isEmpty);
        }
      }
    },
  );

  test(
    'product delete guards scope target and owner after related reads',
    () async {
      for (final kind in ['price', 'category']) {
        for (final field in ['scope', 'target', 'active']) {
          final harness = _Harness();

          Future<void> replaceOwner() async {
            if (field == 'scope') {
              harness.access.scope = 'replacement';
            } else if (field == 'target') {
              harness.access.productId = 'replacement';
            } else {
              harness.access.active = false;
            }
          }

          if (kind == 'price') {
            harness.priceReceipts.beforeRead = () async {
              await replaceOwner();
            };
          } else {
            harness.categoryReceipts.beforeRead = () async {
              await replaceOwner();
            };
          }

          await expectLater(harness.delete(), throwsStateError);
          expect(harness.access.getIds, isEmpty);
          expect(harness.access.deleteIds, isEmpty);
          expect(harness.receipts.stages, isEmpty);
        }
      }
    },
  );

  test('product delete validates bound target before journal access', () async {
    final harness = _Harness();

    await expectLater(
      Future.sync(() {
        return harness.delete(baseline: _product(id: 'other'));
      }),
      throwsFormatException,
    );
    expect(harness.receipts.reads, 0);
    expect(harness.priceReceipts.reads, 0);
    expect(harness.categoryReceipts.reads, 0);

    for (final field in ['scope', 'target']) {
      final invalid = _Harness();

      if (field == 'scope') {
        invalid.access.scope = '';
      } else {
        invalid.access.productId = '';
      }

      await expectLater(
        Future.sync(() {
          return invalid.delete();
        }),
        throwsStateError,
      );
      expect(invalid.receipts.reads, 0);
      expect(invalid.priceReceipts.reads, 0);
      expect(invalid.categoryReceipts.reads, 0);
    }
  });

  test(
    'product delete recovery preserves other journals after delete-role loss',
    () async {
      for (final acknowledged in [false, true]) {
        final harness = _Harness();
        final prepared = _receipt();
        final pending = acknowledged
            ? prepared.started().confirmed(
                const models.ProductsDeleteOutput(success: true),
              )
            : prepared;
        harness.receipts.encoded = pending.encode();
        final price = _installRelated(harness, 'price');
        final categories = _installRelated(harness, 'category');
        harness.access.canDelete = false;

        expect(
          (await harness.coordinator.outstanding())!.encode(),
          pending.encode(),
        );
        expect(
          await harness.coordinator.recover(expectedNonce: pending.nonce),
          acknowledged ? 'product' : null,
        );
        expect(harness.receipts.receipt, isNull);
        expect(harness.receipts.clears, 1);
        expect(harness.priceReceipts.encoded, price);
        expect(harness.categoryReceipts.encoded, categories);
        expect(harness.priceReceipts.reads + harness.categoryReceipts.reads, 0);
        expect(
          harness.priceReceipts.writes + harness.categoryReceipts.writes,
          0,
        );
        expect(
          harness.priceReceipts.clears + harness.categoryReceipts.clears,
          0,
        );
        expect(harness.access.getIds, isEmpty);
        expect(harness.access.deleteIds, isEmpty);
      }
    },
  );

  test(
    'product delete checks newly pending related work before dispatch',
    () async {
      final harness = _Harness();
      var injected = false;
      harness.receipts.beforeRead = (number) async {
        if (!injected && harness.receipts.stages.length == 1) {
          injected = true;
          _installRelated(harness, 'category');
        }
      };

      await expectLater(
        harness.delete(),
        _failure(ProductDeleteFailure.uncertain),
      );

      final pending = harness.receipts.receipt!;
      final categories = harness.categoryReceipts.encoded;

      expect(injected, isTrue);
      expect(pending.dispatching, isFalse);
      expect(pending.acknowledged, isFalse);
      expect(harness.receipts.stages, ['prepared']);
      expect(harness.access.getIds, ['product']);
      expect(harness.access.deleteIds, isEmpty);

      harness.access.canDelete = false;

      expect(
        await harness.coordinator.recover(expectedNonce: pending.nonce),
        isNull,
      );
      expect(harness.receipts.receipt, isNull);
      expect(harness.categoryReceipts.encoded, categories);
      expect(harness.access.deleteIds, isEmpty);
    },
  );

  test(
    'product delete false acknowledgement cannot confirm or replay',
    () async {
      final harness = _Harness();
      harness.access.acknowledgement = const models.ProductsDeleteOutput(
        success: false,
      );

      await expectLater(
        harness.delete(),
        _failure(ProductDeleteFailure.uncertain),
      );

      final pending = harness.receipts.receipt!;
      expect(pending.dispatching, isTrue);
      expect(pending.acknowledged, isFalse);

      harness.access.canDelete = false;

      await expectLater(
        harness.coordinator.recover(expectedNonce: pending.nonce),
        _failure(ProductDeleteFailure.uncertain),
      );
      expect(harness.access.getIds, ['product']);
      expect(harness.access.deleteIds, ['product']);
      expect(harness.receipts.receipt!.encode(), pending.encode());
    },
  );

  test(
    'product delete never treats missing records as acknowledgement',
    () async {
      final missingRead = _Harness();
      missingRead.access.getError = StateError('NOT_FOUND');

      await expectLater(missingRead.delete(), throwsStateError);
      expect(missingRead.receipts.stages, isEmpty);
      expect(missingRead.access.deleteIds, isEmpty);

      final missingDelete = _Harness();
      missingDelete.access.afterDelete = () async {
        throw StateError('NOT_FOUND');
      };

      await expectLater(
        missingDelete.delete(),
        _failure(ProductDeleteFailure.uncertain),
      );

      final pending = missingDelete.receipts.receipt!;

      await expectLater(
        missingDelete.coordinator.recover(expectedNonce: pending.nonce),
        _failure(ProductDeleteFailure.uncertain),
      );
      expect(pending.dispatching, isTrue);
      expect(pending.acknowledged, isFalse);
      expect(missingDelete.access.getIds, ['product']);
      expect(missingDelete.access.deleteIds, ['product']);
      expect(missingDelete.receipts.receipt!.encode(), pending.encode());
    },
  );
}

Matcher _failure(ProductDeleteFailure failure) {
  return throwsA(
    isA<ProductDeleteException>().having(
      (error) {
        return error.failure;
      },
      'failure',
      failure,
    ),
  );
}

final class _Harness {
  final access = _Access();
  final receipts = _Receipts();
  final priceReceipts = _PriceReceipts();
  final categoryReceipts = _CategoryReceipts();

  ProductDeleteCoordinator get coordinator {
    return ProductDeleteCoordinator(
      access: access,
      receipts: receipts,
      priceReceipts: priceReceipts,
      categoryReceipts: categoryReceipts,
    );
  }

  Future<String> delete({models.Product? baseline, bool confirmed = true}) {
    return coordinator.delete(
      baseline: baseline ?? _product(),
      confirmed: confirmed,
    );
  }
}

models.Product _product({
  String id = 'product',
  String name = 'Product',
  String baseUnit = 'pc',
  Map<String, num> units = const {'box': 12},
  List<String> categories = const ['original'],
}) {
  return models.Product(
    id: id,
    customId: 7,
    name: name,
    brand: 'Brand',
    description: 'Description',
    regieReportName: 'Report',
    baseUnit: baseUnit,
    otherUnits: models.ApplyPriceImportRowOtherUnits(units),
    categories: categories,
  );
}

ProductDeleteReceipt _receipt({
  String scope = 'origin|tenant|actor|product',
  String nonce = '0123456789abcdef0123456789abcdef',
}) {
  return ProductDeleteReceipt(
    scope: scope,
    nonce: nonce,
    createdAt: DateTime.utc(2024, 3),
    input: const models.ProductsDeleteInput(id: 'product'),
    baseline: _product(),
  );
}

final class _Access implements ProductDeleteAccess {
  @override
  String scope = 'origin|tenant|actor|product';

  @override
  String productId = 'product';

  Object? getError;
  models.ProductsDeleteOutput acknowledgement =
      const models.ProductsDeleteOutput(success: true);
  bool active = true;
  bool canDelete = true;
  bool loseAcknowledgement = false;
  models.Product product = _product();
  final getIds = <String>[];
  final deleteIds = <String>[];
  void Function()? beforeDelete;
  Future<void> Function()? afterGet;
  Future<void> Function()? afterDelete;

  @override
  void checkCurrent() {
    if (!active) {
      throw StateError('PRODUCT_DELETE_SCOPE_CHANGED');
    }
  }

  @override
  void checkDelete(models.ProductsDeleteInput input) {
    checkCurrent();

    if (!canDelete || input.id != productId) {
      throw StateError('PRODUCT_DELETE_FORBIDDEN');
    }
  }

  @override
  Future<models.Product> getProduct(String id) async {
    getIds.add(id);

    final error = getError;

    if (error != null) {
      throw error;
    }

    final callback = afterGet;

    if (callback != null) {
      await callback();
    }

    return product;
  }

  @override
  Future<models.ProductsDeleteOutput> deleteProduct(
    models.ProductsDeleteInput input,
  ) async {
    checkDelete(input);
    beforeDelete?.call();
    deleteIds.add(input.id);

    final callback = afterDelete;

    if (callback != null) {
      await callback();
    }

    if (loseAcknowledgement) {
      throw StateError('ACK_LOST');
    }

    return acknowledgement;
  }
}

final class _Receipts implements ProductDeleteReceiptStore {
  String? encoded;
  int reads = 0;
  int clears = 0;
  int? ignoreWrite;
  int? failAfterWrite;
  bool? clearFailureAfter;
  bool readbackPending = false;
  Object? readError;
  Future<void> Function(int number)? beforeRead;
  final stages = <String>[];
  final snapshots = <ProductDeleteReceipt>[];

  ProductDeleteReceipt? get receipt {
    final value = encoded;

    return value == null ? null : ProductDeleteReceipt.decode(value);
  }

  @override
  Future<ProductDeleteReceipt?> read(String scope) async {
    reads++;

    final callback = beforeRead;

    if (callback != null) {
      await callback(reads);
    }

    final error = readError;

    if (error != null) {
      throw error;
    }

    readbackPending = false;

    return receipt;
  }

  @override
  Future<void> write(ProductDeleteReceipt receipt) async {
    final stage = receipt.acknowledged
        ? 'acknowledged'
        : receipt.dispatching
        ? 'dispatching'
        : 'prepared';

    stages.add(stage);
    snapshots.add(ProductDeleteReceipt.decode(receipt.encode()));
    readbackPending = true;

    if (ignoreWrite == stages.length) {
      return;
    }

    encoded = receipt.encode();

    if (failAfterWrite == stages.length) {
      throw StateError('AFTER_WRITE_FAILURE');
    }
  }

  @override
  Future<void> clear(String scope) async {
    clears++;

    if (clearFailureAfter == false) {
      throw StateError('BEFORE_CLEAR_FAILURE');
    }

    encoded = null;

    if (clearFailureAfter == true) {
      throw StateError('AFTER_CLEAR_FAILURE');
    }
  }
}

String _installRelated(
  _Harness harness,
  String kind, {
  int stage = 0,
  String? scope,
  String productId = 'product',
}) {
  final owner = scope ?? harness.access.scope;

  if (kind == 'price') {
    var receipt = ProductPriceWriteReceipt(
      scope: owner,
      nonce: '0123456789abcdef0123456789abcdef',
      createdAt: DateTime.utc(2024, 3),
      input: models.ProductsPriceRecordsCreateInput(
        productId: productId,
        pricePerBaseUnit: 1,
        timestamp: DateTime.utc(2024, 2),
        isRealPurchase: false,
        comment: const RpcOptional.value(null),
      ),
    );

    if (stage > 0) {
      receipt = receipt.started();
    }

    if (stage > 1) {
      receipt = receipt.confirmed(
        const models.ProductsPriceRecordsCreateOutput(id: 'price'),
      );
    }

    final encoded = receipt.encode();
    harness.priceReceipts.encoded = encoded;

    return encoded;
  }

  var receipt = ProductCategoriesWriteReceipt(
    scope: owner,
    nonce: '0123456789abcdef0123456789abcdef',
    createdAt: DateTime.utc(2024, 3),
    input: models.ProductsCategoriesSetInput(
      id: productId,
      categories: const ['next'],
    ),
    baselineCategories: const ['original'],
  );

  if (stage > 0) {
    receipt = receipt.started();
  }

  if (stage > 1) {
    receipt = receipt.confirmed(
      const models.ProductsCategoriesSetOutput(success: true),
    );
  }

  final encoded = receipt.encode();
  harness.categoryReceipts.encoded = encoded;

  return encoded;
}

String? _relatedEncoded(_Harness harness, String kind) {
  return kind == 'price'
      ? harness.priceReceipts.encoded
      : harness.categoryReceipts.encoded;
}

final class _PriceReceipts implements ProductPriceReceiptStore {
  String? encoded;
  Object? readError;
  Future<void> Function()? beforeRead;
  int reads = 0;
  int writes = 0;
  int clears = 0;

  @override
  Future<ProductPriceWriteReceipt?> read(String scope) async {
    reads++;

    final callback = beforeRead;

    if (callback != null) {
      await callback();
    }

    final error = readError;

    if (error != null) {
      throw error;
    }

    final value = encoded;

    return value == null ? null : ProductPriceWriteReceipt.decode(value);
  }

  @override
  Future<void> write(ProductPriceWriteReceipt receipt) async {
    writes++;

    throw StateError('RELATED_PRICE_JOURNAL_MUST_NOT_CHANGE');
  }

  @override
  Future<void> clear(String scope) async {
    clears++;

    throw StateError('RELATED_PRICE_JOURNAL_MUST_NOT_CHANGE');
  }
}

final class _CategoryReceipts implements ProductCategoriesReceiptStore {
  String? encoded;
  Object? readError;
  Future<void> Function()? beforeRead;
  int reads = 0;
  int writes = 0;
  int clears = 0;

  @override
  Future<ProductCategoriesWriteReceipt?> read(String scope) async {
    reads++;

    final callback = beforeRead;

    if (callback != null) {
      await callback();
    }

    final error = readError;

    if (error != null) {
      throw error;
    }

    final value = encoded;

    return value == null ? null : ProductCategoriesWriteReceipt.decode(value);
  }

  @override
  Future<void> write(ProductCategoriesWriteReceipt receipt) async {
    writes++;

    throw StateError('RELATED_CATEGORY_JOURNAL_MUST_NOT_CHANGE');
  }

  @override
  Future<void> clear(String scope) async {
    clears++;

    throw StateError('RELATED_CATEGORY_JOURNAL_MUST_NOT_CHANGE');
  }
}
