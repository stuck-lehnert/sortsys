import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/features/projects/project_write_lock.dart';
import 'package:sortsys_client/features/tools/tool_draft.dart';
import 'package:sortsys_client/features/tools/tool_receipt.dart';
import 'package:sortsys_client/features/tools/tool_write_access.dart';
import 'package:sortsys_client/features/tools/tool_write_coordinator.dart';
import 'package:sortsys_client/features/tools/tool_write_inputs.dart';

const _editScope = '["https://example.test","tenant","actor","tool"]';
const _createScope = '["https://example.test","tenant","actor",null]';
const _nonce = '0123456789abcdef0123456789abcdef';
const _replacementNonce = 'fedcba9876543210fedcba9876543210';

void main() {
  test('tool update reads every durable stage before one dispatch', () async {
    final harness = _Harness();
    final baseline = _tool();
    harness.access.beforeMutation = () {
      final receipt = harness.store.receipt!;

      expect(receipt.dispatching, isTrue);
      expect(receipt.baseline, isNot(same(baseline)));
      expect(sameToolSnapshot(receipt.baseline!, baseline), isTrue);
      expect(harness.store.readbackPending, isFalse);
      expect(harness.store.stages, ['prepared', 'dispatching']);
    };
    harness.access.afterGet = () async {
      if (harness.access.updates == 1) {
        expect(harness.store.receipt!.acknowledged, isTrue);
        expect(harness.store.readbackPending, isFalse);
      }
    };

    final result = await harness.save(baseline: baseline);

    expect(result.brand, 'After');
    expect(harness.access.updates, 1);
    expect(harness.access.creates, 0);
    expect(harness.access.getIds, ['tool', 'tool']);
    expect(harness.store.stages, ['prepared', 'dispatching', 'acknowledged']);
    expect(harness.store.receipt, isNull);
    expect(harness.store.clears, 1);
  });

  test('tool create uses acknowledged ID and fresh owned readback', () async {
    final harness = _Harness(create: true);

    final result = await harness.save();

    expect(result.id, 'created');
    expect(result.customId, 43);
    expect(result.brand, 'After');
    expect(harness.access.creates, 1);
    expect(harness.access.updates, 0);
    expect(harness.access.getIds, ['created']);
    expect(harness.store.receipt, isNull);
  });

  test(
    'unchanged tool fields still dispatch daily cost default backfill',
    () async {
      for (final dailyCost in [0.0, 12.5]) {
        final harness = _Harness();
        final baseline = _tool({
          ..._saved().toWire(),
          'usageCostPerDay': dailyCost,
        });
        harness.access.tool = baseline;

        await harness.save(
          draft: ToolDraft.fromTool(baseline),
          baseline: baseline,
        );

        expect(harness.access.updates, 1);
        expect(harness.access.waitingCosts, [dailyCost, 9.0]);
        expect(harness.access.getIds, ['tool', 'tool']);
        expect(harness.store.stages, [
          'prepared',
          'dispatching',
          'acknowledged',
        ]);
      }
    },
  );

  test(
    'tool save compares every frozen baseline field before journaling',
    () async {
      final changes = <String, Object?>{
        'id': 'other',
        'customId': 43,
        'brand': 'Changed',
        'category': 'Changed',
        'label': null,
        'purchasePrice': null,
        'usageCostPerDay': null,
        'status': 'lost',
        'available': false,
        'createdByUserId': null,
        'createdAt': DateTime.utc(2025),
        'modifiedAt': DateTime.utc(2025, 2),
        'archivedSince': DateTime.utc(2025, 3),
      };

      expect(changes.length, 13);

      for (final change in changes.entries) {
        final harness = _Harness();
        harness.access.tool = _tool({change.key: change.value});

        await expectLater(harness.save(), _failure(ToolWriteFailure.conflict));
        expect(harness.store.stages, isEmpty, reason: change.key);
        expect(harness.access.updates, 0, reason: change.key);
      }
    },
  );

  test(
    'tool modes targets and invalid drafts reject before journal IO',
    () async {
      final harness = _Harness();

      for (final draft in [
        const ToolDraft(toolId: 'tool'),
        _draft(toolId: null),
        _draft(toolId: 'other'),
      ]) {
        await expectLater(
          Future.sync(() {
            return harness.save(draft: draft);
          }),
          throwsFormatException,
        );
      }

      await expectLater(
        Future.sync(() {
          return harness.save(baseline: _tool({'id': 'other'}));
        }),
        throwsFormatException,
      );
      expect(harness.store.reads, 0);
      expect(harness.access.getIds, isEmpty);
    },
  );

  test(
    'tool manage loss before and after fresh read blocks journal writes',
    () async {
      final denied = _Harness();
      denied.access.manage = false;

      await expectLater(
        Future.sync(() {
          return denied.save();
        }),
        throwsStateError,
      );
      expect(denied.store.reads, 0);

      final revoked = _Harness();
      revoked.access.afterGet = () async {
        revoked.access.manage = false;
      };

      await expectLater(revoked.save(), throwsStateError);
      expect(revoked.store.stages, isEmpty);
      expect(revoked.access.updates, 0);
    },
  );

  test('tool pending corrupt and foreign journals block business IO', () async {
    for (final (receipt, rejection) in [
      (_pending(), _failure(ToolWriteFailure.outstanding)),
      (_pending(scope: 'foreign'), throwsFormatException),
      (_pending(id: 'other'), throwsFormatException),
      (_pending(create: true, scope: _editScope), throwsFormatException),
    ]) {
      final harness = _Harness();
      harness.store.encoded = receipt.encode();

      await expectLater(harness.save(), rejection);

      expect(harness.access.getIds, isEmpty);
      expect(harness.access.updates, 0);
      expect(harness.store.stages, isEmpty);
      expect(harness.store.encoded, receipt.encode());
    }

    final corrupt = _Harness();
    corrupt.store.readError = const FormatException(
      'INCOMPATIBLE_TOOL_JOURNAL',
    );

    await expectLater(corrupt.save(), throwsFormatException);
    expect(corrupt.access.getIds, isEmpty);
    expect(corrupt.store.stages, isEmpty);
  });

  test('tool prepared journal readback loss prevents dispatch', () async {
    final harness = _Harness();
    harness.store.dropStage = 'prepared';

    await expectLater(harness.save(), throwsStateError);
    expect(harness.access.updates, 0);
    expect(harness.store.stages, ['prepared']);
  });

  test('tool dispatch journal readback loss prevents mutation', () async {
    final harness = _Harness();
    harness.store.dropStage = 'dispatching';

    await expectLater(harness.save(), _failure(ToolWriteFailure.uncertain));
    expect(harness.access.updates, 0);
    expect(harness.store.receipt!.dispatching, isFalse);
    expect(
      await harness.coordinator.recover(
        expectedNonce: harness.store.receipt!.nonce,
      ),
      isNull,
    );
    expect(harness.store.receipt, isNull);
  });

  test(
    'tool ack persistence failure before and after storage never replays',
    () async {
      for (final after in [false, true]) {
        final harness = _Harness();
        harness.store.failStage = 'acknowledged';
        harness.store.failAfterWrite = after;

        await expectLater(harness.save(), _failure(ToolWriteFailure.uncertain));

        final nonce = harness.store.receipt!.nonce;

        expect(harness.access.updates, 1);

        if (after) {
          expect(
            (await harness.coordinator.recover(expectedNonce: nonce))!.id,
            'tool',
          );
          expect(harness.store.receipt, isNull);
        } else {
          await expectLater(
            harness.coordinator.recover(expectedNonce: nonce),
            _failure(ToolWriteFailure.uncertain),
          );
          expect(harness.access.getIds, ['tool']);
        }

        expect(harness.access.updates, 1);
      }
    },
  );

  test(
    'tool partial row write cannot prove tracking cost completion',
    () async {
      final harness = _Harness();
      harness.access.partialUpdate = true;

      await expectLater(harness.save(), _failure(ToolWriteFailure.uncertain));

      final receipt = harness.store.receipt!;

      expect(
        toolUpdateMatches(receipt.updateInput!, harness.access.tool!),
        isTrue,
      );
      expect(harness.access.waitingCosts, [null, 9.0]);
      await expectLater(
        harness.coordinator.recover(expectedNonce: receipt.nonce),
        _failure(ToolWriteFailure.uncertain),
      );
      await expectLater(harness.save(), _failure(ToolWriteFailure.outstanding));
      expect(harness.access.getIds, ['tool']);
      expect(harness.access.updates, 1);
    },
  );

  test('tool false update and empty create ACK remain uncertain', () async {
    for (final create in [false, true]) {
      final harness = _Harness(create: create);
      harness.access.falseUpdateAck = !create;
      harness.access.emptyCreateAck = create;

      await expectLater(harness.save(), _failure(ToolWriteFailure.uncertain));

      final receipt = harness.store.receipt!;

      await expectLater(
        harness.coordinator.recover(expectedNonce: receipt.nonce),
        _failure(ToolWriteFailure.uncertain),
      );
      expect(harness.access.creates + harness.access.updates, 1);
      expect(receipt.dispatching, isTrue);
      expect(receipt.acknowledged, isFalse);
    }
  });

  test(
    'tool prepared recovery is exact nonce and current view owned',
    () async {
      final harness = _Harness();
      final receipt = _pending();
      harness.store.encoded = receipt.encode();
      harness.access.manage = false;

      await expectLater(
        harness.coordinator.recover(expectedNonce: _replacementNonce),
        _failure(ToolWriteFailure.outstanding),
      );
      expect(harness.store.clears, 0);
      expect(await harness.coordinator.recover(expectedNonce: _nonce), isNull);
      expect(harness.store.receipt, isNull);
      expect(harness.access.getIds, isEmpty);
      expect(harness.access.updates, 0);
    },
  );

  test('tool dispatch recovery never reads matching row or replays', () async {
    final harness = _Harness();
    final receipt = _pending().started();
    harness.store.encoded = receipt.encode();
    harness.access.tool = _saved();
    harness.access.manage = false;

    await expectLater(
      harness.coordinator.recover(expectedNonce: _nonce),
      _failure(ToolWriteFailure.uncertain),
    );
    expect(harness.store.encoded, receipt.encode());
    expect(harness.access.getIds, isEmpty);
    expect(harness.access.updates, 0);
    expect(harness.store.clears, 0);
  });

  test(
    'tool acknowledged recovery verifies fields without manage permission',
    () async {
      for (final create in [false, true]) {
        final harness = _Harness(create: create);
        final started = _pending(create: create).started();
        final receipt = create
            ? started.confirmedCreate(
                const models.ToolsCreateOutput(id: 'created'),
              )
            : started.confirmedUpdate(
                const models.ToolsUpdateOutput(success: true),
              );
        harness.store.encoded = receipt.encode();
        harness.access.tool = _saved(create: create);
        harness.access.manage = false;

        final result = await harness.coordinator.recover(expectedNonce: _nonce);

        expect(result!.id, create ? 'created' : 'tool');
        expect(harness.access.creates + harness.access.updates, 0);
        expect(harness.store.receipt, isNull);
      }
    },
  );

  test(
    'tool readback mismatch and missing rows never clear acknowledgement',
    () async {
      for (final mode in ['missing', 'foreign', 'changed', 'error']) {
        final harness = _Harness();
        harness.access.readbackMode = mode;

        await expectLater(harness.save(), _failure(ToolWriteFailure.uncertain));
        final receipt = harness.store.receipt!;

        expect(receipt.acknowledged, isTrue);
        await expectLater(
          harness.coordinator.recover(expectedNonce: receipt.nonce),
          _failure(ToolWriteFailure.uncertain),
        );
        expect(harness.access.updates, 1);
        expect(harness.store.clears, 0);
      }
    },
  );

  test(
    'tool cleanup retains verified model before and after removal',
    () async {
      for (final after in [false, true]) {
        final harness = _Harness();
        harness.store.failClear = true;
        harness.store.failAfterClear = after;

        await expectLater(
          harness.save(),
          throwsA(
            isA<ToolWriteException>()
                .having(
                  (error) {
                    return error.failure;
                  },
                  'failure',
                  ToolWriteFailure.cleanup,
                )
                .having(
                  (error) {
                    return error.confirmedTool?.id;
                  },
                  'verified tool ID',
                  'tool',
                ),
          ),
        );
        expect(harness.access.updates, 1);
        expect(harness.store.receipt == null, after);

        if (!after) {
          harness.store.failClear = false;
          expect(
            (await harness.coordinator.recover(
              expectedNonce: harness.store.receipt!.nonce,
            ))!.brand,
            'After',
          );
        }

        expect(harness.access.updates, 1);
      }
    },
  );

  test(
    'tool cleanup refuses replacement intent and silent clear loss',
    () async {
      final replaced = _Harness();
      final replacement = _pending(nonce: _replacementNonce);
      replaced.access.afterGet = () async {
        if (replaced.access.updates == 1) {
          replaced.store.encoded = replacement.encode();
        }
      };

      await expectLater(replaced.save(), _failure(ToolWriteFailure.cleanup));
      expect(replaced.store.encoded, replacement.encode());
      expect(replaced.store.clears, 0);

      final dropped = _Harness();
      dropped.store.dropClear = true;

      await expectLater(dropped.save(), _failure(ToolWriteFailure.cleanup));
      expect(dropped.store.receipt!.acknowledged, isTrue);
      expect(dropped.access.updates, 1);
    },
  );

  test(
    'tool scope target and view loss at every journal await stays bound',
    () async {
      final boundaries = [
        for (var read = 1; read <= 9; read++) 'read:$read',
        'write:prepared',
        'write:dispatching',
        'write:acknowledged',
        'clear',
      ];

      for (final change in ['scope', 'target', 'view']) {
        for (final boundary in boundaries) {
          final harness = _Harness();
          var lost = false;
          late List<String> stagesAtLoss;
          late int readsAtLoss;
          late int clearsAtLoss;
          late int businessReadsAtLoss;
          late int updatesAtLoss;

          void loseOwner() {
            expect(lost, isFalse);
            lost = true;

            if (change == 'scope') {
              harness.access.owner = 'other';
            } else if (change == 'target') {
              harness.access.target = 'other';
            } else {
              harness.access.current = false;
            }

            stagesAtLoss = List.of(harness.store.stages);
            readsAtLoss = harness.store.reads;
            clearsAtLoss = harness.store.clears;
            businessReadsAtLoss = harness.access.getIds.length;
            updatesAtLoss = harness.access.updates;
          }

          harness.store.beforeRead = (number) async {
            if (boundary == 'read:$number') {
              loseOwner();
            }
          };
          harness.store.afterWrite = (receipt) {
            if (boundary == 'write:${_receiptStage(receipt)}') {
              loseOwner();
            }
          };
          harness.store.afterClear = () {
            if (boundary == 'clear') {
              loseOwner();
            }
          };
          final readNumber = boundary.startsWith('read:')
              ? int.parse(boundary.substring(5))
              : null;
          final beforeTry = readNumber != null
              ? readNumber <= 3
              : boundary == 'write:prepared';
          final beforeDispatch = readNumber != null
              ? readNumber <= 5
              : boundary != 'write:acknowledged' && boundary != 'clear';
          final stateError = isA<StateError>().having(
            (error) {
              return error.message;
            },
            'cause',
            change == 'view' ? 'STALE_TOOL_VIEW' : 'TOOL_WRITE_SCOPE_CHANGED',
          );
          final rejection = beforeTry
              ? throwsA(stateError)
              : throwsA(
                  isA<ToolWriteException>()
                      .having(
                        (error) {
                          return error.failure;
                        },
                        'failure',
                        ToolWriteFailure.uncertain,
                      )
                      .having(
                        (error) {
                          return error.cause;
                        },
                        'cause',
                        stateError,
                      )
                      .having(
                        (error) {
                          return error.confirmedTool;
                        },
                        'stale result',
                        isNull,
                      ),
                );

          await expectLater(harness.save(), rejection);

          expect(lost, isTrue, reason: '$change $boundary');
          expect(harness.store.stages, stagesAtLoss);
          expect(harness.store.reads, readsAtLoss);
          expect(harness.store.clears, clearsAtLoss);
          expect(harness.access.getIds.length, businessReadsAtLoss);
          expect(harness.access.updates, updatesAtLoss);
          expect(harness.access.updates, beforeDispatch ? 0 : 1);
        }
      }
    },
  );

  test('tool target loss after read or mutation reply remains bound', () async {
    for (final afterMutation in [false, true]) {
      final harness = _Harness();

      if (afterMutation) {
        harness.access.afterMutation = () async {
          harness.access.target = 'other';
        };
      } else {
        harness.access.afterGet = () async {
          harness.access.target = 'other';
        };
      }

      await expectLater(
        harness.save(),
        afterMutation ? _failure(ToolWriteFailure.uncertain) : throwsStateError,
      );
      expect(harness.access.updates, afterMutation ? 1 : 0);
      expect(harness.store.receipt?.acknowledged ?? false, isFalse);
      expect(harness.store.clears, 0);
    }
  });

  test(
    'tool positive ACK survives manage loss but never current view loss',
    () async {
      final manage = _Harness();
      manage.access.afterMutation = () async {
        manage.access.manage = false;
      };

      expect((await manage.save()).id, 'tool');
      expect(manage.store.receipt, isNull);

      final view = _Harness();
      view.access.afterMutation = () async {
        view.access.current = false;
      };

      await expectLater(view.save(), _failure(ToolWriteFailure.uncertain));
      expect(view.store.receipt!.dispatching, isTrue);
      expect(view.store.clears, 0);
      expect(view.access.updates, 1);
    },
  );

  test(
    'tool recovery preserves replacement nonce and forward stages',
    () async {
      final harness = _Harness();
      final replacement = _pending(nonce: _replacementNonce).started();
      harness.store.encoded = _pending().encode();
      harness.store.beforeRead = (number) async {
        if (number == 2) {
          harness.store.encoded = replacement.encode();
        }
      };

      await expectLater(
        harness.coordinator.recover(expectedNonce: _nonce),
        _failure(ToolWriteFailure.outstanding),
      );
      expect(harness.store.encoded, replacement.encode());
      expect(harness.store.clears, 0);
      expect(harness.access.updates, 0);
    },
  );

  test('tool writes and recovery share the real scoped lock', () async {
    final entered = Completer<void>();
    final release = Completer<void>();
    final harness = _Harness();
    harness.store.beforeRead = (number) async {
      if (number == 1) {
        entered.complete();
        await release.future;
      }
    };
    final operation = harness.save();

    await entered.future;

    try {
      await expectLater(harness.save(), _busy());
      await expectLater(
        harness.coordinator.recover(expectedNonce: _nonce),
        _busy(),
      );
      await expectLater(
        withProjectWriteLock('tools:$_editScope', () async {
          return 'unexpected';
        }),
        _busy(),
      );
    } finally {
      release.complete();
    }

    expect((await operation).id, 'tool');
    expect(harness.access.updates, 1);
  });

  test('tool distinct owners use separate shared locks', () async {
    final entered = Completer<void>();
    final release = Completer<void>();
    final first = _Harness();
    final second = _Harness();
    second.access.owner = '["https://other.test","tenant","other","tool"]';
    first.store.beforeRead = (number) async {
      if (number == 1) {
        entered.complete();
        await release.future;
      }
    };
    final operation = first.save();

    await entered.future;

    try {
      expect((await second.save()).id, 'tool');
    } finally {
      release.complete();
    }

    expect((await operation).id, 'tool');
    expect(first.access.updates, 1);
    expect(second.access.updates, 1);
  });
}

