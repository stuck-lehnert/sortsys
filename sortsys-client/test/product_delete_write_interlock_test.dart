import 'dart:async';
import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/features/products/product_categories_draft.dart';
import 'package:sortsys_client/features/products/product_categories_receipt.dart';
import 'package:sortsys_client/features/products/product_categories_write_access.dart';
import 'package:sortsys_client/features/products/product_categories_write_coordinator.dart';
import 'package:sortsys_client/features/products/product_delete_receipt.dart';
import 'package:sortsys_client/features/products/product_draft.dart';
import 'package:sortsys_client/features/products/product_master_receipt.dart';
import 'package:sortsys_client/features/products/product_price_draft.dart';
import 'package:sortsys_client/features/products/product_price_receipt.dart';
import 'package:sortsys_client/features/products/product_price_write_coordinator.dart';
import 'package:sortsys_client/features/products/secure_product_categories_receipts.dart';
import 'package:sortsys_client/features/products/secure_product_delete_receipts.dart';
import 'package:sortsys_client/features/products/secure_product_master_receipts.dart';
import 'package:sortsys_client/features/products/secure_product_price_receipts.dart';
import 'package:sortsys_client/features/projects/project_write_lock.dart';

const _scope = 'origin|tenant|actor|product';
const _nonce = '0123456789abcdef0123456789abcdef';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(_reset);

  test(
    'pending product deletion blocks both writers at every durable stage',
    () async {
      for (final kind in ['price', 'category']) {
        for (final stage in [0, 1, 2]) {
          _reset();

          final fixture = _Fixture(kind);
          final pending = await _pendingDelete(stage);

          await expectLater(fixture.outstanding(), throwsFormatException);
          await expectLater(fixture.save(), throwsFormatException);
          expect(fixture.writes, 0);
          expect(fixture.reads, 0);
          expect(await fixture.ownReceipt(), isNull);
          expect(
            (await SecureProductDeleteReceipts().read(_scope))!.encode(),
            pending.encode(),
          );
        }
      }
    },
  );

  test(
    'product write barriers fail closed for malformed foreign and oversized journals',
    () async {
      for (final kind in ['price', 'category']) {
        for (final encoded in [
          '{bad',
          _masterReceipt('foreign').encode(),
          List.filled(131073, 'x').join(),
        ]) {
          _reset();
          FlutterSecureStorage.setMockInitialValues({_key(): encoded});

          final fixture = _Fixture(kind);

          await expectLater(fixture.outstanding(), throwsFormatException);
          await expectLater(fixture.save(), throwsFormatException);
          expect(fixture.writes, 0);
          expect(fixture.reads, 0);
          expect(await fixture.ownReceipt(), isNull);
          expect(await const FlutterSecureStorage().read(key: _key()), encoded);
        }
      }
    },
  );

  test(
    'product write barriers retain ownership after awaited master reads',
    () async {
      for (final kind in ['price', 'category']) {
        for (final field in [
          'scope',
          'active',
          if (kind == 'category') 'target',
        ]) {
          _reset();

          final fixture = _Fixture(kind);
          fixture.master.afterRead = () {
            if (field == 'scope') {
              fixture.price.scope = 'replacement';
              fixture.categories.scope = 'replacement';
            } else if (field == 'active') {
              fixture.price.active = false;
              fixture.categories.active = false;
            } else {
              fixture.categories.productId = 'replacement';
            }
          };

          await expectLater(fixture.save(), throwsStateError);
          expect(fixture.master.reads, 1);
          expect(fixture.writes, 0);
          expect(fixture.reads, 0);
          expect(await fixture.ownReceipt(), isNull);
        }
      }
    },
  );

  test(
    'compatible master edits preserve both existing product write workflows',
    () async {
      for (final kind in ['price', 'category']) {
        _reset();

        final fixture = _Fixture(kind);
        final legacy = _masterReceipt(_scope);

        await SecureProductMasterReceipts().write(legacy);

        expect(await fixture.outstanding(), isNull);
        expect(
          _resultId(await fixture.save()),
          kind == 'price' ? 'price' : 'product',
        );
        expect(fixture.writes, 1);
        expect(await fixture.ownReceipt(), isNull);
        expect(
          (await SecureProductMasterReceipts().read(_scope))!.encode(),
          legacy.encode(),
        );
      }
    },
  );

  test(
    'prepared product write recovery never consults pending deletion',
    () async {
      for (final kind in ['price', 'category']) {
        _reset();

        final fixture = _Fixture(kind);
        final pending = await _pendingDelete(1);

        await fixture.seedOwn(acknowledged: false);

        fixture.revokeWrites();
        fixture.master.readError = StateError('UNEXPECTED_MASTER_READ');

        expect(await fixture.outstanding(), isNotNull);
        expect(await fixture.recover(), isNull);
        expect(fixture.master.reads, 0);
        expect(fixture.writes, 0);
        expect(fixture.reads, 0);
        expect(await fixture.ownReceipt(), isNull);
        expect(
          (await SecureProductDeleteReceipts().read(_scope))!.encode(),
          pending.encode(),
        );
      }
    },
  );

  test(
    'acknowledged product write recovery remains read only during deletion',
    () async {
      for (final kind in ['price', 'category']) {
        _reset();

        final fixture = _Fixture(kind);
        final pending = await _pendingDelete(1);

        await fixture.seedOwn(acknowledged: true);

        fixture.revokeWrites();
        fixture.master.readError = StateError('UNEXPECTED_MASTER_READ');

        expect(await fixture.outstanding(), isNotNull);
        expect(
          _resultId(await fixture.recover()),
          kind == 'price' ? 'price' : 'product',
        );
        expect(fixture.master.reads, 0);
        expect(fixture.writes, 0);
        expect(fixture.reads, 1);
        expect(await fixture.ownReceipt(), isNull);
        expect(
          (await SecureProductDeleteReceipts().read(_scope))!.encode(),
          pending.encode(),
        );
      }
    },
  );

  test(
    'product write barriers remain inside their existing write locks',
    () async {
      for (final kind in ['price', 'category']) {
        _reset();

        final fixture = _Fixture(kind);
        final entered = Completer<void>();
        final release = Completer<void>();
        final namespace = kind == 'price'
            ? 'product-prices'
            : 'product-categories';
        final holding = withProjectWriteLock('$namespace:$_scope', () async {
          entered.complete();
          await release.future;
        });

        await entered.future;

        try {
          await expectLater(
            fixture.save(),
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
          expect(fixture.master.reads, 0);
          expect(fixture.writes, 0);
        } finally {
          release.complete();
          await holding;
        }

        await fixture.save();

        expect(fixture.writes, 1);
      }
    },
  );

  test(
    'product write barriers reject typed foreign scope and storage failures',
    () async {
      for (final kind in ['price', 'category']) {
        for (final foreign in [false, true]) {
          _reset();

          final fixture = _Fixture(kind);

          if (foreign) {
            fixture.master.replacement = _masterReceipt('foreign');
          } else {
            fixture.master.readError = StateError('STORAGE_UNAVAILABLE');
          }

          await expectLater(
            fixture.save(),
            foreign ? throwsFormatException : throwsStateError,
          );
          expect(fixture.writes, 0);
          expect(fixture.reads, 0);
          expect(await fixture.ownReceipt(), isNull);
        }
      }
    },
  );
}

