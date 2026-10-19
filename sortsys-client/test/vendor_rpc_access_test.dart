import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/api.g.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/api/model.dart';
import 'package:sortsys_client/api/procedure.dart';
import 'package:sortsys_client/features/vendors/vendor_draft.dart';
import 'package:sortsys_client/features/vendors/vendor_rpc_access.dart';

void main() {
  test(
    'vendor RPC uses actual create update and known-ID get payloads',
    () async {
      for (final update in [false, true]) {
        final fixture = _Fixture();
        final access = fixture.access(vendorId: update ? 'vendor' : null);
        const draft = VendorDraft(name: 'Vendor', vendorId: 'vendor');

        if (update) {
          final result = await access.updateVendor(draft.updateInput());

          expect(result.success, isTrue);
          expect(fixture.writeInput?.toWire(), draft.updateInput().toWire());
        } else {
          final input = const VendorDraft(name: 'Vendor').createInput();
          final result = await access.createVendor(input);

          expect(result.id, 'vendor');
          expect(fixture.writeInput?.toWire(), input.toWire());
        }

        expect((await access.getVendor('vendor'))?.id, 'vendor');
        expect(fixture.readInput?.toWire(), {'id': 'vendor'});
        expect(fixture.writes, 1);
        expect(fixture.permissions, {
          'view:productVendors',
          'manage:productVendors',
        });
      }
    },
  );

  test(
    'vendor RPC requires actual roles but permits read-only recovery',
    () async {
      for (final role in ['view:productVendors', 'manage:productVendors']) {
        final fixture = _Fixture();
        fixture.permissions.remove(role);

        await expectLater(
          fixture.access().createVendor(
            const VendorDraft(name: 'Vendor').createInput(),
          ),
          throwsStateError,
        );
        await expectLater(
          fixture
              .access(vendorId: 'vendor')
              .updateVendor(
                const VendorDraft(
                  name: 'Vendor',
                  vendorId: 'vendor',
                ).updateInput(),
              ),
          throwsStateError,
        );

        expect(fixture.writes, 0);
      }

      final fixture = _Fixture();
      fixture.permissions.remove('manage:productVendors');

      expect(
        (await fixture.access(vendorId: 'vendor').getVendor('vendor'))?.id,
        'vendor',
      );
      expect(fixture.writes, 0);
    },
  );

  test(
    'vendor RPC rejects stale I/O and invalid genuine acknowledgements',
    () async {
      final stale = _Fixture();
      stale.onWrite = () {
        stale.current = false;
      };

      await expectLater(
        stale.access().createVendor(
          const VendorDraft(name: 'Vendor').createInput(),
        ),
        throwsStateError,
      );
      expect(stale.writes, 1);

      final revoked = _Fixture();
      revoked.onRead = () {
        revoked.permissions.remove('view:productVendors');
      };

      await expectLater(revoked.access().getVendor('vendor'), throwsStateError);

      final invalid = _Fixture()..acknowledgementId = '';

      await expectLater(
        invalid.access().createVendor(
          const VendorDraft(name: 'Vendor').createInput(),
        ),
        throwsFormatException,
      );
      invalid.success = false;

      await expectLater(
        invalid
            .access(vendorId: 'vendor')
            .updateVendor(
              const VendorDraft(
                name: 'Vendor',
                vendorId: 'vendor',
              ).updateInput(),
            ),
        throwsFormatException,
      );
    },
  );

  test('vendor RPC rejects foreign contexts noncanonical payload and wrong readback', () async {
    final fixture = _Fixture();
    final edit = fixture.access(vendorId: 'vendor');

    await expectLater(
      edit.createVendor(const VendorDraft(name: 'Vendor').createInput()),
      throwsFormatException,
    );
    await expectLater(
      edit.updateVendor(
        const VendorDraft(name: 'Vendor', vendorId: 'foreign').updateInput(),
      ),
      throwsFormatException,
    );
    await expectLater(edit.getVendor('foreign'), throwsFormatException);
    await expectLater(edit.getVendor(''), throwsFormatException);
    await expectLater(
      fixture.access().createVendor(
        const models.ProductsVendorsCreateInput(
          name: ' Padded ',
          description: RpcOptional.value(null),
        ),
      ),
      throwsFormatException,
    );

    expect(fixture.writes, 0);
    expect(fixture.reads, 0);
    fixture.responseId = 'foreign';

    await expectLater(edit.getVendor('vendor'), throwsFormatException);
    expect(fixture.reads, 1);
  });
  test(
    'vendor delete RPC uses exact known ID and delete rather than manage role',
    () async {
      final fixture = _Fixture();
      fixture.permissions.add('delete:productVendors');
      fixture.permissions.remove('manage:productVendors');
      final result = await fixture
          .access(vendorId: 'vendor')
          .deleteVendor(const models.ProductsVendorsDeleteInput(id: 'vendor'));

      expect(result.success, isTrue);
      expect(fixture.writeInput?.toWire(), {'id': 'vendor'});
      expect(fixture.writes, 1);
      expect(fixture.reads, 0);
    },
  );

  test('vendor delete RPC rejects missing roles foreign owners stale replies and false acknowledgement', () async {
    for (final role in ['view:productVendors', 'delete:productVendors']) {
      final fixture = _Fixture();
      fixture.permissions.add('delete:productVendors');
      fixture.permissions.remove(role);

      await expectLater(
        fixture
            .access(vendorId: 'vendor')
            .deleteVendor(
              const models.ProductsVendorsDeleteInput(id: 'vendor'),
            ),
        throwsStateError,
      );
      expect(fixture.writes, 0);
    }

    for (final context in <String?>[null, 'foreign', '']) {
      final fixture = _Fixture();
      fixture.permissions.add('delete:productVendors');

      await expectLater(
        fixture
            .access(vendorId: context)
            .deleteVendor(
              const models.ProductsVendorsDeleteInput(id: 'vendor'),
            ),
        throwsFormatException,
      );
      expect(fixture.writes, 0);
    }

    for (final revokeRole in [false, true]) {
      final fixture = _Fixture();
      fixture.permissions.add('delete:productVendors');
      fixture.onWrite = () {
        if (revokeRole) {
          fixture.permissions.remove('delete:productVendors');
        } else {
          fixture.current = false;
        }
      };

      await expectLater(
        fixture
            .access(vendorId: 'vendor')
            .deleteVendor(
              const models.ProductsVendorsDeleteInput(id: 'vendor'),
            ),
        throwsStateError,
      );
      expect(fixture.writes, 1);
    }

    final invalid = _Fixture();
    invalid.permissions.add('delete:productVendors');
    invalid.success = false;

    await expectLater(
      invalid
          .access(vendorId: 'vendor')
          .deleteVendor(const models.ProductsVendorsDeleteInput(id: 'vendor')),
      throwsFormatException,
    );
    expect(invalid.writes, 1);
  });
}

