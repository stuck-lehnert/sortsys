import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/features/products/product_categories_draft.dart';
import 'package:sortsys_client/features/products/product_categories_inputs.dart';
import 'package:sortsys_client/features/products/product_categories_receipt.dart';
import 'package:sortsys_client/features/products/product_categories_write_access.dart';
import 'package:sortsys_client/features/products/product_categories_write_coordinator.dart';

const _nonce = '00112233445566778899aabbccddeeff';
const _otherNonce = 'ffeeddccbbaa99887766554433221100';

void main() {
  test(
    'category write persists intent before one exact raw dispatch',
    () async {
      final harness = _Harness();
      harness.access.onSet = () async {
        final stored = ProductCategoriesWriteReceipt.decode(
          harness.receipts.encoded!,
        );

        expect(stored.dispatching, isTrue);
        expect(stored.acknowledged, isFalse);
        expect(harness.receipts.stages, ['prepared', 'dispatching']);
      };

      final product = await harness.save();

      expect(product.id, 'product-1');
      expect(product.categories, ['New']);
      expect(harness.access.inputs.single.categories, [' New ', 'new']);
      expect(harness.access.setCalls, 1);
      expect(harness.access.readIds, ['product-1', 'product-1']);
      expect(harness.receipts.stages, [
        'prepared',
        'dispatching',
        'acknowledged',
      ]);
      expect(harness.receipts.encoded, isNull);
    },
  );

  test(
    'category preflight rejects changed membership and duplicate counts',
    () async {
      for (final fresh in [
        <String>['Changed'],
        ['Old', 'Old'],
      ]) {
        final harness = _Harness();
        harness.access.product = _product(fresh);

        await expectLater(
          harness.save(),
          throwsA(_failure(ProductCategoriesWriteFailure.conflict)),
        );

        expect(harness.access.setCalls, 0);
        expect(harness.receipts.stages, isEmpty);
      }
    },
  );

  test('category normalized no-op needs no receipt or mutation', () async {
    final harness = _Harness();
    harness.access.product = _product(['New']);

    final product = await harness.save(baseline: _product(['New']));

    expect(product.categories, ['New']);
    expect(harness.access.setCalls, 0);
    expect(harness.receipts.stages, isEmpty);
  });

  test(
    'category baseline freezes before awaits and ignores unrelated fields',
    () async {
      final harness = _Harness();
      final categories = ['Old'];
      final baseline = _product(categories);
      harness.access.product = _product(['Old'], name: 'Changed independently');

      final saving = harness.save(baseline: baseline);
      categories.clear();

      final product = await saving;

      expect(product.name, 'Changed independently');
      expect(product.categories, ['New']);
      expect(harness.access.setCalls, 1);
    },
  );

  test(
    'outstanding category receipts block fresh dispatch even after acknowledgement',
    () async {
      for (final receipt in [
        _prepared(),
        _prepared().started(),
        _prepared().started().confirmed(
          const models.ProductsCategoriesSetOutput(success: true),
        ),
      ]) {
        final harness = _Harness();
        harness.receipts.encoded = receipt.encode();

        await expectLater(
          harness.save(),
          throwsA(_failure(ProductCategoriesWriteFailure.outstanding)),
        );

        expect(harness.access.readIds, isEmpty);
        expect(harness.access.setCalls, 0);
        expect(harness.receipts.encoded, receipt.encode());
      }
    },
  );

  test(
    'category journal rejects a foreign actor scope or product target',
    () async {
      for (final receipt in [
        _prepared(scope: 'other'),
        _prepared(productId: 'other'),
      ]) {
        final harness = _Harness();
        harness.receipts.encoded = receipt.encode();

        await expectLater(harness.save(), throwsFormatException);

        expect(harness.access.readIds, isEmpty);
        expect(harness.access.setCalls, 0);
        expect(harness.receipts.clears, 0);
      }
    },
  );

  test(
    'category persistence faults never replay prepared dispatched or acknowledged writes',
    () async {
      for (final stage in ['prepared', 'dispatching', 'acknowledged']) {
        for (final after in [false, true]) {
          final harness = _Harness();
          harness.receipts.failStage = stage;
          harness.receipts.failAfterWrite = after;
          final error = stage == 'prepared'
              ? isA<StateError>()
              : _failure(ProductCategoriesWriteFailure.uncertain);

          await expectLater(harness.save(), throwsA(error));

          expect(harness.access.setCalls, stage == 'acknowledged' ? 1 : 0);

          harness.receipts.failStage = null;
          final encoded = harness.receipts.encoded;

          if (encoded != null) {
            final receipt = ProductCategoriesWriteReceipt.decode(encoded);

            if (!receipt.dispatching && !receipt.acknowledged) {
              expect(
                await harness.coordinator.recover(expectedNonce: receipt.nonce),
                isNull,
              );
            } else if (harness.access.setCalls == 0) {
              await expectLater(
                harness.coordinator.recover(expectedNonce: receipt.nonce),
                throwsA(_failure(ProductCategoriesWriteFailure.uncertain)),
              );

              expect(harness.receipts.encoded, encoded);
            } else {
              final recovered = await harness.coordinator.recover(
                expectedNonce: receipt.nonce,
              );

              expect(recovered?.categories, ['New']);
            }
          }

          expect(harness.access.setCalls, stage == 'acknowledged' ? 1 : 0);
        }
      }
    },
  );

  test('category dispatch requires an actual journal readback', () async {
    final harness = _Harness();
    harness.receipts.ignoreStage = 'dispatching';

    await expectLater(
      harness.save(),
      throwsA(_failure(ProductCategoriesWriteFailure.uncertain)),
    );

    expect(harness.access.setCalls, 0);

    final receipt = ProductCategoriesWriteReceipt.decode(
      harness.receipts.encoded!,
    );

    expect(receipt.dispatching, isFalse);
    expect(
      await harness.coordinator.recover(expectedNonce: receipt.nonce),
      isNull,
    );
    expect(harness.access.setCalls, 0);
  });

  test(
    'lost category acknowledgement recovers known target with view permission only',
    () async {
      final harness = _Harness();
      harness.access.loseAcknowledgement = true;

      await expectLater(
        harness.save(),
        throwsA(_failure(ProductCategoriesWriteFailure.uncertain)),
      );

      final receipt = ProductCategoriesWriteReceipt.decode(
        harness.receipts.encoded!,
      );

      expect(receipt.dispatching, isTrue);
      expect(receipt.acknowledged, isFalse);

      harness.access.manage = false;

      final product = await harness.coordinator.recover(
        expectedNonce: receipt.nonce,
      );

      expect(product?.categories, ['New']);
      expect(harness.access.setCalls, 1);
      expect(harness.receipts.encoded, isNull);
    },
  );

  test(
    'category acknowledgement alone cannot confirm wrong readback or trigger replay',
    () async {
      final harness = _Harness();
      harness.access.applyMutation = false;

      await expectLater(
        harness.save(),
        throwsA(_failure(ProductCategoriesWriteFailure.uncertain)),
      );

      final receipt = ProductCategoriesWriteReceipt.decode(
        harness.receipts.encoded!,
      );

      expect(receipt.acknowledged, isTrue);

      harness.access.manage = false;

      await expectLater(
        harness.coordinator.recover(expectedNonce: receipt.nonce),
        throwsA(_failure(ProductCategoriesWriteFailure.uncertain)),
      );

      expect(harness.access.setCalls, 1);

      harness.access.product = _product(['New']);

      final recovered = await harness.coordinator.recover(
        expectedNonce: receipt.nonce,
      );

      expect(recovered?.categories, ['New']);
      expect(harness.access.setCalls, 1);
    },
  );

  test(
    'prepared category discard requires reviewed nonce and no manage permission',
    () async {
      final harness = _Harness();

      await expectLater(
        harness.coordinator.recover(expectedNonce: _nonce),
        throwsStateError,
      );

      harness.receipts.encoded = _prepared().encode();
      harness.access.manage = false;

      await expectLater(
        harness.coordinator.recover(expectedNonce: _otherNonce),
        throwsA(_failure(ProductCategoriesWriteFailure.outstanding)),
      );

      expect(harness.receipts.clears, 0);
      expect(await harness.coordinator.recover(expectedNonce: _nonce), isNull);
      expect(harness.receipts.encoded, isNull);
      expect(harness.access.readIds, isEmpty);
      expect(harness.access.setCalls, 0);
    },
  );

  test(
    'verified category success survives cleanup failure before and after removal',
    () async {
      for (final after in [false, true]) {
        final harness = _Harness();
        harness.receipts.clearFailureAfter = after;
        ProductCategoriesWriteException? failure;

        try {
          await harness.save();
        } on ProductCategoriesWriteException catch (error) {
          failure = error;
        }

        expect(failure?.failure, ProductCategoriesWriteFailure.cleanup);
        expect(failure?.confirmedProduct?.id, 'product-1');
        expect(failure?.confirmedProduct?.categories, ['New']);
        expect(harness.access.setCalls, 1);
        expect(harness.receipts.encoded == null, after);

        harness.receipts.clearFailureAfter = null;
        final encoded = harness.receipts.encoded;

        if (encoded != null) {
          harness.access.manage = false;
          final receipt = ProductCategoriesWriteReceipt.decode(encoded);
          final recovered = await harness.coordinator.recover(
            expectedNonce: receipt.nonce,
          );

          expect(recovered?.id, 'product-1');
        }

        expect(harness.access.setCalls, 1);
      }
    },
  );

  test(
    'category permission loss after dispatch journal prevents any mutation attempt',
    () async {
      final harness = _Harness();
      harness.receipts.afterWrite = (receipt) {
        if (receipt.dispatching) {
          harness.access.manage = false;
        }
      };

      await expectLater(
        harness.save(),
        throwsA(_failure(ProductCategoriesWriteFailure.uncertain)),
      );

      expect(harness.access.setCalls, 0);

      final receipt = ProductCategoriesWriteReceipt.decode(
        harness.receipts.encoded!,
      );

      expect(receipt.dispatching, isTrue);

      await expectLater(
        harness.coordinator.recover(expectedNonce: receipt.nonce),
        throwsA(_failure(ProductCategoriesWriteFailure.uncertain)),
      );

      expect(harness.access.setCalls, 0);
      expect(harness.receipts.encoded, isNotNull);
    },
  );

  test(
    'category preflight rechecks actor target and permissions after awaits',
    () async {
      for (final change in <void Function(_Access)>[
        (access) {
          access.scope = 'other';
        },
        (access) {
          access.productId = 'other';
        },
        (access) {
          access.current = false;
        },
        (access) {
          access.view = false;
        },
        (access) {
          access.manage = false;
        },
      ]) {
        final harness = _Harness();
        harness.access.beforeRead = (count) async {
          change(harness.access);
        };

        await expectLater(harness.save(), throwsStateError);

        expect(harness.access.setCalls, 0);
        expect(harness.receipts.stages, isEmpty);
      }
    },
  );

  test(
    'category lock rejects duplicate save and recovery but isolates other scopes',
    () async {
      final harness = _Harness();
      final entered = Completer<void>();
      final release = Completer<void>();
      harness.access.beforeRead = (count) async {
        if (count == 1) {
          entered.complete();
          await release.future;
        }
      };

      final saving = harness.save();
      await entered.future.timeout(const Duration(seconds: 5));

      try {
        final busy = isA<StateError>().having(
          (error) {
            return error.message;
          },
          'message',
          'PROJECT_WRITE_BUSY',
        );

        await expectLater(harness.save(), throwsA(busy));
        await expectLater(
          harness.coordinator.recover(expectedNonce: _nonce),
          throwsA(busy),
        );

        final other = _Harness();
        other.access.scope = 'other';

        expect((await other.save()).categories, ['New']);
        expect(other.access.setCalls, 1);
        expect(harness.access.setCalls, 0);
      } finally {
        release.complete();
      }

      expect((await saving).categories, ['New']);
      expect(harness.access.setCalls, 1);
    },
  );

  test(
    'stale category mutation reply cannot become an accepted acknowledgement',
    () async {
      final harness = _Harness();
      harness.access.onSet = () async {
        harness.access.current = false;
      };

      await expectLater(
        harness.save(),
        throwsA(_failure(ProductCategoriesWriteFailure.uncertain)),
      );

      final receipt = ProductCategoriesWriteReceipt.decode(
        harness.receipts.encoded!,
      );

      expect(receipt.dispatching, isTrue);
      expect(receipt.acknowledged, isFalse);
      expect(harness.access.setCalls, 1);
      expect(harness.access.readIds, ['product-1']);
    },
  );

  test(
    'category verified cleanup cannot clear a replacement receipt nonce',
    () async {
      final harness = _Harness();
      final replacement = _prepared(nonce: _otherNonce).started();
      harness.access.beforeRead = (count) async {
        if (count == 2) {
          harness.receipts.encoded = replacement.encode();
        }
      };

      await expectLater(
        harness.save(),
        throwsA(
          _failure(ProductCategoriesWriteFailure.cleanup).having(
            (error) {
              return error.confirmedProduct?.categories;
            },
            'confirmed categories',
            ['New'],
          ),
        ),
      );

      expect(harness.receipts.encoded, replacement.encode());
      expect(harness.receipts.clears, 0);
      expect(harness.access.setCalls, 1);
    },
  );
}

