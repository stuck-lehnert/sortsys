import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/api.g.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/api/model.dart';
import 'package:sortsys_client/api/procedure.dart';
import 'package:sortsys_client/features/products/product_price_rpc_access.dart';

void main() {
  test(
    'price RPC submits exact input and reads only explicitly acknowledged ID',
    () async {
      final fixture = _Fixture();
      fixture.records = [_record('other'), _record('price')];
      final access = fixture.access();
      final input = _input();

      final acknowledgement = await access.createPrice(input);
      final record = await access.priceRecord(acknowledgement.id, 'product');

      expect(fixture.writes, 1);
      expect(fixture.writeInput!.toWire(), input.toWire());
      expect(fixture.readInput!.toWire(), {'productId': 'product'});
      expect(record?.id, 'price');
      expect(fixture.permissions.contains('view:productVendors'), isFalse);
    },
  );

  test(
    'price RPC preserves UI and legacy API roles with read-only recovery',
    () async {
      for (final role in [
        'view:products',
        'view:productPriceRecords',
        'manage:productPriceRecords',
      ]) {
        final fixture = _Fixture();
        fixture.permissions.remove(role);

        await expectLater(
          fixture.access().createPrice(_input()),
          throwsStateError,
        );

        expect(fixture.writes, 0);
      }

      final fixture = _Fixture();
      fixture.permissions.remove('manage:productPriceRecords');
      final record = await fixture.access().priceRecord('price', 'product');

      expect(record?.id, 'price');
      expect(fixture.writes, 0);
      await expectLater(
        fixture.access().createPrice(_input(productId: 'other')),
        throwsStateError,
      );
      fixture.permissions.add('manage:productPriceRecords');

      await expectLater(
        fixture.access().createPrice(_input(productId: 'other')),
        throwsFormatException,
      );
      await expectLater(
        fixture.access(productId: '').createPrice(_input()),
        throwsFormatException,
      );

      expect(fixture.writes, 0);
    },
  );

  test('price RPC rejects owner or permission changes after I/O and empty acknowledgements', () async {
    final stale = _Fixture();
    stale.onWrite = () {
      stale.current = false;
    };

    await expectLater(stale.access().createPrice(_input()), throwsStateError);

    expect(stale.writes, 1);
    final revoked = _Fixture();
    revoked.onRead = () {
      revoked.permissions.remove('view:productPriceRecords');
    };

    await expectLater(
      revoked.access().priceRecord('price', 'product'),
      throwsStateError,
    );

    final invalid = _Fixture()..acknowledgementId = '';

    await expectLater(
      invalid.access().createPrice(_input()),
      throwsFormatException,
    );
  });

  test(
    'price RPC rejects foreign or duplicate rows and never infers missing IDs',
    () async {
      final fixture = _Fixture();
      final access = fixture.access();
      fixture.records = [_record('other')];

      expect(await access.priceRecord('price', 'product'), isNull);
      fixture.records = [_record('price'), _record('price')];

      await expectLater(
        access.priceRecord('price', 'product'),
        throwsFormatException,
      );
      fixture.records = [_record('price', productId: 'foreign')];

      await expectLater(
        access.priceRecord('price', 'product'),
        throwsFormatException,
      );
      final reads = fixture.reads;

      await expectLater(
        access.priceRecord('', 'product'),
        throwsFormatException,
      );
      await expectLater(
        access.priceRecord('price', 'foreign'),
        throwsFormatException,
      );

      expect(fixture.reads, reads);
      expect(fixture.writes, 0);
    },
  );
}

models.ProductsPriceRecordsCreateInput _input({String productId = 'product'}) {
  return models.ProductsPriceRecordsCreateInput(
    productId: productId,
    pricePerBaseUnit: 5,
    timestamp: DateTime.utc(2024),
    isRealPurchase: false,
    comment: const RpcOptional.value(''),
  );
}

models.ProductsPriceRecordsListResultItem _record(
  String id, {
  String productId = 'product',
}) {
  return models.ProductsPriceRecordsListResultItem(
    id: id,
    productId: productId,
    timestamp: DateTime.utc(2024),
    price: 5,
    isRealPurchase: false,
  );
}

final class _Fixture {
  final permissions = {
    'view:products',
    'view:productPriceRecords',
    'manage:productPriceRecords',
  };
  bool current = true;
  int writes = 0;
  int reads = 0;
  String acknowledgementId = 'price';
  List<models.ProductsPriceRecordsListResultItem> records = [_record('price')];
  models.ProductsPriceRecordsCreateInput? writeInput;
  models.ProductsPriceRecordsListInput? readInput;
  void Function()? onWrite;
  void Function()? onRead;

  ProductPriceRpcAccess access({String productId = 'product'}) {
    return ProductPriceRpcAccess(
      scope: 'origin|tenant|actor|product',
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
    expect(query, same(ApiQueries.productsPriceRecordsList));
    reads++;
    readInput = input as models.ProductsPriceRecordsListInput;
    onRead?.call();

    return records as O;
  }

  Future<O> write<I, O>(RpcMutation<I, O> mutation, I input) async {
    expect(mutation, same(ApiMutations.productsPriceRecordsCreate));
    writes++;
    writeInput = input as models.ProductsPriceRecordsCreateInput;
    onWrite?.call();

    return models.ProductsPriceRecordsCreateOutput(id: acknowledgementId) as O;
  }
}
