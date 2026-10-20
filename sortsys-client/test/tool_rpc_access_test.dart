import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/api.g.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/api/procedure.dart';
import 'package:sortsys_client/features/tools/session_tool_access.dart';
import 'package:sortsys_client/features/tools/tool_draft.dart';
import 'package:sortsys_client/features/tools/tool_receipt.dart';
import 'package:sortsys_client/features/tools/tool_rpc_access.dart';
import 'package:sortsys_client/state/session_controller.dart';

const _editScope = '["https://example.test","tenant","actor","tool"]';
const _createScope = '["https://example.test","tenant","actor",null]';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('tool create RPC copies exact owned payload without status', () async {
    final cases = <(ToolDraft, Map<String, Object?>)>[
      (
        _draft(create: true),
        {
          'customId': 43,
          'brand': 'Brand',
          'category': 'Category',
          'label': null,
          'purchasePrice': null,
          'usageCostPerDay': null,
        },
      ),
      (
        const ToolDraft(
          customId: '44',
          brand: 'Other',
          category: 'Other category',
          label: 'Model',
          purchasePrice: '5,5',
          usageCostPerDay: '0',
        ),
        {
          'customId': 44,
          'brand': 'Other',
          'category': 'Other category',
          'label': 'Model',
          'purchasePrice': 5.5,
          'usageCostPerDay': 0.0,
        },
      ),
    ];

    for (final (draft, payload) in cases) {
      final fixture = _Fixture();
      final input = draft.createInput();

      final result = await fixture.access(toolId: null).createTool(input);

      expect(result.id, 'created');
      expect(fixture.createInput, isNot(same(input)));
      expect(fixture.createInput!.toWire(), payload);
      expect(fixture.createInput!.status.isAbsent, isTrue);
      expect(fixture.writes, ['tools.create']);
      expect(fixture.reads, 0);
    }
  });

  test(
    'tool update RPC copies six explicit fields and nullable clears',
    () async {
      final cases = <(ToolDraft, Map<String, Object?>)>[
        (
          _draft(),
          {
            'brand': 'Brand',
            'category': 'Category',
            'label': null,
            'purchasePrice': null,
            'usageCostPerDay': null,
            'status': null,
          },
        ),
        (
          const ToolDraft(
            toolId: 'tool',
            brand: 'Other',
            category: 'Other category',
            label: 'Model',
            purchasePrice: '123,45',
            usageCostPerDay: '0',
            status: models.ToolStatus.broken,
          ),
          {
            'brand': 'Other',
            'category': 'Other category',
            'label': 'Model',
            'purchasePrice': 123.45,
            'usageCostPerDay': 0.0,
            'status': 'broken',
          },
        ),
      ];

      for (final (draft, fields) in cases) {
        final fixture = _Fixture();
        final input = draft.updateInput();

        final result = await fixture.access().updateTool(input);

        expect(result.success, isTrue);
        expect(fixture.updateInput, isNot(same(input)));
        expect(fixture.updateInput!.data, isNot(same(input.data)));
        expect(fixture.updateInput!.toWire(), {'id': 'tool', 'data': fields});
        expect(fixture.writes, ['tools.update']);
        expect(fixture.reads, 0);
      }
    },
  );

  test(
    'tool RPC writes require view and manage while reads are view owned',
    () async {
      for (final permission in ['view:tools', 'manage:tools']) {
        final fixture = _Fixture();
        fixture.permissions.remove(permission);

        await expectLater(
          fixture.access().updateTool(_draft().updateInput()),
          throwsStateError,
        );
        await expectLater(
          fixture
              .access(toolId: null)
              .createTool(_draft(create: true).createInput()),
          throwsStateError,
        );
        expect(fixture.writes, isEmpty);
      }

      final fixture = _Fixture();
      fixture.permissions.remove('manage:tools');

      final tool = await fixture.access().getTool('tool');

      expect(tool!.id, 'tool');

      fixture.permissions.remove('view:tools');

      await expectLater(fixture.access().getTool('tool'), throwsStateError);
      expect(fixture.reads, 1);
    },
  );

  test(
    'tool RPC rejects malformed owners modes and foreign targets before IO',
    () async {
      final fixture = _Fixture();
      final invalid = String.fromCharCode(0xd800);

      for (final access in [
        fixture.access(scope: ''),
        fixture.access(scope: invalid),
        fixture.access(toolId: ''),
        fixture.access(toolId: invalid),
      ]) {
        expect(() {
          access.checkCurrent();
        }, throwsFormatException);
      }

      await expectLater(
        fixture.access().getTool('foreign'),
        throwsFormatException,
      );
      await expectLater(
        fixture.access().createTool(_draft(create: true).createInput()),
        throwsFormatException,
      );
      await expectLater(
        fixture.access(toolId: null).updateTool(_draft().updateInput()),
        throwsFormatException,
      );
      await expectLater(
        fixture.access().updateTool(_draft(toolId: 'foreign').updateInput()),
        throwsFormatException,
      );
      expect(fixture.reads, 0);
      expect(fixture.writes, isEmpty);
    },
  );

  test(
    'tool RPC validates typed scalar text and lossless costs before dispatch',
    () async {
      final fixture = _Fixture();
      final create = _draft(create: true).createInput();
      final update = _draft().updateInput();

      for (final changes in [
        {'customId': 1.5},
        {'status': 'lost'},
        {'brand': String.fromCharCode(0xd800)},
      ]) {
        final invalid = models.ToolsCreateInput.fromWire({
          ...create.toWire(),
          ...changes,
        });

        await expectLater(
          fixture.access(toolId: null).createTool(invalid),
          throwsFormatException,
        );
      }

      for (final field in ['purchasePrice', 'usageCostPerDay']) {
        final invalid = models.ToolsUpdateInput.fromWire({
          ...update.toWire(),
          'data': {...update.data.toWire(), field: 9007199254740993},
        });

        await expectLater(
          fixture.access().updateTool(invalid),
          throwsFormatException,
        );
      }

      expect(fixture.writes, isEmpty);
    },
  );

  test(
    'tool RPC rejects stale revoked and mismatched readback replies',
    () async {
      for (final revoke in [false, true]) {
        final fixture = _Fixture();
        fixture.onRead = () async {
          if (revoke) {
            fixture.permissions.remove('view:tools');
          } else {
            fixture.current = false;
          }
        };

        await expectLater(fixture.access().getTool('tool'), throwsStateError);
        expect(fixture.reads, 1);
      }

      final fixture = _Fixture();
      fixture.responseId = 'foreign';

      await expectLater(
        fixture.access().getTool('tool'),
        throwsFormatException,
      );
      expect(fixture.readInput!.toWire(), {'id': 'tool'});
    },
  );

  test(
    'tool RPC keeps positive create and update ACK after manage loss only',
    () async {
      for (final create in [false, true]) {
        for (final loss in ['manage', 'view', 'owner']) {
          final fixture = _Fixture();
          fixture.onWrite = () async {
            if (loss == 'owner') {
              fixture.current = false;
            } else {
              fixture.permissions.remove('$loss:tools');
            }
          };
          final access = fixture.access(toolId: create ? null : 'tool');
          final Future<Object> operation = create
              ? access.createTool(_draft(create: true).createInput())
              : access.updateTool(_draft().updateInput());

          if (loss == 'manage') {
            final result = await operation;

            if (create) {
              expect((result as models.ToolsCreateOutput).id, 'created');
            } else {
              expect((result as models.ToolsUpdateOutput).success, isTrue);
            }
          } else {
            await expectLater(operation, throwsStateError);
          }

          expect(fixture.writes.length, 1);
        }
      }
    },
  );

  test(
    'tool RPC rejects false update and empty or nonscalar create ACK',
    () async {
      final update = _Fixture();
      update.success = false;

      await expectLater(
        update.access().updateTool(_draft().updateInput()),
        throwsFormatException,
      );
      expect(update.writes, ['tools.update']);

      for (final id in ['', String.fromCharCode(0xd800)]) {
        final create = _Fixture();
        create.createId = id;

        await expectLater(
          create
              .access(toolId: null)
              .createTool(_draft(create: true).createInput()),
          throwsFormatException,
        );
        expect(create.writes, ['tools.create']);
        expect(create.reads, 0);
      }
    },
  );

  test(
    'tool RPC freezes every raw snapshot field including leading BOM',
    () async {
      final fixture = _Fixture();

      final tool = (await fixture.access().getTool('tool'))!;

      expect(tool, isNot(same(fixture.response)));
      expect(sameToolSnapshot(tool, fixture.response), isTrue);
      expect(tool.brand, '\ufeff Raw brand ');
      expect(tool.label, isNull);
      expect(tool.status, models.ToolStatus.lost);
      expect(tool.available, isFalse);
      expect(tool.archivedSince, DateTime.utc(2024, 3));
      expect(fixture.readInput!.toWire(), {'id': 'tool'});
    },
  );

  test(
    'real final session binds tool create and edit scopes and rejects unauthenticated IO',
    () async {
      final session = SessionController();
      addTearDown(session.dispose);

      final create = sessionToolWriteAccess(session);
      final edit = sessionToolWriteAccess(session, toolId: 'tool');
      final other = sessionToolWriteAccess(session, toolId: 'other');
      final inactive = sessionToolWriteAccess(
        session,
        toolId: 'tool',
        isActive: () {
          return false;
        },
      );

      expect(jsonDecode(create.scope), [null, null, null, null]);
      expect(jsonDecode(edit.scope), [null, null, null, 'tool']);
      expect(create.scope, isNot(edit.scope));
      expect(other.scope, isNot(edit.scope));
      expect(jsonDecode(other.scope), [null, null, null, 'other']);
      expect(create.toolId, isNull);
      expect(edit.toolId, 'tool');
      expect(() {
        edit.checkCurrent();
      }, throwsStateError);
      expect(() {
        inactive.checkCurrent();
      }, throwsStateError);

      await expectLater(
        create.createTool(_draft(create: true).createInput()),
        throwsStateError,
      );
      await expectLater(
        edit.updateTool(_draft().updateInput()),
        throwsStateError,
      );
      await expectLater(edit.getTool('tool'), throwsStateError);
    },
  );
}

