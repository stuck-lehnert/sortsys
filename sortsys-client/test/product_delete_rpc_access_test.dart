import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/api.g.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/api/procedure.dart';
import 'package:sortsys_client/features/products/product_delete_rpc_access.dart';
import 'package:sortsys_client/features/products/session_product_categories_access.dart';
import 'package:sortsys_client/features/products/session_product_delete_access.dart';
import 'package:sortsys_client/features/products/session_product_master_access.dart';
import 'package:sortsys_client/features/products/session_product_price_access.dart';
import 'package:sortsys_client/state/session_controller.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test(
    'product delete RPC uses exact known-ID get and delete contracts',
    () async {
      final fixture = _Fixture();
      final access = fixture.access();

      final product = await access.getProduct('product');
      final result = await access.deleteProduct(_input());

      expect(product.id, 'product');
      expect(result.success, isTrue);
      expect(fixture.readInput!.toWire(), {'id': 'product'});
      expect(fixture.writeInput!.toWire(), {'id': 'product'});
      expect(fixture.reads, 1);
      expect(fixture.writes, 1);
    },
  );

  test(
    'product delete RPC requires view and delete but permits view-only reads',
    () async {
      for (final permission in ['view:products', 'delete:products']) {
        final fixture = _Fixture();
        fixture.permissions.remove(permission);

        await expectLater(
          fixture.access().deleteProduct(_input()),
          throwsStateError,
        );
        expect(fixture.writes, 0);
      }

      final fixture = _Fixture();
      fixture.permissions.remove('delete:products');

      expect((await fixture.access().getProduct('product')).id, 'product');
      expect(fixture.reads, 1);

      fixture.permissions.remove('view:products');

      await expectLater(
        fixture.access().getProduct('product'),
        throwsStateError,
      );
      expect(fixture.reads, 1);
    },
  );

  test(
    'product delete RPC rejects invalid owners and foreign targets before I-O',
    () async {
      final fixture = _Fixture();

      for (final access in [
        fixture.access(scope: ''),
        fixture.access(productId: ''),
      ]) {
        expect(() {
          access.checkCurrent();
        }, throwsFormatException);
      }

      await expectLater(
        fixture.access().getProduct('foreign'),
        throwsFormatException,
      );
      await expectLater(
        fixture.access().deleteProduct(_input(id: 'foreign')),
        throwsFormatException,
      );
      expect(fixture.reads, 0);
      expect(fixture.writes, 0);
    },
  );

  test(
    'product delete RPC rejects stale view-revoked and mismatched reads',
    () async {
      for (final revoke in [false, true]) {
        final fixture = _Fixture();
        fixture.onRead = () async {
          if (revoke) {
            fixture.permissions.remove('view:products');
          } else {
            fixture.current = false;
          }
        };

        await expectLater(
          fixture.access().getProduct('product'),
          throwsStateError,
        );
        expect(fixture.reads, 1);
      }

      final fixture = _Fixture();
      fixture.responseId = 'foreign';

      await expectLater(
        fixture.access().getProduct('product'),
        throwsFormatException,
      );
      expect(fixture.reads, 1);
    },
  );

  test(
    'product delete RPC preserves genuine ACK after delete-role loss only',
    () async {
      final fixture = _Fixture();
      fixture.onWrite = () async {
        fixture.permissions.remove('delete:products');
      };

      expect((await fixture.access().deleteProduct(_input())).success, isTrue);
      expect(fixture.writes, 1);

      for (final revokeView in [false, true]) {
        final stale = _Fixture();
        stale.onWrite = () async {
          if (revokeView) {
            stale.permissions.remove('view:products');
          } else {
            stale.current = false;
          }
        };

        await expectLater(
          stale.access().deleteProduct(_input()),
          throwsStateError,
        );
        expect(stale.writes, 1);
      }
    },
  );

  test(
    'product delete RPC requires a genuine positive acknowledgement',
    () async {
      final fixture = _Fixture();
      fixture.success = false;

      await expectLater(
        fixture.access().deleteProduct(_input()),
        throwsFormatException,
      );
      expect(fixture.writes, 1);
      expect(fixture.reads, 0);
    },
  );

  test(
    'product delete RPC returns frozen raw product unit and category snapshots',
    () async {
      final fixture = _Fixture();

      final product = await fixture.access().getProduct('product');

      fixture.units.clear();
      fixture.categories.clear();

      expect(product.name, ' Raw product ');
      expect(product.baseUnit, ' pc ');
      expect(product.brand, ' Raw brand ');
      expect(product.description, isNull);
      expect(product.regieReportName, ' Raw report ');
      expect(product.otherUnits.values, {' Carton ': -2.5});
      expect(product.categories, [' Raw ', 'raw', 'raw']);
      expect(() {
        product.otherUnits.values.clear();
      }, throwsUnsupportedError);
      expect(() {
        product.categories.clear();
      }, throwsUnsupportedError);
    },
  );

  test(
    'real final session rejects product deletion and shares all product writer scopes',
    () async {
      final session = SessionController();
      addTearDown(session.dispose);

      final delete = sessionProductDeleteAccess(session, productId: 'product');
      final edit = sessionProductMasterWriteAccess(
        session,
        productId: 'product',
      );
      final price = sessionProductPriceWriteAccess(
        session,
        productId: 'product',
      );
      final categories = sessionProductCategoriesAccess(
        session,
        productId: 'product',
      );
      final inactive = sessionProductDeleteAccess(
        session,
        productId: 'product',
        isActive: () {
          return false;
        },
      );

      expect(delete.scope, edit.scope);
      expect(delete.scope, price.scope);
      expect(delete.scope, categories.scope);
      expect(jsonDecode(delete.scope), [null, null, null, 'product']);
      expect(delete.productId, 'product');
      expect(() {
        delete.checkCurrent();
      }, throwsStateError);
      expect(() {
        inactive.checkCurrent();
      }, throwsStateError);
      await expectLater(delete.getProduct('product'), throwsStateError);
      await expectLater(delete.deleteProduct(_input()), throwsStateError);
    },
  );
}