void _reset() {
  // All plugin I/O uses session-local in-memory data, never native storage.
  FlutterSecureStorage.setMockInitialValues({});
}

String _key() {
  return 'sortsys.product_master_write.v1.${base64UrlEncode(utf8.encode(_scope))}';
}

models.Product _product({List<String> categories = const ['original']}) {
  return models.Product(
    id: 'product',
    customId: 10,
    name: 'Product',
    baseUnit: 'kg',
    otherUnits: const models.ApplyPriceImportRowOtherUnits({'box': 2}),
    categories: categories,
  );
}

ProductPriceDraft _priceDraft() {
  return ProductPriceDraft(
    product: _product(),
    totalPrice: '10',
    amount: '2',
    date: DateTime.utc(2024, 2, 3),
    comment: ' invoice ',
  );
}

ProductMasterWriteReceipt _masterReceipt(String scope) {
  final draft = ProductDraft(
    productId: 'product',
    customId: '10',
    name: 'Changed',
    baseUnit: 'kg',
    units: const [ProductUnitDraft(name: 'box', amount: '2')],
  );

  return ProductMasterWriteReceipt(
    scope: scope,
    nonce: _nonce,
    createdAt: DateTime.utc(2024, 3),
    updateInput: draft.updateInput(),
    baseline: _product(),
  );
}

