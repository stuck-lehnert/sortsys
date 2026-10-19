import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/api.g.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/api/procedure.dart';
import 'package:sortsys_client/features/vendors/vendor_detail_screen.dart';
import 'package:sortsys_client/features/vendors/vendor_dialog.dart';
import 'package:sortsys_client/features/vendors/vendor_receipt.dart';
import 'package:sortsys_client/features/vendors/vendor_rpc_access.dart';
import 'package:sortsys_client/features/vendors/vendor_write_coordinator.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

void main() {
  setUpAll(() async {
    final fonts = FontLoader('packages/sortsys_ui/Ubuntu');

    for (final weight in ['Regular', 'Medium', 'Bold']) {
      fonts.addFont(
        rootBundle.load(
          'packages/sortsys_ui/assets/fonts/ubuntu/Ubuntu-$weight.ttf',
        ),
      );
    }

    await fonts.load();
  });

  testWidgets(
    'vendor create validates actual fields and submits canonical payload',
    (tester) async {
      final fixture = _Fixture();
      await _pump(tester, fixture);
      await tester.tap(find.text('Create'));
      await tester.pumpAndSettle();

      expect(fixture.writes, 0);
      await _fill(tester, description: ' note ');
      await tester.tap(find.text('Create'));
      await _waitFor(tester, () {
        return fixture.saved.isNotEmpty;
      });

      expect(fixture.createdInput?.name, 'After');
      expect(fixture.createdInput?.description.valueOrNull, 'note');
      expect(fixture.writes, 1);
      expect(fixture.reads, 1);
      expect(fixture.saved.single.id, 'vendor');
      expect(_button(tester, 'Create').onPressed, isNull);
      expect(fixture.store.encoded, isNull);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'vendor edit prefills baseline and submits known ID with explicit null',
    (tester) async {
      final fixture = _Fixture(update: true);
      await _pump(tester, fixture);

      expect(
        tester.widget<TextField>(_input('Name *')).controller?.text,
        'Before',
      );
      await _fill(tester);
      await tester.tap(find.text('Save'));
      await _waitFor(tester, () {
        return fixture.saved.isNotEmpty;
      });

      expect(fixture.updatedInput?.id, 'vendor');
      expect(fixture.updatedInput?.data.name.valueOrNull, 'After');
      expect(fixture.updatedInput?.data.description.hasValue, isTrue);
      expect(fixture.updatedInput?.data.description.valueOrNull, isNull);
      expect(fixture.writes, 1);
      expect(fixture.reads, 2);
    },
  );

  testWidgets(
    'vendor unknown create acknowledgement has no fake recovery action',
    (tester) async {
      final fixture = _Fixture()..loseAcknowledgement = true;
      await _pump(tester, fixture);
      await _fill(tester);
      await tester.tap(find.text('Create'));
      await _waitFor(tester, () {
        return find
            .textContaining('server acknowledgement is missing')
            .evaluate()
            .isNotEmpty;
      });

      expect(fixture.writes, 1);
      expect(fixture.reads, 0);
      expect(find.text('Verify with read-only request'), findsNothing);
      expect(find.text('Discard unsent operation'), findsNothing);
      expect(_button(tester, 'Create').onPressed, isNull);
      expect(fixture.saved, isEmpty);
    },
  );

  testWidgets(
    'vendor known-ID update recovers read-only after lost acknowledgement',
    (tester) async {
      final fixture = _Fixture(update: true)..loseAcknowledgement = true;
      await _pump(tester, fixture);
      await _fill(tester);
      await tester.tap(find.text('Save'));
      await _waitFor(tester, () {
        return find
                .text('Verify with read-only request')
                .evaluate()
                .isNotEmpty &&
            _button(tester, 'Verify with read-only request').onPressed != null;
      });
      fixture.manage = false;
      await tester.tap(find.text('Verify with read-only request'));
      await _waitFor(tester, () {
        return fixture.saved.isNotEmpty;
      });

      expect(fixture.writes, 1);
      expect(fixture.reads, 2);
      expect(fixture.saved.single.name, 'After');
      expect(fixture.store.encoded, isNull);
    },
  );

  testWidgets(
    'vendor acknowledged creation retries readback without a second write',
    (tester) async {
      final fixture = _Fixture()..wrongReadback = true;
      await _pump(tester, fixture);
      await _fill(tester);
      await tester.tap(find.text('Create'));
      await _waitFor(tester, () {
        return find
                .text('Verify with read-only request')
                .evaluate()
                .isNotEmpty &&
            _button(tester, 'Verify with read-only request').onPressed != null;
      });
      fixture.wrongReadback = false;
      await tester.tap(find.text('Verify with read-only request'));
      await _waitFor(tester, () {
        return fixture.saved.isNotEmpty;
      });

      expect(fixture.writes, 1);
      expect(fixture.reads, 2);
    },
  );

  testWidgets(
    'vendor unsent receipt requires discard before an explicit new save',
    (tester) async {
      final fixture = _Fixture();
      fixture.store.failWrite = 2;
      await _pump(tester, fixture);
      await _fill(tester);
      await tester.tap(find.text('Create'));
      await _waitFor(tester, () {
        return find.text('Discard unsent operation').evaluate().isNotEmpty &&
            _button(tester, 'Discard unsent operation').onPressed != null;
      });
      await tester.tap(find.text('Discard unsent operation'));
      await _waitFor(tester, () {
        return _button(tester, 'Create').onPressed != null;
      });

      expect(fixture.writes, 0);
      await tester.tap(find.text('Create'));
      await _waitFor(tester, () {
        return fixture.saved.isNotEmpty;
      });

      expect(fixture.writes, 1);
    },
  );

  testWidgets(
    'German narrow vendor dialog blocks busy cancellation and stale completion',
    (tester) async {
      final fixture = _Fixture()..gate = Completer<void>();
      await _pump(tester, fixture, language: 'de', width: 320, scale: 2);
      await _fill(tester, german: true);
      await tester.tap(find.text('Erstellen'));
      await _waitFor(tester, () {
        return fixture.writes == 1;
      });

      expect(_button(tester, 'Abbrechen').onPressed, isNull);
      expect(_button(tester, 'Erstellen').onPressed, isNull);
      expect(tester.takeException(), isNull);
      fixture.current = false;
      await tester.pumpWidget(const SizedBox.shrink());
      fixture.gate!.complete();
      await tester.runAsync(() async {
        await Future<void>.delayed(const Duration(milliseconds: 100));
      });
      await tester.pump();

      expect(fixture.saved, isEmpty);
      expect(fixture.store.encoded, isNotNull);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'vendor detail header opens actual route and closes only after verification',
    (tester) async {
      final fixture = _Fixture(update: true);
      await _pump(tester, fixture, entry: true);
      await tester.tap(find.text('Edit'));
      await tester.pumpAndSettle();

      expect(find.byType(VendorDialog), findsOneWidget);
      await _fill(tester);
      await tester.tap(find.text('Save'));
      await _waitFor(tester, () {
        return fixture.saved.isNotEmpty;
      });
      await tester.pumpAndSettle();

      expect(fixture.writes, 1);
      expect(fixture.reads, 2);
      expect(find.byType(VendorDialog), findsNothing);
      expect(find.text('Edit'), findsOneWidget);
    },
  );
}

Finder _input(String label) {
  return find.descendant(
    of: find.byWidgetPredicate((widget) {
      return widget is SsTextField && widget.label == label;
    }),
    matching: find.byType(TextField),
  );
}

SsButton _button(WidgetTester tester, String label) {
  return tester.widget<SsButton>(
    find.ancestor(of: find.text(label), matching: find.byType(SsButton)),
  );
}

Future<void> _fill(
  WidgetTester tester, {
  String description = '   ',
  bool german = false,
}) async {
  for (final entry in [
    (_input('Name *'), ' After '),
    (_input(german ? 'Beschreibung' : 'Description'), description),
  ]) {
    await tester.ensureVisible(entry.$1);
    await tester.enterText(entry.$1, entry.$2);
  }

  await tester.pump();
}

Future<void> _waitFor(WidgetTester tester, bool Function() ready) async {
  for (var attempt = 0; attempt < 200; attempt++) {
    await tester.runAsync(() async {
      await Future<void>.delayed(const Duration(milliseconds: 10));
    });
    await tester.pump();

    if (ready()) {
      return;
    }
  }

  fail('Vendor dialog did not reach the expected I/O state.');
}

Future<void> _pump(
  WidgetTester tester,
  _Fixture fixture, {
  String language = 'en',
  double width = 800,
  double scale = 1,
  bool entry = false,
}) async {
  tester.view.physicalSize = Size(width, 800);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);

  bool current() {
    return fixture.current;
  }

  Future<void> open(BuildContext context) async {
    final result = await showVendorDialog(
      context,
      vendor: fixture.baseline,
      coordinator: fixture.coordinator,
      queryIdentity: 'scope',
      isCurrent: current,
      canSave: current,
    );

    if (result != null && fixture.current) {
      fixture.saved.add(result);
    }
  }

  await tester.pumpWidget(
    MaterialApp(
      locale: Locale(language),
      supportedLocales: const [Locale('en'), Locale('de')],
      localizationsDelegates: GlobalMaterialLocalizations.delegates,
      home: SsTheme(
        colors: SsColors.light,
        child: MediaQuery(
          data: MediaQueryData(
            size: Size(width, 800),
            textScaler: TextScaler.linear(scale),
          ),
          child: Scaffold(
            body: entry
                ? Builder(
                    builder: (context) {
                      return VendorDetailLayout(
                        vendor: fixture.baseline!,
                        headerActions: SsButton(
                          kind: SsButtonKind.ghost,
                          onPressed: () {
                            unawaited(open(context));
                          },
                          child: const Text('Edit'),
                        ),
                      );
                    },
                  )
                : VendorDialog(
                    vendor: fixture.baseline,
                    coordinator: fixture.coordinator,
                    queryIdentity: 'scope',
                    isCurrent: current,
                    onSaved: fixture.saved.add,
                    onCancel: () {},
                  ),
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

final class _Fixture {
  _Fixture({bool update = false}) {
    baseline = update ? vendor : null;
    coordinator = VendorWriteCoordinator(
      access: VendorRpcAccess(
        scope: 'origin|tenant|actor|$update',
        vendorId: update ? 'vendor' : null,
        read: read,
        write: write,
        isCurrent: () {
          return current;
        },
        can: (permission) {
          return permission == 'view:productVendors' || manage;
        },
      ),
      receipts: store,
    );
  }

  final store = _Store();
  final saved = <models.ProductVendor>[];
  late final models.ProductVendor? baseline;
  late final VendorWriteCoordinator coordinator;
  models.ProductVendor vendor = models.ProductVendor(
    id: 'vendor',
    name: 'Before',
    createdAt: DateTime.utc(2024),
    modifiedAt: DateTime.utc(2024, 2),
  );
  bool current = true;
  bool manage = true;
  bool loseAcknowledgement = false;
  bool wrongReadback = false;
  int writes = 0;
  int reads = 0;
  Completer<void>? gate;
  models.ProductsVendorsCreateInput? createdInput;
  models.ProductsVendorsUpdateInput? updatedInput;

  Future<O> write<I, O>(RpcMutation<I, O> mutation, I input) async {
    writes++;
    final pending = gate;

    if (pending != null) {
      await pending.future;
    }

    final String name;
    final String? description;
    final Object result;

    if (mutation == ApiMutations.productsVendorsCreate) {
      final value = input as models.ProductsVendorsCreateInput;
      createdInput = value;
      name = value.name;
      description = value.description.valueOrNull;
      result = const models.ProductsVendorsCreateOutput(id: 'vendor');
    } else {
      expect(mutation, same(ApiMutations.productsVendorsUpdate));
      final value = input as models.ProductsVendorsUpdateInput;
      updatedInput = value;
      name = value.data.name.value;
      description = value.data.description.valueOrNull;
      result = const models.ProductsVendorsUpdateOutput(success: true);
    }

    vendor = models.ProductVendor(
      id: 'vendor',
      name: name,
      description: description,
      createdAt: vendor.createdAt,
      modifiedAt: DateTime.utc(2024, 2, 2),
    );

    if (loseAcknowledgement) {
      throw StateError('acknowledgement lost');
    }

    return result as O;
  }

  Future<O> read<I, O>(RpcQuery<I, O> query, I input) async {
    expect(query, same(ApiQueries.productsVendorsGet));
    expect((input as models.ProductsVendorsGetInput).id, 'vendor');
    reads++;

    if (wrongReadback) {
      return models.ProductVendor(
        id: 'vendor',
        name: 'Wrong',
        createdAt: vendor.createdAt,
        modifiedAt: vendor.modifiedAt,
      ) as O;
    }

    return vendor as O;
  }
}

final class _Store implements VendorReceiptStore {
  String? encoded;
  int writes = 0;
  int? failWrite;

  @override
  Future<VendorWriteReceipt?> read(String scope) async {
    final value = encoded;

    return value == null ? null : VendorWriteReceipt.decode(value);
  }

  @override
  Future<void> write(VendorWriteReceipt receipt) async {
    writes++;

    if (writes == failWrite) {
      throw StateError('storage unavailable');
    }

    encoded = receipt.encode();
  }

  @override
  Future<void> clear(String scope) async {
    encoded = null;
  }
}