ToolDraft _draft({bool create = false, String toolId = 'tool'}) {
  return ToolDraft(
    toolId: create ? null : toolId,
    customId: '43',
    brand: 'Brand',
    category: 'Category',
  );
}

models.Tool _tool(String id) {
  return models.Tool(
    id: id,
    customId: 42,
    brand: '\ufeff Raw brand ',
    category: ' Raw category ',
    label: null,
    purchasePrice: 0.25,
    usageCostPerDay: null,
    status: models.ToolStatus.lost,
    available: false,
    createdByUserId: 'actor',
    createdAt: DateTime.utc(2024),
    modifiedAt: DateTime.utc(2024, 2),
    archivedSince: DateTime.utc(2024, 3),
  );
}

// Typed transport fixtures do not replace an authenticated session.
final class _Fixture {
  bool current = true;
  bool success = true;
  String createId = 'created';
  String responseId = 'tool';
  int reads = 0;
  final writes = <String>[];
  final permissions = {'view:tools', 'manage:tools'};
  final response = _tool('tool');
  models.ToolsGetInput? readInput;
  models.ToolsCreateInput? createInput;
  models.ToolsUpdateInput? updateInput;
  Future<void> Function()? onRead;
  Future<void> Function()? onWrite;

  ToolRpcAccess access({String? scope, String? toolId = 'tool'}) {
    return ToolRpcAccess(
      scope: scope ?? (toolId == null ? _createScope : _editScope),
      toolId: toolId,
      read: read,
      write: write,
      isCurrent: () {
        return current;
      },
      can: permissions.contains,
    );
  }

  Future<O> read<I, O>(RpcQuery<I, O> query, I input) async {
    expect(identical(query, ApiQueries.toolsGet), isTrue);

    reads++;
    readInput = input as models.ToolsGetInput;

    final callback = onRead;

    if (callback != null) {
      await callback();
    }

    return (responseId == 'tool' ? response : _tool(responseId)) as O;
  }

  Future<O> write<I, O>(RpcMutation<I, O> mutation, I input) async {
    writes.add(mutation.path);

    if (identical(mutation, ApiMutations.toolsCreate)) {
      createInput = input as models.ToolsCreateInput;
    } else {
      expect(identical(mutation, ApiMutations.toolsUpdate), isTrue);
      updateInput = input as models.ToolsUpdateInput;
    }

    final callback = onWrite;

    if (callback != null) {
      await callback();
    }

    return (identical(mutation, ApiMutations.toolsCreate)
            ? models.ToolsCreateOutput(id: createId)
            : models.ToolsUpdateOutput(success: success))
        as O;
  }
}
