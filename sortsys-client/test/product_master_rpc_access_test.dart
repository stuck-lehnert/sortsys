import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/api.g.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/api/model.dart';
import 'package:sortsys_client/api/procedure.dart';
import 'package:sortsys_client/features/products/product_draft.dart';
import 'package:sortsys_client/features/products/product_master_rpc_access.dart';

void main() {
  test(
    'product master uses exact create update and genuine-ID get contracts',
    () async {
      for (final update in [false, true]) {
        final fixture = _Fixture();
        final access = fixture.access(productId: update ? 'product' : null);
        final draft = _draft(update: update);

        if (update) {
          final input = draft.updateInput();
          final result = await access.updateProduct(input);

          expect(result.success, isTrue);
          expect(fixture.writeInput?.toWire(), input.toWire());
          expect(input.data.customId.isAbsent, isTrue);
        } else {
          final input = draft.createInput();
          final result = await access.createProduct(input);

          expect(result.id, 'product');
          expect(fixture.writeInput?.toWire(), input.toWire());
        }

        final product = (await access.getProduct('product'))!;

        expect(fixture.readInput?.toWire(), {'id': 'product'});
        expect(product.name, 'Product');
        expect(product.otherUnits.values, {'box': 2});
        expect(fixture.writes, 1);
        expect(fixture.reads, 1);
        fixture.units['box'] = 3;

        expect(product.otherUnits.values['box'], 2);
        expect(() {
          product.otherUnits.values['box'] = 4;
        }, throwsUnsupportedError);
        expect(product.categories.clear, throwsUnsupportedError);
      }
    },
  );

  test(
    'product master requires actual roles but permits view-only recovery',
    () async {
      for (final role in ['view:products', 'manage:products']) {
        final fixture = _Fixture();
        fixture.permissions.remove(role);

        await expectLater(
          fixture.access().createProduct(_draft().createInput()),
          throwsStateError,
        );
        await expectLater(
          fixture
              .access(productId: 'product')
              .updateProduct(_draft(update: true).updateInput()),
          throwsStateError,
        );
        expect(fixture.writes, 0);
      }

      final fixture = _Fixture();
      fixture.permissions.remove('manage:products');
      final product = await fixture
          .access(productId: 'product')
          .getProduct('product');

      expect(product?.id, 'product');
      expect(fixture.writes, 0);
    },
  );

  test('product master rejects noncanonical fields units bounds and edit number patches', () async {
    final fixture = _Fixture();
    final create = fixture.access();

    for (final input in [
      _input(customId: -1),
      _input(customId: 1.5),
      _input(customId: double.infinity),
      _input(customId: 2147483648),
      _input(name: ' Product '),
      _input(name: List.filled(128, 'ä').join()),
      _input(baseUnit: '123456789'),
      _input(brand: const RpcOptional.absent()),
      _input(brand: const RpcOptional.undefined()),
      _input(brand: const RpcOptional.value('')),
      _input(brand: const RpcOptional.value(' padded ')),
      _input(units: const RpcOptional.absent()),
      _input(
        units: const RpcOptional.value(
          models.ApplyPriceImportRowOtherUnits({' box ': 2}),
        ),
      ),
      _input(
        units: const RpcOptional.value(
          models.ApplyPriceImportRowOtherUnits({'box': -1}),
        ),
      ),
      _input(
        units: RpcOptional.value(
          models.ApplyPriceImportRowOtherUnits({'box': double.nan}),
        ),
      ),
    ]) {
      await expectLater(create.createProduct(input), throwsFormatException);
    }

    final valid = _draft(update: true).updateInput();

    for (final number in [
      const RpcOptional<num>.value(99),
      const RpcOptional<num>.undefined(),
    ]) {
      final data = valid.data;
      final input = models.ProductsUpdateInput(
        id: valid.id,
        data: models.ProductsUpdateRequestData(
          customId: number,
          name: data.name,
          brand: data.brand,
          description: data.description,
          regieReportName: data.regieReportName,
          baseUnit: data.baseUnit,
          otherUnits: data.otherUnits,
        ),
      );

      await expectLater(
        fixture.access(productId: 'product').updateProduct(input),
        throwsFormatException,
      );
    }

    expect(fixture.writes, 0);
    await create.createProduct(
      _input(
        customId: 0,
        units: const RpcOptional.value(
          models.ApplyPriceImportRowOtherUnits({'zero': 0}),
        ),
      ),
    );

    expect(fixture.writes, 1);
  });

  test('product master rejects foreign contexts stale responses and false acknowledgements', () async {
    final fixture = _Fixture();
    final edit = fixture.access(productId: 'product');

    await expectLater(
      edit.createProduct(_draft().createInput()),
      throwsFormatException,
    );
    await expectLater(
      fixture.access().updateProduct(_draft(update: true).updateInput()),
      throwsFormatException,
    );
    await expectLater(edit.getProduct('foreign'), throwsFormatException);
    await expectLater(edit.getProduct(''), throwsFormatException);

    expect(fixture.writes, 0);
    expect(fixture.reads, 0);
    fixture.responseId = 'foreign';

    await expectLater(edit.getProduct('product'), throwsFormatException);
    fixture.responseId = 'product';
    fixture.creationId = '';

    await expectLater(
      fixture.access().createProduct(_draft().createInput()),
      throwsFormatException,
    );
    fixture.success = false;

    await expectLater(
      edit.updateProduct(_draft(update: true).updateInput()),
      throwsFormatException,
    );

    for (final permission in ['view:products', 'manage:products']) {
      final revoked = _Fixture();
      revoked.onWrite = () {
        revoked.permissions.remove(permission);
      };

      await expectLater(
        revoked.access().createProduct(_draft().createInput()),
        throwsStateError,
      );
      expect(revoked.writes, 1);
    }

    final stale = _Fixture();
    stale.onRead = () {
      stale.current = false;
    };

    await expectLater(stale.access().getProduct('product'), throwsStateError);
  });
}