Future<ProductDeleteReceipt> _pendingDelete(int stage) async {
  final store = SecureProductDeleteReceipts();
  var receipt = ProductDeleteReceipt(
    scope: _scope,
    nonce: _nonce,
    createdAt: DateTime.utc(2024, 3),
    input: const models.ProductsDeleteInput(id: 'product'),
    baseline: _product(),
  );

  await store.write(receipt);

  if (stage > 0) {
    receipt = receipt.started();
    await store.write(receipt);
  }

  if (stage > 1) {
    receipt = receipt.confirmed(
      const models.ProductsDeleteOutput(success: true),
    );
    await store.write(receipt);
  }

  return receipt;
}

String _resultId(Object? result) {
  if (result is models.Product) {
    return result.id;
  }

  if (result is models.ProductsPriceRecordsListResultItem) {
    return result.id;
  }

  throw StateError('EXPECTED_VERIFIED_RESULT');
}

final class _Fixture {
  _Fixture(this.kind);

  final String kind;
  final master = _MasterJournal();
  final price = _PriceAccess();
  final categories = _CategoryAccess();
  final priceReceipts = SecureProductPriceReceipts();
  final categoryReceipts = SecureProductCategoriesReceipts();

  ProductPriceWriteCoordinator get priceCoordinator {
    return ProductPriceWriteCoordinator(
      access: price,
      receipts: priceReceipts,
      masterReceipts: master,
    );
  }

  ProductCategoriesWriteCoordinator get categoryCoordinator {
    return ProductCategoriesWriteCoordinator(
      access: categories,
      receipts: categoryReceipts,
      masterReceipts: master,
    );
  }

  int get writes {
    return kind == 'price' ? price.writes : categories.writes;
  }

  int get reads {
    return kind == 'price' ? price.reads : categories.reads;
  }

  Future<Object?> outstanding() async {
    if (kind == 'price') {
      return priceCoordinator.outstanding();
    }

    return categoryCoordinator.outstanding();
  }

  Future<Object?> save() async {
    if (kind == 'price') {
      return priceCoordinator.save(_priceDraft());
    }

    return categoryCoordinator.save(
      ProductCategoriesDraft(productId: 'product', categories: const ['next']),
      baseline: _product(),
    );
  }

  Future<Object?> ownReceipt() async {
    if (kind == 'price') {
      return priceReceipts.read(_scope);
    }

    return categoryReceipts.read(_scope);
  }

  Future<Object?> recover() async {
    if (kind == 'price') {
      return priceCoordinator.recover(expectedNonce: _nonce);
    }

    return categoryCoordinator.recover(expectedNonce: _nonce);
  }

  void revokeWrites() {
    price.canWrite = false;
    categories.canWrite = false;
  }

