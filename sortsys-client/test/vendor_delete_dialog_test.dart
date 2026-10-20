import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/features/vendors/vendor_delete_coordinator.dart';
import 'package:sortsys_client/features/vendors/vendor_delete_dialog.dart';
import 'package:sortsys_client/features/vendors/vendor_receipt.dart';
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

  testWidgets('vendor deletion requires its real confirmation checkbox', (
    tester,
  ) async {
    final fixture = _Fixture();
    addTearDown(fixture.dispose);

    await _open(tester, fixture);
    await tester.tap(find.text('Delete'));
    await tester.pumpAndSettle();

    expect(find.text('Required field'), findsOneWidget);
    expect(fixture.access.deletes, 0);
    expect(fixture.store.encoded, isNull);
    expect(_button(tester, 'Delete').kind, SsButtonKind.danger);

    await tester.tap(find.byType(SsCheckbox));
    await tester.tap(find.text('Delete'));
    await tester.pumpAndSettle();

    expect(fixture.results, ['vendor']);
    expect(fixture.access.deletes, 1);
    expect(fixture.access.reads, 1);
    expect(fixture.store.writes, 3);
    expect(fixture.store.encoded, isNull);
    expect(find.byType(VendorDeleteDialog), findsNothing);
  });

  testWidgets(
    'vendor deletion blocks duplicate submit close and back while busy',
    (tester) async {
      final fixture = _Fixture();
      fixture.access.deleteGate = Completer<void>();
      addTearDown(fixture.dispose);

      await _open(tester, fixture);
      await tester.tap(find.byType(SsCheckbox));
      await tester.tap(find.text('Delete'));
      await tester.pump();

      expect(fixture.access.deletes, 1);
      expect(_button(tester, 'Cancel').onPressed, isNull);
      expect(_button(tester, 'Delete').onPressed, isNull);

      await tester.tap(find.text('Delete'));
      await tester.binding.handlePopRoute();
      await tester.pump();

      expect(find.byType(VendorDeleteDialog), findsOneWidget);
      expect(fixture.results, isEmpty);
      expect(fixture.access.deletes, 1);

      fixture.access.deleteGate!.complete();
      await tester.pumpAndSettle();

      expect(fixture.results, ['vendor']);
      expect(fixture.access.reads, 1);
      expect(fixture.store.encoded, isNull);
    },
  );

  testWidgets(
    'lost vendor delete acknowledgement stays blocked after reopening',
    (tester) async {
      final fixture = _Fixture();
      fixture.access.loseAcknowledgement = true;
      addTearDown(fixture.dispose);

      await _open(tester, fixture);
      await tester.tap(find.byType(SsCheckbox));
      await tester.tap(find.text('Delete'));
      await tester.pumpAndSettle();

      expect(fixture.access.deleted, isTrue);
      expect(fixture.receipt!.dispatching, isTrue);
      expect(fixture.receipt!.deletionConfirmed, isFalse);
      expect(_button(tester, 'Delete').onPressed, isNull);
      expect(find.text('Finish acknowledged deletion'), findsNothing);
      expect(find.text('Discard unsent operation'), findsNothing);
      expect(
        find.textContaining('The server acknowledgement is missing.'),
        findsOneWidget,
      );

      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();
      await _open(tester, fixture);

      expect(_button(tester, 'Delete').onPressed, isNull);
      expect(fixture.access.deletes, 1);
      expect(fixture.access.reads, 1);
      expect(fixture.results, [null]);
    },
  );

  testWidgets(
    'vendor delete conflict blocks mutation until a fresh detail load',
    (tester) async {
      final fixture = _Fixture();
      fixture.access.vendor = _vendor(name: 'Concurrent change');
      addTearDown(fixture.dispose);

      await _open(tester, fixture);
      await tester.tap(find.byType(SsCheckbox));
      await tester.tap(find.text('Delete'));
      await tester.pumpAndSettle();

      expect(fixture.access.deletes, 0);
      expect(fixture.store.encoded, isNull);
      expect(_button(tester, 'Delete').onPressed, isNull);
      expect(find.textContaining('The vendor has changed.'), findsOneWidget);
    },
  );

  testWidgets('unreadable vendor journal gates deletion until status reload', (
    tester,
  ) async {
    final fixture = _Fixture();
    fixture.store.failRead = true;
    addTearDown(fixture.dispose);

    await _open(tester, fixture);

    expect(find.byType(SsCheckbox), findsNothing);
    expect(_button(tester, 'Delete').onPressed, isNull);
    expect(fixture.access.deletes, 0);

    fixture.store.failRead = false;
    await tester.tap(find.text('Reload'));
    await tester.pumpAndSettle();

    expect(find.byType(SsCheckbox), findsOneWidget);
    expect(_button(tester, 'Delete').onPressed, isNotNull);
    expect(fixture.access.deletes, 0);
  });

  testWidgets(
    'proven unsent vendor deletion can be discarded after role loss',
    (tester) async {
      final fixture = _Fixture();
      fixture.store.encoded = fixture.prepared().encode();
      addTearDown(fixture.dispose);

      await _open(tester, fixture);

      fixture.access.canDelete = false;
      fixture.refresh();
      await tester.pump();

      await tester.tap(find.text('Discard unsent operation'));
      await tester.pumpAndSettle();

      expect(fixture.store.encoded, isNull);
      expect(fixture.access.deletes, 0);
      expect(fixture.access.reads, 0);
      expect(fixture.results, isEmpty);
      expect(_button(tester, 'Delete').onPressed, isNull);
      expect(
        tester.widget<SsCheckbox>(find.byType(SsCheckbox)).onChanged,
        isNull,
      );
    },
  );

  testWidgets('acknowledged vendor deletion recovers locally after role loss', (
    tester,
  ) async {
    final fixture = _Fixture();
    fixture.store.encoded = fixture
        .prepared()
        .started()
        .confirmedDelete(
          const models.ProductsVendorsDeleteOutput(success: true),
        )
        .encode();
    addTearDown(fixture.dispose);

    await _open(tester, fixture);

    fixture.access.canDelete = false;
    fixture.refresh();
    await tester.pump();

    await tester.tap(find.text('Finish acknowledged deletion'));
    await tester.pumpAndSettle();

    expect(fixture.results, ['vendor']);
    expect(fixture.store.encoded, isNull);
    expect(fixture.access.deletes, 0);
    expect(fixture.access.reads, 0);
  });

  testWidgets(
    'genuine vendor deletion survives cleanup failure before or after',
    (tester) async {
      for (final afterClear in [false, true]) {
        final fixture = _Fixture();
        fixture.store.failClear = true;
        fixture.store.failAfterClear = afterClear;
        addTearDown(fixture.dispose);

        await _open(tester, fixture);
        await tester.tap(find.byType(SsCheckbox));
        await tester.tap(find.text('Delete'));
        await tester.pumpAndSettle();

        expect(fixture.results, ['vendor']);
        expect(fixture.access.deletes, 1);
        expect(fixture.access.reads, 1);
        expect(fixture.store.writes, 3);
        expect(
          fixture.receipt?.deletionConfirmed,
          afterClear ? isNull : isTrue,
        );
      }
    },
  );

  testWidgets('stale vendor dialog cannot accept a held deletion response', (
    tester,
  ) async {
    final fixture = _Fixture();
    fixture.access.deleteGate = Completer<void>();
    addTearDown(fixture.dispose);

    await _open(tester, fixture);
    await tester.tap(find.byType(SsCheckbox));
    await tester.tap(find.text('Delete'));
    await tester.pump();

    fixture.access.current = false;
    fixture.refresh();
    await tester.pump();

    expect(find.text('No permission'), findsOneWidget);
    expect(find.text('Vendor'), findsNothing);

    fixture.access.deleteGate!.complete();
    await tester.pumpAndSettle();

    expect(fixture.results, isEmpty);
    expect(fixture.access.deletes, 1);
    expect(fixture.receipt!.dispatching, isTrue);
    expect(fixture.receipt!.deletionConfirmed, isFalse);
    expect(_button(tester, 'Delete').onPressed, isNull);
  });

  testWidgets('vendor confirmation scrolls at320px doubled German RTL', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(320, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final fixture = _Fixture();
    addTearDown(fixture.dispose);

    await _open(tester, fixture, german: true);
    await tester.ensureVisible(find.byType(SsCheckbox));
    await tester.pumpAndSettle();
    await tester.tap(find.byType(SsCheckbox));
    await tester.pump();

    expect(tester.widget<SsCheckbox>(find.byType(SsCheckbox)).value, isTrue);
    expect(
      MediaQuery.sizeOf(tester.element(find.byType(VendorDeleteDialog))).width,
      320,
    );
    expect(tester.takeException(), isNull);

    await tester.tap(find.text('Abbrechen'));
    await tester.pumpAndSettle();

    expect(fixture.results, [null]);
    expect(fixture.access.deletes, 0);
  });
}