final class _Fixture {
  final permissions = {'view:productVendors', 'manage:productVendors'};
  bool current = true;
  bool success = true;
  String acknowledgementId = 'vendor';
  String responseId = 'vendor';
  int writes = 0;
  int reads = 0;
  RpcValue? writeInput;
  models.ProductsVendorsGetInput? readInput;
  void Function()? onWrite;
  void Function()? onRead;

  VendorRpcAccess access({String? vendorId}) {
    return VendorRpcAccess(
      scope: 'origin|tenant|actor|$vendorId',
      vendorId: vendorId,
      read: read,
      write: write,
      isCurrent: () {
        return current;
      },
      can: permissions.contains,
    );
  }

  Future<O> read<I, O>(RpcQuery<I, O> query, I input) async {
    expect(query, same(ApiQueries.productsVendorsGet));
    reads++;
    readInput = input as models.ProductsVendorsGetInput;
    onRead?.call();

    return models.ProductVendor(
      id: responseId,
      name: 'Vendor',
      createdAt: DateTime.utc(2024),
      modifiedAt: DateTime.utc(2024),
    ) as O;
  }

  Future<O> write<I, O>(RpcMutation<I, O> mutation, I input) async {
    writes++;
    writeInput = input as RpcValue;
    onWrite?.call();

    if (mutation == ApiMutations.productsVendorsCreate) {
      return models.ProductsVendorsCreateOutput(id: acknowledgementId) as O;
    }

    if (mutation == ApiMutations.productsVendorsDelete) {
      return models.ProductsVendorsDeleteOutput(success: success) as O;
    }

    expect(mutation, same(ApiMutations.productsVendorsUpdate));

    return models.ProductsVendorsUpdateOutput(success: success) as O;
  }
}