String _receiptStage(ToolWriteReceipt receipt) {
  if (receipt.acknowledged) {
    return 'acknowledged';
  }

  if (receipt.dispatching) {
    return 'dispatching';
  }

  return 'prepared';
}

Matcher _failure(ToolWriteFailure failure) {
  return throwsA(
    isA<ToolWriteException>()
        .having(
          (error) {
            return error.failure;
          },
          'failure',
          failure,
        )
        .having(
          (error) {
            return error.confirmedTool;
          },
          'verified model',
          failure == ToolWriteFailure.cleanup ? isNotNull : isNull,
        ),
  );
}

Matcher _busy() {
  return throwsA(
    isA<StateError>().having(
      (error) {
        return error.message;
      },
      'message',
      'PROJECT_WRITE_BUSY',
    ),
  );
}

ToolDraft _draft({String? toolId = 'tool'}) {
  return ToolDraft(
    toolId: toolId,
    customId: '43',
    brand: 'After',
    category: 'Category',
    label: 'Model',
    purchasePrice: '0,25',
    usageCostPerDay: '12,5',
  );
}

models.Tool _tool([Map<String, Object?> changes = const {}]) {
  return models.Tool.fromWire({
    'id': 'tool',
    'customId': 42,
    'brand': 'Before',
    'category': 'Category',
    'label': 'Model',
    'purchasePrice': 0.25,
    'usageCostPerDay': 12.5,
    'status': null,
    'available': true,
    'createdByUserId': 'actor',
    'createdAt': DateTime.utc(2024),
    'modifiedAt': DateTime.utc(2024, 2),
    'archivedSince': null,
    ...changes,
  });
}

