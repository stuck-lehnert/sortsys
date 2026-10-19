import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/features/vendors/secure_vendor_receipts.dart';
import 'package:sortsys_client/features/vendors/vendor_draft.dart';
import 'package:sortsys_client/features/vendors/vendor_receipt.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    // Plugin operations use only this in-memory mock, never operator storage.
    FlutterSecureStorage.setMockInitialValues({});
  });

  test(
    'secure vendor receipts roundtrip create and edit durable stages',
    () async {
      final store = SecureVendorReceipts();

      for (final update in [false, true]) {
        final prepared = _receipt('origin|tenant|actor', update: update);
        final started = prepared.started();
        final confirmed = update
            ? started.confirmedUpdate(
                const models.ProductsVendorsUpdateOutput(success: true),
              )
            : started.confirmedCreate(
                const models.ProductsVendorsCreateOutput(id: 'vendor'),
              );

        for (final receipt in [prepared, started, confirmed]) {
          await store.write(receipt);

          expect((await store.read(receipt.scope))!.encode(), receipt.encode());
        }
      }
    },
  );

  test('secure vendor receipts isolate scopes and targeted deletion', () async {
    final store = SecureVendorReceipts();
    final first = _receipt('origin|tenant|actor');
    final other = _receipt('origin|tenant|other');

    await store.write(first);
    await store.write(other);
    await store.clear(first.scope);

    expect(await store.read(first.scope), isNull);
    expect((await store.read(other.scope))!.scope, other.scope);
  });

  test(
    'secure vendor receipts reject wrong-owner malformed and oversized data',
    () async {
      const scope = 'origin|tenant|actor';
      final key =
          'sortsys.vendor_write.v1.${base64UrlEncode(utf8.encode(scope))}';
      final store = SecureVendorReceipts();

      for (final value in [
        _receipt('foreign').encode(),
        '{bad',
        List.filled(131073, 'x').join(),
      ]) {
        FlutterSecureStorage.setMockInitialValues({key: value});

        await expectLater(store.read(scope), throwsFormatException);
      }
    },
  );
}

VendorWriteReceipt _receipt(String scope, {bool update = false}) {
  return VendorWriteReceipt(
    scope: scope,
    nonce: '0123456789abcdef0123456789abcdef',
    createdAt: DateTime.utc(2024),
    createInput: update
        ? null
        : const VendorDraft(name: 'Vendor').createInput(),
    updateInput: update
        ? const VendorDraft(name: 'Vendor', vendorId: 'vendor').updateInput()
        : null,
    baseline: update
        ? models.ProductVendor(
            id: 'vendor',
            name: 'Before',
            createdAt: DateTime.utc(2024),
            modifiedAt: DateTime.utc(2024),
          )
        : null,
  );
}