TypeMatcher<ProductCategoriesWriteException> _failure(
  ProductCategoriesWriteFailure failure,
) {
  return isA<ProductCategoriesWriteException>().having(
    (error) {
      return error.failure;
    },
    'failure',
    failure,
  );
}

final class _Harness {
  final access = _Access();
  final receipts = _Receipts();

  ProductCategoriesWriteCoordinator get coordinator {
    return ProductCategoriesWriteCoordinator(
      access: access,
      receipts: receipts,
    );
  }

  Future<models.Product> save({models.Product? baseline}) {
    return coordinator.save(
      ProductCategoriesDraft(
        productId: 'product-1',
        categories: [' New ', 'new'],
      ),
      baseline: baseline ?? _product(['Old']),
    );
  }
}

final class _Access implements ProductCategoriesWriteAccess {
  @override
  String scope = 'scope';

  @override
  String productId = 'product-1';

  bool current = true;
  bool view = true;
  bool manage = true;
  bool loseAcknowledgement = false;
  bool applyMutation = true;
  int setCalls = 0;
  models.Product? product = _product(['Old']);
  final inputs = <models.ProductsCategoriesSetInput>[];
  final readIds = <String>[];
  Future<void> Function(int count)? beforeRead;
  Future<void> Function()? onSet;

