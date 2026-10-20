import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/api.g.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/api/model.dart';
import 'package:sortsys_client/api/procedure.dart';
import 'package:sortsys_client/features/products/product_categories_rpc_access.dart';
import 'package:sortsys_client/features/products/session_product_categories_access.dart';
import 'package:sortsys_client/state/session_controller.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test(
    'category RPC uses exact raw set known-ID get and undefined list contracts',
    () async {
      final fixture = _Fixture();
      final access = fixture.access();

      final result = await access.setCategories(_input());
      final product = await access.getProduct('product');
      final categories = await access.getCategories();

      expect(result.success, isTrue);
      expect(fixture.writeInput?.toWire(), {
        'id': 'product',
        'categories': [' New ', 'new'],
      });
      expect(fixture.readInput?.toWire(), {'id': 'product'});
      expect(product?.id, 'product');
      expect(categories, [' B ', 'A', 'B']);
      expect(fixture.writes, 1);
      expect(fixture.reads, 2);
    },
  );

  test(
    'category RPC requires view and manage but permits view-only reads',
    () async {
      for (final permission in ['view:products', 'manage:products']) {
        final fixture = _Fixture();
        fixture.permissions.remove(permission);

        await expectLater(
          fixture.access().setCategories(_input()),
          throwsStateError,
        );

        expect(fixture.writes, 0);
      }

      final fixture = _Fixture();
      fixture.permissions.remove('manage:products');

      expect((await fixture.access().getProduct('product'))?.id, 'product');
      expect(await fixture.access().getCategories(), [' B ', 'A', 'B']);
      expect(fixture.writes, 0);

      fixture.permissions.remove('view:products');

      await expectLater(
        fixture.access().getProduct('product'),
        throwsStateError,
      );
      await expectLater(fixture.access().getCategories(), throwsStateError);

      expect(fixture.reads, 2);
    },
  );

  test(
    'category RPC rejects invalid owner target and every invalid input before dispatch',
    () async {
      final fixture = _Fixture();

      for (final access in [
        fixture.access(scope: ''),
        fixture.access(productId: ''),
      ]) {
        expect(access.checkCurrent, throwsFormatException);
      }

      for (final input in [
        _input(id: 'foreign'),
        _input(categories: [' ']),
        _input(categories: [List.filled(128, 'a').join()]),
        _input(categories: [String.fromCharCode(0xd800)]),
      ]) {
        await expectLater(
          fixture.access().setCategories(input),
          throwsFormatException,
        );
      }

      expect(fixture.writes, 0);
      expect(fixture.reads, 0);
    },
  );

  test(
    'category RPC rejects stale or view-revoked list and detail responses',
    () async {
      for (final list in [false, true]) {
        for (final revoke in [false, true]) {
          final fixture = _Fixture();
          fixture.onRead = () async {
            if (revoke) {
              fixture.permissions.remove('view:products');
            } else {
              fixture.current = false;
            }
          };
          final access = fixture.access();

          await expectLater(
            list ? access.getCategories() : access.getProduct('product'),
            throwsStateError,
          );

          expect(fixture.reads, 1);
          expect(fixture.writes, 0);
        }
      }
    },
  );

  test(
    'category RPC rechecks actor and both write permissions after dispatch',
    () async {
      for (final permission in [null, 'view:products', 'manage:products']) {
        final fixture = _Fixture();
        fixture.onWrite = () async {
          if (permission == null) {
            fixture.current = false;
          } else {
            fixture.permissions.remove(permission);
          }
        };

        await expectLater(
          fixture.access().setCategories(_input()),
          throwsStateError,
        );

        expect(fixture.writes, 1);
        expect(fixture.reads, 0);
      }
    },
  );

  test(
    'category RPC requires genuine success rather than a false acknowledgement',
    () async {
      final fixture = _Fixture();
      fixture.success = false;

      await expectLater(
        fixture.access().setCategories(_input()),
        throwsFormatException,
      );

      expect(fixture.writes, 1);
      expect(fixture.reads, 0);
    },
  );

  test(
    'category RPC rejects foreign read targets and mismatched readback IDs',
    () async {
      final fixture = _Fixture();
      final access = fixture.access();

      await expectLater(access.getProduct(''), throwsFormatException);
      await expectLater(access.getProduct('foreign'), throwsFormatException);

      expect(fixture.reads, 0);

      fixture.responseId = 'foreign';

      await expectLater(access.getProduct('product'), throwsFormatException);

      expect(fixture.reads, 1);
      expect(fixture.writes, 0);
    },
  );

  test(
    'category RPC copies raw options categories and unrelated unit snapshots',
    () async {
      final fixture = _Fixture();
      final access = fixture.access();

      final product = (await access.getProduct('product'))!;
      final options = await access.getCategories();

      fixture.categories.clear();
      fixture.options.clear();
      fixture.units['box'] = 99;

      expect(product.categories, ['Old']);
      expect(product.otherUnits.values, {'box': 2});
      expect(options, [' B ', 'A', 'B']);
      expect(product.categories.clear, throwsUnsupportedError);
      expect(options.clear, throwsUnsupportedError);
      expect(() {
        product.otherUnits.values.clear();
      }, throwsUnsupportedError);
    },
  );

  test(
    'category RPC freezes raw input before an asynchronous writer can observe changes',
    () async {
      final fixture = _Fixture();
      final entered = Completer<void>();
      final release = Completer<void>();
      final categories = [' New ', 'new'];
      fixture.onWrite = () async {
        entered.complete();
        await release.future;
      };

      final writing = fixture.access().setCategories(
        _input(categories: categories),
      );
      await entered.future.timeout(const Duration(seconds: 5));

      try {
        categories.clear();
        final input = fixture.writeInput as models.ProductsCategoriesSetInput;

        expect(input.categories, [' New ', 'new']);
        expect(input.categories.clear, throwsUnsupportedError);
      } finally {
        release.complete();
      }

      expect((await writing).success, isTrue);
      expect(fixture.writes, 1);
    },
  );

  test(
    'category adapter rejects the actual unauthenticated final session',
    () async {
      final session = SessionController();
      addTearDown(session.dispose);
      final access = sessionProductCategoriesAccess(
        session,
        productId: 'product',
      );
      final other = sessionProductCategoriesAccess(session, productId: 'other');

      expect(session.authenticated, isFalse);
      expect(jsonDecode(access.scope), [null, null, null, 'product']);
      expect(other.scope, isNot(access.scope));
      expect(access.checkCurrent, throwsStateError);
      await expectLater(access.getCategories(), throwsStateError);
      await expectLater(access.getProduct('product'), throwsStateError);
      await expectLater(access.setCategories(_input()), throwsStateError);
    },
  );
}