  Future<void> seedOwn({required bool acknowledged}) async {
    if (kind == 'price') {
      var receipt = ProductPriceWriteReceipt(
        scope: _scope,
        nonce: _nonce,
        createdAt: DateTime.utc(2024, 3),
        input: _priceDraft().createInput(),
      );
      price.submitted = receipt.input;

      if (acknowledged) {
        receipt = receipt.started().confirmed(
          const models.ProductsPriceRecordsCreateOutput(id: 'price'),
        );
      }

      await priceReceipts.write(receipt);

      return;
    }

    var receipt = ProductCategoriesWriteReceipt(
      scope: _scope,
      nonce: _nonce,
      createdAt: DateTime.utc(2024, 3),
      input: const models.ProductsCategoriesSetInput(
        id: 'product',
        categories: ['next'],
      ),
      baselineCategories: const ['original'],
    );

    if (acknowledged) {
      receipt = receipt.started().confirmed(
        const models.ProductsCategoriesSetOutput(success: true),
      );
      categories.product = _product(categories: const ['next']);
    }

    await categoryReceipts.write(receipt);
  }
}

final class _MasterJournal implements ProductMasterReceiptStore {
  final delegate = SecureProductMasterReceipts();
  ProductMasterWriteReceipt? replacement;
  Object? readError;
  void Function()? afterRead;
  int reads = 0;

  @override
  Future<ProductMasterWriteReceipt?> read(String scope) async {
    reads++;

    final error = readError;

    if (error != null) {
      throw error;
    }

    final receipt = replacement ?? await delegate.read(scope);

    afterRead?.call();

    return receipt;
  }

  @override
  Future<void> write(ProductMasterWriteReceipt receipt) async {
    throw StateError('BARRIER_MUST_NOT_WRITE_MASTER_JOURNAL');
  }

  @override
  Future<void> clear(String scope) async {
    throw StateError('BARRIER_MUST_NOT_CLEAR_MASTER_JOURNAL');
  }
}

final class _PriceAccess implements ProductPriceWriteAccess {
  @override
  String scope = _scope;

  bool active = true;
  bool canWrite = true;
  int reads = 0;
  int writes = 0;
  models.ProductsPriceRecordsCreateInput? submitted;

  @override
  void checkCurrent() {
    if (!active) {
      throw StateError('PRICE_OWNER_CHANGED');
    }
  }

  @override
  void checkCreate(models.ProductsPriceRecordsCreateInput input) {
    checkCurrent();

    if (!canWrite || input.productId != 'product') {
      throw StateError('PRICE_WRITE_FORBIDDEN');
    }
  }

  @override
  Future<models.ProductsPriceRecordsCreateOutput> createPrice(
    models.ProductsPriceRecordsCreateInput input,
  ) async {
    checkCreate(input);

    writes++;
    submitted = input;

    return const models.ProductsPriceRecordsCreateOutput(id: 'price');
  }

  @override
  Future<models.ProductsPriceRecordsListResultItem?> priceRecord(
    String recordId,
    String productId,
  ) async {
    checkCurrent();

    reads++;

    final input = submitted!;

    return models.ProductsPriceRecordsListResultItem(
      id: recordId,
      productId: input.productId,
      timestamp: input.timestamp,
      price: input.pricePerBaseUnit,
      isRealPurchase: input.isRealPurchase,
      comment: input.comment.valueOrNull?.trim(),
    );
  }
}

final class _CategoryAccess implements ProductCategoriesWriteAccess {
  @override
  String scope = _scope;

  @override
  String productId = 'product';

  bool active = true;
  bool canWrite = true;
  int reads = 0;
  int writes = 0;
  models.Product product = _product();

  @override
  void checkCurrent() {
    if (!active) {
      throw StateError('CATEGORY_OWNER_CHANGED');
    }
  }

  @override
  void checkSet(models.ProductsCategoriesSetInput input) {
    checkCurrent();

    if (!canWrite || input.id != productId) {
      throw StateError('CATEGORY_WRITE_FORBIDDEN');
    }
  }

  @override
  Future<models.Product?> getProduct(String id) async {
    checkCurrent();

    reads++;

    return product;
  }

  @override
  Future<models.ProductsCategoriesSetOutput> setCategories(
    models.ProductsCategoriesSetInput input,
  ) async {
    checkSet(input);

    writes++;
    product = _product(categories: List.of(input.categories));

    return const models.ProductsCategoriesSetOutput(success: true);
  }
}