models.Tool _saved({bool create = false}) {
  return _tool({
    'id': create ? 'created' : 'tool',
    'customId': create ? 43 : 42,
    'brand': 'After',
    'modifiedAt': DateTime.utc(2025),
  });
}

ToolWriteReceipt _pending({
  bool create = false,
  String? scope,
  String id = 'tool',
  String nonce = _nonce,
}) {
  return ToolWriteReceipt(
    scope: scope ?? (create ? _createScope : _editScope),
    nonce: nonce,
    createdAt: DateTime.utc(2024),
    createInput: create ? _draft(toolId: null).createInput() : null,
    updateInput: create ? null : _draft(toolId: id).updateInput(),
    baseline: create ? null : _tool({'id': id}),
  );
}

final class _Harness {
  _Harness({bool create = false}) {
    access = _Access(create: create);
    coordinator = ToolWriteCoordinator(access: access, receipts: store);
  }

  final store = _Store();
  late final _Access access;
  late final ToolWriteCoordinator coordinator;

  Future<models.Tool> save({ToolDraft? draft, models.Tool? baseline}) {
    final input = draft ?? _draft(toolId: access.toolId);

    return coordinator.save(
      input,
      baseline: input.isEditing ? baseline ?? _tool() : baseline,
    );
  }
}