  @override
  void checkCurrent() {
    if (!current || !view) {
      throw StateError('OWNER_CHANGED');
    }
  }

  @override
  void checkSet(models.ProductsCategoriesSetInput input) {
    checkCurrent();

    if (!manage) {
      throw StateError('MANAGE_REVOKED');
    }

    if (input.id != productId) {
      throw const FormatException('TARGET_CHANGED');
    }

    checkProductCategoriesInput(input);
  }

  @override
  Future<models.Product?> getProduct(String id) async {
    checkCurrent();

    readIds.add(id);
    final callback = beforeRead;

    if (callback != null) {
      await callback(readIds.length);
    }

    checkCurrent();

    return product;
  }

  @override
  Future<models.ProductsCategoriesSetOutput> setCategories(
    models.ProductsCategoriesSetInput input,
  ) async {
    setCalls++;

    checkSet(input);

    inputs.add(input);

    if (applyMutation) {
      product = _product(
        productCategoriesStoredValues(input),
        name: product?.name ?? 'Paint',
      );
    }

    final callback = onSet;

    if (callback != null) {
      await callback();
    }

    if (loseAcknowledgement) {
      throw StateError('ACK_LOST');
    }

    return const models.ProductsCategoriesSetOutput(success: true);
  }
}

final class _Receipts implements ProductCategoriesReceiptStore {
  String? encoded;
  String? failStage;
  bool failAfterWrite = false;
  String? ignoreStage;
  bool? clearFailureAfter;
  int clears = 0;
  final stages = <String>[];
  void Function(ProductCategoriesWriteReceipt)? afterWrite;