SsButton _button(WidgetTester tester, String label) {
  return tester.widget<SsButton>(
    find.ancestor(of: find.text(label), matching: find.byType(SsButton)),
  );
}

Future<void> _open(
  WidgetTester tester,
  _Fixture fixture, {
  bool german = false,
}) async {
  await tester.pumpWidget(
    MaterialApp(
      locale: Locale(german ? 'de' : 'en'),
      supportedLocales: const [Locale('en'), Locale('de')],
      localizationsDelegates: GlobalMaterialLocalizations.delegates,
      theme: ThemeData(fontFamily: 'packages/sortsys_ui/Ubuntu'),
      builder: (context, child) {
        final media = MediaQuery.of(context);

        return MediaQuery(
          data: media.copyWith(textScaler: TextScaler.linear(german ? 2 : 1)),
          child: Directionality(
            textDirection: german ? TextDirection.rtl : TextDirection.ltr,
            child: SsTheme(colors: SsColors.dark, child: child!),
          ),
        );
      },
      home: Scaffold(
        body: Builder(
          builder: (context) {
            return SsButton(
              onPressed: () {
                unawaited(
                  showVendorDeleteDialog(
                    context,
                    vendor: fixture.baseline,
                    coordinator: fixture.coordinator,
                    queryIdentity: 'actor',
                    isCurrent: () {
                      return fixture.access.current;
                    },
                    canDelete: () {
                      return fixture.access.canDelete;
                    },
                    changes: fixture,
                  ).then((id) {
                    fixture.results.add(id);
                  }),
                );
              },
              child: const Text('Open vendor'),
            );
          },
        ),
      ),
    ),
  );
  await tester.tap(find.text('Open vendor'));
  await tester.pumpAndSettle();
}