final class _Store implements ToolReceiptStore {
  String? encoded;
  Object? readError;
  String? dropStage;
  String? failStage;
  bool failAfterWrite = false;
  bool failClear = false;
  bool failAfterClear = false;
  bool dropClear = false;
  bool readbackPending = false;
  int reads = 0;
  int clears = 0;
  final stages = <String>[];
  Future<void> Function(int number)? beforeRead;
  void Function(ToolWriteReceipt receipt)? afterWrite;
  void Function()? afterClear;

  ToolWriteReceipt? get receipt {
    final value = encoded;

    return value == null ? null : ToolWriteReceipt.decode(value);
  }

  @override
  Future<ToolWriteReceipt?> read(String scope) async {
    reads++;

    final callback = beforeRead;

    if (callback != null) {
      await callback(reads);
    }

    final error = readError;

    if (error != null) {
      throw error;
    }

    readbackPending = false;

    return receipt;
  }

  @override
  Future<void> write(ToolWriteReceipt receipt) async {
    final stage = _receiptStage(receipt);
    stages.add(stage);

    if (stage == failStage && !failAfterWrite) {
      throw StateError('JOURNAL_WRITE_FAILED');
    }

    if (stage != dropStage) {
      encoded = receipt.encode();
    }

    readbackPending = true;
    afterWrite?.call(receipt);

    if (stage == failStage && failAfterWrite) {
      throw StateError('JOURNAL_WRITE_FAILED_AFTER_PERSIST');
    }
  }