models.ProductsDeleteInput _input({String id = 'product'}) {
  return models.ProductsDeleteInput(id: id);
}

final class _Fixture {
  bool current = true;
  bool success = true;
  String responseId = 'product';
  int reads = 0;
  int writes = 0;
  final permissions = {'view:products', 'delete:products'};
  final units = <String, num>{' Carton ': -2.5};
  final categories = [' Raw ', 'raw', 'raw'];
  models.ProductsGetInput? readInput;
  models.ProductsDeleteInput? writeInput;
  Future<void> Function()? onRead;
  Future<void> Function()? onWrite;

  ProductDeleteRpcAccess access({
    String scope = 'origin|tenant|actor|product',
    String productId = 'product',
  }) {
    return ProductDeleteRpcAccess(
      scope: scope,
      productId: productId,
      read: read,
      write: write,
      isCurrent: () {
        return current;
      },
      can: (permission) {
        return permissions.contains(permission);
      },
    );
  }

  Future<O> read<I, O>(RpcQuery<I, O> query, I input) async {
    expect(identical(query, ApiQueries.productsGet), isTrue);

    reads++;
    readInput = input as models.ProductsGetInput;

    final callback = onRead;

    if (callback != null) {
      await callback();
    }

    return models.Product(
          id: responseId,
          customId: 7,
          name: ' Raw product ',
          brand: ' Raw brand ',
          regieReportName: ' Raw report ',
          baseUnit: ' pc ',
          otherUnits: models.ApplyPriceImportRowOtherUnits(units),
          categories: categories,
        )
        as O;
  }

  Future<O> write<I, O>(RpcMutation<I, O> mutation, I input) async {
    expect(identical(mutation, ApiMutations.productsDelete), isTrue);

    writes++;
    writeInput = input as models.ProductsDeleteInput;

    final callback = onWrite;

    if (callback != null) {
      await callback();
    }

    return models.ProductsDeleteOutput(success: success) as O;
  }
}
