import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/model.dart';
import 'package:sortsys_client/api/generated/api.g.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/api/procedure.dart';
import 'package:sortsys_client/features/products/product_draft.dart';
import 'package:sortsys_client/features/products/product_form_fields.dart';
import 'package:sortsys_client/features/products/product_form_reads.dart';
import 'package:sortsys_client/features/products/product_master_dialog.dart';
import 'package:sortsys_client/features/products/product_master_receipt.dart';
import 'package:sortsys_client/features/products/product_master_rpc_access.dart';
import 'package:sortsys_client/features/products/product_master_write_coordinator.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

void main() {
  setUpAll(() async {
    final fonts = FontLoader('packages/sortsys_ui/Ubuntu');

    for (final weight in ['Regular', 'Medium', 'Bold']) {
      fonts.addFont(rootBundle.load(
        'packages/sortsys_ui/assets/fonts/ubuntu/Ubuntu-$weight.ttf',
      ));
    }

    await fonts.load();
  });

  testWidgets(
    'product create validates fields and waits for genuine-ID readback',
    (tester) async {
      final fixture = _Fixture();
      final gate = Completer<void>();
      fixture.readGate = gate;
      addTearDown(() {
        if (!gate.isCompleted) {
          gate.complete();
        }
      });

      await _pump(tester, fixture);
      await tester.tap(find.text('Create'));
      await tester.pumpAndSettle();

      expect(fixture.writes, 0);
      expect(_values(tester).name.text, '  After  ');

      await _enter(tester, 'number', '10');
      await _enter(tester, 'brand', ' Maker ');
      await _enter(tester, 'description', ' note ');
      await _enter(tester, 'report', ' Report ');
      await _enter(tester, 'baseUnit', 'kg');
      await tester.ensureVisible(find.text('Add unit'));
      await tester.tap(find.text('Add unit'));
      await tester.pumpAndSettle();
      await _enter(tester, 'unitName', 'box');
      await _enter(tester, 'unitAmount', '2');
      await tester.tap(find.text('Create'));
      await _waitFor(tester, () {
        return fixture.reads == 1;
      });

      expect(fixture.saved, isEmpty);
      expect(fixture.writes, 1);
      expect(_button(tester, 'Create').onPressed, isNull);
      expect(ProductMasterWriteReceipt.decode(
        fixture.store.encoded!,
      ).acknowledged, isTrue);

      gate.complete();
      await _waitFor(tester, () {
        return fixture.saved.isNotEmpty;
      });

      expect(fixture.createdInput?.name, 'After');
      expect(fixture.createdInput?.brand.valueOrNull, 'Maker');
      expect(fixture.createdInput?.description.valueOrNull, 'note');
      expect(fixture.createdInput?.regieReportName.valueOrNull, 'Report');
      expect(fixture.createdInput?.otherUnits.value.values, {'box': 2});
      expect(fixture.saved.single.id, 'product');
      expect(fixture.unitQueries, greaterThan(0));
      expect(fixture.store.encoded, isNull);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'product edit prefills fields and omits immutable number from payload',
    (tester) async {
      final fixture = _Fixture(update: true);
      await _pump(tester, fixture);

      expect(_values(tester).name.text, 'Before');
      expect(_values(tester).units.single.amount.text, '1');
      expect(find.text('Number *'), findsNothing);

      await _enter(tester, 'name', '  After  ');
      await _enter(tester, 'report', ' ');
      await _enter(tester, 'unitAmount', '2');
      await tester.tap(find.text('Save'));
      await _waitFor(tester, () {
        return fixture.saved.isNotEmpty;
      });

      expect(fixture.updatedInput?.id, 'product');
      expect(fixture.updatedInput?.data.customId.presence, RpcPresence.absent);
      expect(fixture.updatedInput?.data.name.valueOrNull, 'After');
      expect(fixture.updatedInput?.data.regieReportName.hasValue, isTrue);
      expect(fixture.updatedInput?.data.regieReportName.valueOrNull, isNull);
      expect(fixture.updatedInput?.data.otherUnits.value.values, {'box': 2});
      expect(fixture.writes, 1);
      expect(fixture.reads, 2);
    },
  );

  testWidgets(
    'product lost create acknowledgement exposes no guessed recovery',
    (tester) async {
      final fixture = _Fixture()..loseAcknowledgement = true;
      await _pump(tester, fixture);
      await _enter(tester, 'number', '10');
      await _enter(tester, 'baseUnit', 'kg');
      await tester.tap(find.text('Create'));
      await _waitFor(tester, () {
        return find.textContaining('server acknowledgement is missing')
            .evaluate().isNotEmpty;
      });

      expect(fixture.writes, 1);
      expect(fixture.reads, 0);
      expect(find.text('Verify with read-only request'), findsNothing);
      expect(find.text('Discard unsent operation'), findsNothing);
      expect(_button(tester, 'Create').onPressed, isNull);
      expect(fixture.saved, isEmpty);
      expect(fixture.store.encoded, isNotNull);
    },
  );

  testWidgets(
    'product lost edit acknowledgement recovers after manage revocation',
    (tester) async {
      final fixture = _Fixture(update: true)..loseAcknowledgement = true;
      await _pump(tester, fixture);
      await _enter(tester, 'name', 'After');
      await tester.tap(find.text('Save'));
      await _waitFor(tester, () {
        return find.text('Verify with read-only request').evaluate().isNotEmpty;
      });

      fixture.manage = false;
      fixture.refresh();
      await tester.pump();
      await tester.tap(find.text('Verify with read-only request'));
      await _waitFor(tester, () {
        return fixture.saved.isNotEmpty;
      });

      expect(fixture.saved.single.name, 'After');
      expect(fixture.writes, 1);
      expect(fixture.reads, 2);
      expect(fixture.store.encoded, isNull);
    },
  );

  testWidgets(
    'product pending receipt permits only unsent discard or read-only proof',
    (tester) async {
      for (final unsent in [true, false]) {
        final fixture = _Fixture();
        final receipt = ProductMasterWriteReceipt(
          scope: fixture.scope,
          nonce: '0123456789abcdef0123456789abcdef',
          createdAt: DateTime.utc(2024),
          createInput: ProductDraft(
            customId: '10', name: 'After', baseUnit: 'kg',
          ).createInput(),
        );
        fixture.store.encoded = (unsent ? receipt : receipt.started()
            .confirmedCreate(const models.ProductsCreateOutput(id: 'product')))
            .encode();
        fixture.product = models.Product(
          id: 'product', customId: 10, name: 'After', baseUnit: 'kg',
          otherUnits: models.ApplyPriceImportRowOtherUnits({}), categories: [],
        );
        fixture.manage = false;

        await _pump(tester, fixture);
        await tester.tap(find.text(unsent
            ? 'Discard unsent operation' : 'Verify with read-only request'));
        await _waitFor(tester, () {
          return unsent ? find.byType(ProductFormFields).evaluate().isNotEmpty
              : fixture.saved.isNotEmpty;
        });

        expect(fixture.writes, 0);
        expect(fixture.reads, unsent ? 0 : 1);
        expect(fixture.store.encoded, isNull);
        expect(_button(tester, 'Create').onPressed, isNull);
      }
    },
  );

  testWidgets(
    'product stale owner suppresses saved callback during held readback',
    (tester) async {
      final fixture = _Fixture();
      final gate = Completer<void>();
      fixture.readGate = gate;
      addTearDown(() {
        if (!gate.isCompleted) {
          gate.complete();
        }
      });

      await _pump(tester, fixture);
      await _enter(tester, 'number', '10');
      await _enter(tester, 'baseUnit', 'kg');
      await tester.tap(find.text('Create'));
      await _waitFor(tester, () {
        return fixture.reads == 1;
      });
      fixture.current = false;
      fixture.refresh();
      await tester.pump();

      expect(find.text('No permission'), findsOneWidget);
      expect(find.byType(ProductFormFields), findsNothing);

      gate.complete();
      await _waitFor(tester, () {
        return _button(tester, 'Cancel').onPressed != null;
      });

      expect(fixture.saved, isEmpty);
      expect(fixture.writes, 1);
      expect(fixture.store.encoded, isNotNull);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'product German RTL dialog scrolls at320 doubled Ubuntu with unit focus',
    (tester) async {
      final fixture = _Fixture();
      await _pump(tester, fixture, language: 'de', width: 320, scale: 2);
      await tester.ensureVisible(find.text('Weitere Einheit'));
      await tester.tap(find.text('Weitere Einheit'));
      await tester.pumpAndSettle();

      expect(_values(tester).units.single.nameFocus.hasFocus, isTrue);
      expect(Directionality.of(tester.element(find.byType(ProductMasterDialog))),
          TextDirection.rtl);

      await tester.ensureVisible(find.text('Einheit entfernen'));
      await tester.tap(find.text('Einheit entfernen'));
      await tester.pumpAndSettle();

      expect(_values(tester).units, isEmpty);
      expect(fixture.writes, 0);
      expect(tester.takeException(), isNull);
    },
  );
}

ProductFormValues _values(WidgetTester tester) {
  return tester.widget<ProductFormFields>(find.byType(ProductFormFields)).values;
}

Finder _field(WidgetTester tester, String field) {
  final values = _values(tester);
  final controller = switch (field) {
    'number' => values.customId,
    'name' => values.name,
    'brand' => values.brand,
    'description' => values.description,
    'report' => values.regieReportName,
    'baseUnit' => values.baseUnit,
    'unitName' => values.units.single.name,
    'unitAmount' => values.units.single.amount,
    _ => throw ArgumentError.value(field),
  };

  return find.byWidgetPredicate((widget) {
    return widget is TextField && widget.controller == controller;
  });
}

Future<void> _enter(WidgetTester tester, String field, String value) async {
  final input = _field(tester, field);
  await tester.ensureVisible(input);
  await tester.enterText(input, value);
  await tester.pump();
}

SsButton _button(WidgetTester tester, String label) {
  return tester.widget<SsButton>(find.widgetWithText(SsButton, label));
}

Future<void> _waitFor(WidgetTester tester, bool Function() ready) async {
  for (var attempt = 0; attempt < 60; attempt++) {
    await tester.runAsync(() async {
      await Future<void>.delayed(const Duration(milliseconds: 10));
    });
    await tester.pump();

    if (ready()) {
      return;
    }
  }

  fail('Product dialog did not reach the expected I/O state.');
}

Future<void> _pump(
  WidgetTester tester,
  _Fixture fixture, {
  String language = 'en',
  double width = 800,
  double scale = 1,
}) async {
  tester.view.physicalSize = Size(width, 800);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);

  await tester.pumpWidget(MaterialApp(
    locale: Locale(language),
    supportedLocales: const [Locale('en'), Locale('de')],
    localizationsDelegates: GlobalMaterialLocalizations.delegates,
    home: SsTheme(
      colors: SsColors.light,
      child: MediaQuery(
        data: MediaQueryData(
          size: Size(width, 800), textScaler: TextScaler.linear(scale),
        ),
        child: Directionality(
          textDirection: language == 'de' ? TextDirection.rtl : TextDirection.ltr,
          child: Scaffold(
            body: ListenableBuilder(
              listenable: fixture,
              builder: (context, child) {
                return ProductMasterDialog(
                  product: fixture.baseline,
                  initialQuery: '  After  ',
                  coordinator: fixture.coordinator,
                  queryIdentity: fixture.scope,
                  isCurrent: () {
                    return fixture.current;
                  },
                  enabled: fixture.manage,
                  loadUnits: fixture.formReads.units,
                  onSaved: fixture.saved.add,
                  onCancel: () {},
                );
              },
            ),
          ),
        ),
      ),
    ),
  ));
  await tester.pumpAndSettle();
}

final class _Fixture extends ChangeNotifier {
  _Fixture({bool update = false}) {
    scope = 'origin|tenant|actor|$update';
    baseline = update ? product : null;
    coordinator = ProductMasterWriteCoordinator(
      access: ProductMasterRpcAccess(
        scope: scope,
        productId: update ? 'product' : null,
        read: read,
        write: write,
        isCurrent: () {
          return current;
        },
        can: can,
      ),
      receipts: store,
    );
    formReads = ProductFormReads(
      read: read,
      isCurrent: () {
        return current;
      },
      can: can,
    );
  }

  final store = _Store();
  final saved = <models.Product>[];
  late final String scope;
  late final models.Product? baseline;
  late final ProductMasterWriteCoordinator coordinator;
  late final ProductFormReads formReads;
  models.Product product = models.Product(
    id: 'product', customId: 10, name: 'Before', baseUnit: 'kg',
    regieReportName: 'Before report',
    otherUnits: models.ApplyPriceImportRowOtherUnits({'box': 1}), categories: [],
  );
  bool current = true;
  bool manage = true;
  bool loseAcknowledgement = false;
  int writes = 0;
  int reads = 0;
  int unitQueries = 0;
  Completer<void>? readGate;
  models.ProductsCreateInput? createdInput;
  models.ProductsUpdateInput? updatedInput;

  bool can(String permission) {
    return permission == 'view:products' || manage;
  }

  void refresh() {
    notifyListeners();
  }

  Future<O> write<I, O>(RpcMutation<I, O> mutation, I input) async {
    writes++;
    final Object output;

    if (mutation == ApiMutations.productsCreate) {
      final value = input as models.ProductsCreateInput;
      createdInput = value;
      product = models.Product(
        id: 'product', customId: value.customId, name: value.name,
        brand: value.brand.valueOrNull,
        description: value.description.valueOrNull,
        regieReportName: value.regieReportName.valueOrNull,
        baseUnit: value.baseUnit, otherUnits: value.otherUnits.value,
        categories: [],
      );
      output = const models.ProductsCreateOutput(id: 'product');
    } else {
      expect(mutation, same(ApiMutations.productsUpdate));
      final value = input as models.ProductsUpdateInput;
      updatedInput = value;
      final data = value.data;
      product = models.Product(
        id: value.id, customId: product.customId, name: data.name.value,
        brand: data.brand.valueOrNull, description: data.description.valueOrNull,
        regieReportName: data.regieReportName.valueOrNull,
        baseUnit: data.baseUnit.value, otherUnits: data.otherUnits.value,
        categories: product.categories,
      );
      output = const models.ProductsUpdateOutput(success: true);
    }

    if (loseAcknowledgement) {
      throw StateError('ACKNOWLEDGEMENT_LOST');
    }

    return output as O;
  }

  Future<O> read<I, O>(RpcQuery<I, O> query, I input) async {
    if (query == ApiQueries.productsUnitsList) {
      unitQueries++;

      return const ['box', 'case'] as O;
    }

    expect(query, same(ApiQueries.productsGet));
    expect((input as models.ProductsGetInput).id, 'product');
    reads++;

    final gate = readGate;

    if (gate != null) {
      await gate.future;
    }

    return product as O;
  }
}

final class _Store implements ProductMasterReceiptStore {
  String? encoded;

  @override
  Future<ProductMasterWriteReceipt?> read(String scope) async {
    return encoded == null ? null : ProductMasterWriteReceipt.decode(encoded!);
  }

  @override
  Future<void> write(ProductMasterWriteReceipt receipt) async {
    encoded = receipt.encode();
  }

  @override
  Future<void> clear(String scope) async {
    encoded = null;
  }
}
