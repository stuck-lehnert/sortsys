import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/contract.dart' show jsonMap;
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/features/tools/secure_tool_receipts.dart';
import 'package:sortsys_client/features/tools/tool_draft.dart';
import 'package:sortsys_client/features/tools/tool_receipt.dart';
import 'package:sortsys_client/features/tools/tool_write_access.dart';
import 'package:sortsys_client/features/tools/tool_write_coordinator.dart';

const _scope = '["https://example.test","tenant","actor","tool"]';
const _createScope = '["https://example.test","tenant","actor",null]';
const _nonce = '0123456789abcdef0123456789abcdef';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    // All receipt I/O uses the in-memory plugin, never native storage.
    FlutterSecureStorage.setMockInitialValues({});
  });

  test(
    'secure tool receipts persist and repeat only exact forward stages',
    () async {
      for (final create in [false, true]) {
        final store = SecureToolReceipts();
        final prepared = _receipt(create: create);
        final started = prepared.started();
        final acknowledged = _ack(started);

        for (final receipt in [prepared, started, acknowledged]) {
          await store.write(receipt);
          await store.write(receipt);

          expect((await store.read(receipt.scope))!.encode(), receipt.encode());
          expect(
            await const FlutterSecureStorage().read(key: _key(receipt.scope)),
            receipt.encode(),
          );
        }
      }
    },
  );

  test(
    'secure tool journals isolate origin tenant actor target and create scopes',
    () async {
      FlutterSecureStorage.setMockInitialValues({'unrelated': 'preserved'});

      final store = SecureToolReceipts();
      final receipts = [
        _receipt(),
        _receipt(scope: '["https://other.test","tenant","actor","tool"]'),
        _receipt(scope: '["https://example.test","other","actor","tool"]'),
        _receipt(scope: '["https://example.test","tenant","äctor","tool"]'),
        _receipt(
          scope: '["https://example.test","tenant","actor","other"]',
          id: 'other',
        ),
        _receipt(create: true),
      ];

      for (final receipt in receipts) {
        await store.write(receipt);
      }

      await store.clear(_scope);

      expect(await store.read(_scope), isNull);

      for (final receipt in receipts.skip(1)) {
        expect((await store.read(receipt.scope))!.encode(), receipt.encode());
      }

      expect(
        await const FlutterSecureStorage().read(key: 'unrelated'),
        'preserved',
      );
    },
  );

  test(
    'secure tool scopes reject surrogate key collisions before cleanup',
    () async {
      final store = SecureToolReceipts();
      final valid = _receipt(scope: '\ufffd');

      await store.write(valid);

      expect(_key(String.fromCharCode(0xd800)), _key(valid.scope));
      expect(_key(String.fromCharCode(0xdc00)), _key(valid.scope));

      for (final scope in [
        '',
        String.fromCharCode(0xd800),
        String.fromCharCode(0xdc00),
      ]) {
        await expectLater(store.read(scope), throwsFormatException);
        await expectLater(store.clear(scope), throwsFormatException);
      }

      expect((await store.read(valid.scope))!.encode(), valid.encode());
    },
  );

  test(
    'secure tool readers reject corrupt oversized foreign and v2 envelopes',
    () async {
      final store = SecureToolReceipts();
      final valid = _receipt();
      final versionTwo = _versionTwo(valid);

      for (final encoded in [
        '{bad',
        ''.padLeft(131073, 'x'),
        _receipt(scope: 'foreign').encode(),
        versionTwo,
      ]) {
        FlutterSecureStorage.setMockInitialValues({_key(_scope): encoded});

        await expectLater(store.read(_scope), throwsFormatException);
        await expectLater(store.write(valid), throwsFormatException);
        expect(
          await const FlutterSecureStorage().read(key: _key(_scope)),
          encoded,
        );
      }
    },
  );

  test(
    'invalid and oversized tool writes retain the current exact intent',
    () async {
      final store = SecureToolReceipts();
      final prepared = _receipt();

      await store.write(prepared);

      await expectLater(
        Future.sync(() {
          return store.write(_receipt(nonce: 'invalid'));
        }),
        throwsFormatException,
      );
      await expectLater(
        store.write(_receipt(brand: ''.padLeft(70000, 'ä'))),
        throwsA(
          isA<FormatException>().having(
            (error) {
              return error.message;
            },
            'UTF8 size failure',
            'TOOL_RECEIPT_TOO_LARGE',
          ),
        ),
      );

      expect((await store.read(_scope))!.encode(), prepared.encode());
    },
  );

  test(
    'secure tool stages reject skipped regressive and changed intent or IDs',
    () async {
      final store = SecureToolReceipts();
      final prepared = _receipt();
      final started = prepared.started();
      final acknowledged = _ack(started);

      await expectLater(store.write(started), throwsFormatException);
      await expectLater(store.write(acknowledged), throwsFormatException);
      expect(await store.read(_scope), isNull);

      await store.write(prepared);

      for (final changed in [
        _receipt(nonce: 'ffffffffffffffffffffffffffffffff'),
        _receipt(brand: 'Changed baseline'),
        _receipt(wanted: 'Changed input'),
        _receipt(createdAt: DateTime.utc(2025)),
        _receipt(create: true, scope: _scope),
        acknowledged,
      ]) {
        await expectLater(store.write(changed), throwsFormatException);
        expect((await store.read(_scope))!.encode(), prepared.encode());
      }

      await store.write(started);
      await expectLater(store.write(prepared), throwsFormatException);
      await store.write(acknowledged);
      await expectLater(store.write(started), throwsFormatException);

      expect((await store.read(_scope))!.encode(), acknowledged.encode());

      final creation = _receipt(create: true);
      final creating = creation.started();
      final created = _ack(creating);

      await store.write(creation);
      await store.write(creating);
      await store.write(created);
      await expectLater(
        store.write(
          creating.confirmedCreate(
            const models.ToolsCreateOutput(id: 'other-created'),
          ),
        ),
        throwsFormatException,
      );
      expect((await store.read(_createScope))!.encode(), created.encode());
    },
  );

  test(
    'incompatible tool journal blocks actual coordinator before business IO',
    () async {
      final store = SecureToolReceipts();
      final encoded = _versionTwo(_receipt());
      final access = _Access();
      final coordinator = ToolWriteCoordinator(access: access, receipts: store);

      FlutterSecureStorage.setMockInitialValues({_key(_scope): encoded});

      await expectLater(coordinator.outstanding(), throwsFormatException);
      await expectLater(
        coordinator.save(_draft(), baseline: _tool()),
        throwsFormatException,
      );
      await expectLater(
        coordinator.recover(expectedNonce: _nonce),
        throwsFormatException,
      );
      expect(access.reads, 0);
      expect(access.writes, 0);
      expect(
        await const FlutterSecureStorage().read(key: _key(_scope)),
        encoded,
      );
    },
  );

  test(
    'actual tool coordinator persists secure stages and recovers ACK once',
    () async {
      final store = SecureToolReceipts();
      final access = _Access();
      final coordinator = ToolWriteCoordinator(access: access, receipts: store);

      final saved = await coordinator.save(_draft(), baseline: _tool());

      expect(saved.brand, 'Brand');
      expect(access.writes, 1);
      expect(access.reads, 2);
      expect(await store.read(_scope), isNull);

      final prepared = _receipt();
      final started = prepared.started();
      final acknowledged = _ack(started);

      await store.write(prepared);
      await store.write(started);
      await store.write(acknowledged);

      final recovered = await coordinator.recover(expectedNonce: _nonce);

      expect(recovered!.brand, 'Brand');
      expect(access.writes, 1);
      expect(access.reads, 3);
      expect(await store.read(_scope), isNull);
    },
  );

  test(
    'secure dispatch intent never replays or infers matching tool success',
    () async {
      final store = SecureToolReceipts();
      final prepared = _receipt();
      final started = prepared.started();
      final access = _Access();
      access.tool = _tool(brand: 'Brand');

      final coordinator = ToolWriteCoordinator(access: access, receipts: store);

      await store.write(prepared);
      await store.write(started);

      await expectLater(
        coordinator.recover(expectedNonce: _nonce),
        throwsA(
          isA<ToolWriteException>().having(
            (error) {
              return error.failure;
            },
            'failure',
            ToolWriteFailure.uncertain,
          ),
        ),
      );
      await expectLater(
        coordinator.save(_draft(), baseline: _tool()),
        throwsA(
          isA<ToolWriteException>().having(
            (error) {
              return error.failure;
            },
            'failure',
            ToolWriteFailure.outstanding,
          ),
        ),
      );
      expect(access.reads, 0);
      expect(access.writes, 0);
      expect((await store.read(_scope))!.encode(), started.encode());
    },
  );
}