  @override
  Future<void> clear(String scope) async {
    clears++;

    if (failClear && !failAfterClear) {
      throw StateError('JOURNAL_CLEAR_FAILED');
    }

    if (!dropClear) {
      encoded = null;
    }

    afterClear?.call();

    if (failClear && failAfterClear) {
      throw StateError('JOURNAL_CLEAR_FAILED_AFTER_REMOVAL');
    }
  }
}

// Domain transport fixture only; no authenticated controller or native storage.
final class _Access implements ToolWriteAccess {
  _Access({required bool create})
    : owner = create ? _createScope : _editScope,
      target = create ? null : 'tool';

  String owner;
  String? target;
  bool current = true;
  bool manage = true;
  bool partialUpdate = false;
  bool falseUpdateAck = false;
  bool emptyCreateAck = false;
  String? readbackMode;
  int creates = 0;
  int updates = 0;
  models.Tool? tool = _tool();
  final getIds = <String>[];
  final waitingCosts = <num?>[null, 9.0];
  void Function()? beforeMutation;
  Future<void> Function()? afterGet;
  Future<void> Function()? afterMutation;

  @override
  String get scope {
    return owner;
  }

  @override
  String? get toolId {
    return target;
  }

  @override
  void checkCurrent() {
    if (!current) {
      throw StateError('STALE_TOOL_VIEW');
    }
  }