models.ProductsCategoriesSetInput _input({
  String id = 'product',
  List<String> categories = const [' New ', 'new'],
}) {
  return models.ProductsCategoriesSetInput(id: id, categories: categories);
}

final class _Fixture {
  final permissions = {'view:products', 'manage:products'};
  final units = <String, num>{'box': 2};
  final categories = ['Old'];
  final options = [' B ', 'A', 'B'];
  bool current = true;
  bool success = true;
  String responseId = 'product';
  int reads = 0;
  int writes = 0;
  RpcValue? writeInput;
  models.ProductsGetInput? readInput;
  Future<void> Function()? onRead;
  Future<void> Function()? onWrite;

  ProductCategoriesRpcAccess access({
    String scope = 'origin|tenant|actor|product',
    String productId = 'product',
  }) {
    return ProductCategoriesRpcAccess(
      scope: scope,
      productId: productId,
      read: read,
      write: write,
      isCurrent: () {
        return current;
      },
      can: permissions.contains,
    );
  }

  Future<O> read<I, O>(RpcQuery<I, O> query, I input) async {
    reads++;
    final callback = onRead;

    if (callback != null) {
      await callback();
    }

    if (query == ApiQueries.productsCategoriesList) {
      expect(input, isA<models.ProductsCategoriesListInput>());

      return options as O;
    }

    expect(query, same(ApiQueries.productsGet));

    readInput = input as models.ProductsGetInput;

    return models.Product(
          id: responseId,
          customId: 10,
          name: 'Product',
          baseUnit: 'kg',
          otherUnits: models.ApplyPriceImportRowOtherUnits(units),
          categories: categories,
        )
        as O;
  }

  Future<O> write<I, O>(RpcMutation<I, O> mutation, I input) async {
    expect(mutation, same(ApiMutations.productsCategoriesSet));

    writes++;
    writeInput = input as RpcValue;
    final callback = onWrite;

    if (callback != null) {
      await callback();
    }

    return models.ProductsCategoriesSetOutput(success: success) as O;
  }
}