String _key(String scope) {
  return 'sortsys.tool_write.v1.${base64UrlEncode(utf8.encode(scope))}';
}

String _versionTwo(ToolWriteReceipt receipt) {
  final envelope = jsonMap(jsonDecode(receipt.encode()));
  final data = jsonMap(envelope['json']);
  data['version'] = 2;

  return jsonEncode(envelope);
}

ToolDraft _draft({
  bool create = false,
  String id = 'tool',
  String brand = 'Brand',
}) {
  return ToolDraft(
    toolId: create ? null : id,
    customId: '43',
    brand: brand,
    category: 'Category',
  );
}

models.Tool _tool({String id = 'tool', String brand = 'Before'}) {
  return models.Tool(
    id: id,
    customId: 42,
    brand: brand,
    category: 'Category',
    label: null,
    purchasePrice: null,
    usageCostPerDay: null,
    status: null,
    available: true,
    createdByUserId: 'actor',
    createdAt: DateTime.utc(2024),
    modifiedAt: DateTime.utc(2024, 2),
    archivedSince: null,
  );
}

ToolWriteReceipt _receipt({
  bool create = false,
  String? scope,
  String nonce = _nonce,
  String id = 'tool',
  String brand = 'Before',
  String wanted = 'Brand',
  DateTime? createdAt,
}) {
  return ToolWriteReceipt(
    scope: scope ?? (create ? _createScope : _scope),
    nonce: nonce,
    createdAt: createdAt ?? DateTime.utc(2024, 3),
    createInput: create
        ? _draft(create: true, brand: wanted).createInput()
        : null,
    updateInput: create ? null : _draft(id: id, brand: wanted).updateInput(),
    baseline: create ? null : _tool(id: id, brand: brand),
  );
}