  void _checkManage() {
    checkCurrent();

    if (!manage) {
      throw StateError('TOOL_MANAGE_FORBIDDEN');
    }
  }

  @override
  void checkCreate(models.ToolsCreateInput input) {
    _checkManage();
    checkToolCreateInput(input);

    if (target != null) {
      throw const FormatException('INVALID_CREATE_TARGET');
    }
  }

  @override
  void checkUpdate(models.ToolsUpdateInput input) {
    _checkManage();
    checkToolUpdateInput(input);

    if (target != input.id) {
      throw const FormatException('INVALID_UPDATE_TARGET');
    }
  }

  @override
  Future<models.ToolsCreateOutput> createTool(
    models.ToolsCreateInput input,
  ) async {
    checkCreate(input);
    beforeMutation?.call();
    creates++;
    tool = _tool({
      ...input.toWire(),
      'id': 'created',
      'status': null,
      'modifiedAt': DateTime.utc(2025),
    });

    final callback = afterMutation;

    if (callback != null) {
      await callback();
    }

    return models.ToolsCreateOutput(id: emptyCreateAck ? '' : 'created');
  }

  @override
  Future<models.ToolsUpdateOutput> updateTool(
    models.ToolsUpdateInput input,
  ) async {
    checkUpdate(input);
    beforeMutation?.call();
    updates++;
    tool = _tool({
      ...input.data.toWire(),
      'id': input.id,
      'modifiedAt': DateTime.utc(2025),
    });

    if (partialUpdate) {
      throw StateError('TRACKING_DEFAULT_BACKFILL_FAILED');
    }

    final dailyCost = input.data.usageCostPerDay.value;

    if (dailyCost != null) {
      for (var index = 0; index < waitingCosts.length; index++) {
        waitingCosts[index] ??= dailyCost;
      }
    }

    final callback = afterMutation;

    if (callback != null) {
      await callback();
    }

    return models.ToolsUpdateOutput(success: !falseUpdateAck);
  }

  @override
  Future<models.Tool?> getTool(String id) async {
    checkCurrent();
    getIds.add(id);

    var result = tool;

    if (creates + updates > 0) {
      if (readbackMode == 'error') {
        throw StateError('NOT_FOUND');
      } else if (readbackMode == 'missing') {
        result = null;
      } else if (readbackMode == 'foreign') {
        result = _tool({..._saved().toWire(), 'id': 'foreign'});
      } else if (readbackMode == 'changed') {
        result = _tool({..._saved().toWire(), 'brand': 'Other'});
      }
    }

    final callback = afterGet;

    if (callback != null) {
      await callback();
    }

    return result;
  }
}