final class _Fixture extends ChangeNotifier {
  final baseline = _vendor();
  final store = _Store();
  final access = _Access();
  final results = <String?>[];
  late final coordinator = VendorDeleteCoordinator(
    access: access,
    receipts: store,
  );

  VendorWriteReceipt? get receipt {
    final encoded = store.encoded;

    return encoded == null ? null : VendorWriteReceipt.decode(encoded);
  }

  VendorWriteReceipt prepared() {
    return VendorWriteReceipt(
      scope: access.scope,
      nonce: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      createdAt: DateTime.utc(2024),
      deleteInput: const models.ProductsVendorsDeleteInput(id: 'vendor'),
      baseline: baseline,
    );
  }

  void refresh() {
    notifyListeners();
  }
}

final class _Store implements VendorReceiptStore {
  String? encoded;
  bool failRead = false;
  bool failClear = false;
  bool failAfterClear = false;
  int writes = 0;

  @override
  Future<VendorWriteReceipt?> read(String scope) async {
    if (failRead) {
      throw StateError('JOURNAL_READ_FAILED');
    }

    return encoded == null ? null : VendorWriteReceipt.decode(encoded!);
  }

  @override
  Future<void> write(VendorWriteReceipt receipt) async {
    writes++;
    encoded = receipt.encode();
  }

  @override
  Future<void> clear(String scope) async {
    if (failClear && !failAfterClear) {
      throw StateError('CLEAR_FAILED');
    }

    encoded = null;

    if (failClear) {
      throw StateError('CLEAR_FAILED_AFTER_REMOVAL');
    }
  }
}

final class _Access implements VendorDeleteAccess {
  @override
  final scope = 'vendor-dialog:scope';
  var vendor = _vendor();
  bool current = true;
  bool canDelete = true;
  bool deleted = false;
  bool loseAcknowledgement = false;
  int deletes = 0;
  int reads = 0;
  Completer<void>? deleteGate;

  @override
  void checkCurrent() {
    if (!current) {
      throw StateError('OWNER_CHANGED');
    }
  }

  @override
  void checkDelete(models.ProductsVendorsDeleteInput input) {
    checkCurrent();

    if (!canDelete || input.id != 'vendor') {
      throw StateError('DELETE_NOT_ALLOWED');
    }
  }

  @override
  Future<models.ProductVendor?> getVendor(String id) async {
    checkCurrent();

    reads++;

    return deleted ? null : vendor;
  }

  @override
  Future<models.ProductsVendorsDeleteOutput> deleteVendor(
    models.ProductsVendorsDeleteInput input,
  ) async {
    checkDelete(input);

    deletes++;
    deleted = true;

    await deleteGate?.future;

    checkDelete(input);

    if (loseAcknowledgement) {
      throw StateError('ACKNOWLEDGEMENT_LOST');
    }

    return const models.ProductsVendorsDeleteOutput(success: true);
  }

  @override
  void checkCreate(models.ProductsVendorsCreateInput input) {
    throw StateError('UNEXPECTED_CREATE');
  }

  @override
  void checkUpdate(models.ProductsVendorsUpdateInput input) {
    throw StateError('UNEXPECTED_UPDATE');
  }

  @override
  Future<models.ProductsVendorsCreateOutput> createVendor(
    models.ProductsVendorsCreateInput input,
  ) async {
    throw StateError('UNEXPECTED_CREATE');
  }

  @override
  Future<models.ProductsVendorsUpdateOutput> updateVendor(
    models.ProductsVendorsUpdateInput input,
  ) async {
    throw StateError('UNEXPECTED_UPDATE');
  }
}

models.ProductVendor _vendor({String name = 'Vendor'}) {
  return models.ProductVendor(
    id: 'vendor',
    name: name,
    createdAt: DateTime.utc(2024),
    modifiedAt: DateTime.utc(2024, 2),
  );
}