  @override
  Future<ProductCategoriesWriteReceipt?> read(String scope) async {
    final value = encoded;

    return value == null ? null : ProductCategoriesWriteReceipt.decode(value);
  }

  @override
  Future<void> write(ProductCategoriesWriteReceipt receipt) async {
    final stage = receipt.acknowledged
        ? 'acknowledged'
        : receipt.dispatching
        ? 'dispatching'
        : 'prepared';

    if (failStage == stage && !failAfterWrite) {
      throw StateError('WRITE_FAILED_BEFORE');
    }

    stages.add(stage);

    if (ignoreStage != stage) {
      encoded = receipt.encode();
    }

    final callback = afterWrite;

    if (callback != null) {
      callback(receipt);
    }

    if (failStage == stage && failAfterWrite) {
      throw StateError('WRITE_FAILED_AFTER');
    }
  }

  @override
  Future<void> clear(String scope) async {
    clears++;

    if (clearFailureAfter == false) {
      throw StateError('CLEAR_FAILED_BEFORE');
    }

    encoded = null;

    if (clearFailureAfter == true) {
      throw StateError('CLEAR_FAILED_AFTER');
    }
  }
}

ProductCategoriesWriteReceipt _prepared({
  String scope = 'scope',
  String productId = 'product-1',
  String nonce = _nonce,
}) {
  return ProductCategoriesWriteReceipt(
    scope: scope,
    nonce: nonce,
    createdAt: DateTime.utc(2026, 1, 2),
    input: models.ProductsCategoriesSetInput(
      id: productId,
      categories: [' New ', 'new'],
    ),
    baselineCategories: ['Old'],
  );
}

models.Product _product(List<String> categories, {String name = 'Paint'}) {
  return models.Product(
    id: 'product-1',
    customId: 1,
    name: name,
    baseUnit: 'kg',
    otherUnits: models.ApplyPriceImportRowOtherUnits(const {}),
    categories: categories,
  );
}