ToolWriteReceipt _ack(ToolWriteReceipt receipt) {
  if (receipt.createInput != null) {
    return receipt.confirmedCreate(
      const models.ToolsCreateOutput(id: 'created'),
    );
  }

  return receipt.confirmedUpdate(const models.ToolsUpdateOutput(success: true));
}

// Domain coordinator fixture, not an authenticated SessionController.
final class _Access implements ToolWriteAccess {
  @override
  final String scope = _scope;

  @override
  final String toolId = 'tool';

  int reads = 0;
  int writes = 0;
  models.Tool tool = _tool();

  @override
  void checkCurrent() {
    // Transport/session authority is tested separately against the final class.
  }

  @override
  void checkCreate(models.ToolsCreateInput input) {
    throw StateError('UNEXPECTED_TOOL_CREATION');
  }

  @override
  void checkUpdate(models.ToolsUpdateInput input) {
    expect(input.id, toolId);
  }

  @override
  Future<models.Tool?> getTool(String id) async {
    expect(id, toolId);
    reads++;

    return tool;
  }

  @override
  Future<models.ToolsCreateOutput> createTool(
    models.ToolsCreateInput input,
  ) async {
    writes++;

    throw StateError('UNEXPECTED_TOOL_CREATION');
  }

  @override
  Future<models.ToolsUpdateOutput> updateTool(
    models.ToolsUpdateInput input,
  ) async {
    checkUpdate(input);
    writes++;
    tool = _tool(brand: input.data.brand.value);

    return const models.ToolsUpdateOutput(success: true);
  }
}