ProductDraft _draft({bool update = false}) {
  return ProductDraft(
    productId: update ? 'product' : null,
    customId: '10',
    name: 'Product',
    baseUnit: 'kg',
    units: const [ProductUnitDraft(name: 'box', amount: '2')],
  );
}

models.ProductsCreateInput _input({
  num customId = 10,
  String name = 'Product',
  String baseUnit = 'kg',
  RpcOptional<String?> brand = const RpcOptional.value(null),
  RpcOptional<models.ApplyPriceImportRowOtherUnits> units =
      const RpcOptional.value(models.ApplyPriceImportRowOtherUnits({})),
}) {
  return models.ProductsCreateInput(
    customId: customId,
    name: name,
    baseUnit: baseUnit,
    brand: brand,
    description: const RpcOptional.value(null),
    regieReportName: const RpcOptional.value(null),
    otherUnits: units,
  );
}

final class _Fixture {
  final permissions = {'view:products', 'manage:products'};
  final units = <String, num>{'box': 2};
  bool current = true;
  bool success = true;
  String creationId = 'product';
  String responseId = 'product';
  int writes = 0;
  int reads = 0;
  RpcValue? writeInput;
  models.ProductsGetInput? readInput;
  void Function()? onWrite;
  void Function()? onRead;

  ProductMasterRpcAccess access({String? productId}) {
    return ProductMasterRpcAccess(
      scope: 'origin|tenant|actor|$productId',
      productId: productId,
      read: read,
      write: write,
      isCurrent: () {
        return current;
      },
      can: permissions.contains,
    );
  }

  Future<O> write<I, O>(RpcMutation<I, O> mutation, I input) async {
    writes++;
    writeInput = input as RpcValue;
    onWrite?.call();

    if (mutation == ApiMutations.productsCreate) {
      return models.ProductsCreateOutput(id: creationId) as O;
    }

    expect(mutation, same(ApiMutations.productsUpdate));

    return models.ProductsUpdateOutput(success: success) as O;
  }

  Future<O> read<I, O>(RpcQuery<I, O> query, I input) async {
    expect(query, same(ApiQueries.productsGet));
    reads++;
    readInput = input as models.ProductsGetInput;
    onRead?.call();

    return models.Product(
      id: responseId,
      customId: 10,
      name: 'Product',
      baseUnit: 'kg',
      otherUnits: models.ApplyPriceImportRowOtherUnits(units),
      categories: [],
    ) as O;
  }
}
