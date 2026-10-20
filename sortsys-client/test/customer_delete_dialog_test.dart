import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/features/customers/customer_delete_coordinator.dart';
import 'package:sortsys_client/features/customers/customer_delete_dialog.dart';
import 'package:sortsys_client/features/customers/customer_delete_receipt.dart';
import 'package:sortsys_client/features/customers/session_customer_delete_dialog.dart';
import 'package:sortsys_client/state/session_controller.dart';
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

  testWidgets('customer deletion requires its real confirmation checkbox', (
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

    expect(fixture.results, ['customer']);
    expect(fixture.access.deletes, 1);
    expect(fixture.access.reads, 1);
    expect(fixture.store.writes, 3);
    expect(fixture.store.encoded, isNull);
    expect(find.byType(CustomerDeleteDialog), findsNothing);
  });

  testWidgets(
    'customer deletion blocks duplicate submit close and back while busy',
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

      expect(find.byType(CustomerDeleteDialog), findsOneWidget);
      expect(fixture.results, isEmpty);
      expect(fixture.access.deletes, 1);

      fixture.access.deleteGate!.complete();
      await tester.pumpAndSettle();

      expect(fixture.results, ['customer']);
      expect(fixture.access.reads, 1);
      expect(fixture.store.encoded, isNull);
    },
  );

  testWidgets(
    'lost customer delete acknowledgement stays blocked after reopening',
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
      expect(fixture.receipt!.acknowledged, isFalse);
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
    'customer delete conflict blocks mutation until a fresh detail load',
    (tester) async {
      final fixture = _Fixture();
      fixture.access.customer = _customer(name: 'Concurrent change');
      addTearDown(fixture.dispose);

      await _open(tester, fixture);
      await tester.tap(find.byType(SsCheckbox));
      await tester.tap(find.text('Delete'));
      await tester.pumpAndSettle();

      expect(fixture.access.deletes, 0);
      expect(fixture.store.encoded, isNull);
      expect(_button(tester, 'Delete').onPressed, isNull);
      expect(find.textContaining('The customer has changed.'), findsOneWidget);
    },
  );

  testWidgets(
    'unreadable customer journal gates deletion until status reload',
    (tester) async {
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
    },
  );

  testWidgets(
    'proven unsent customer deletion can be discarded after role loss',
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

  testWidgets(
    'acknowledged customer deletion recovers locally after role loss',
    (tester) async {
      final fixture = _Fixture();
      fixture.store.encoded = fixture
          .prepared()
          .started()
          .confirmed(const models.CustomersDeleteOutput(success: true))
          .encode();
      addTearDown(fixture.dispose);

      await _open(tester, fixture);

      fixture.access.canDelete = false;
      fixture.refresh();
      await tester.pump();

      await tester.tap(find.text('Finish acknowledged deletion'));
      await tester.pumpAndSettle();

      expect(fixture.results, ['customer']);
      expect(fixture.store.encoded, isNull);
      expect(fixture.access.deletes, 0);
      expect(fixture.access.reads, 0);
    },
  );

  testWidgets(
    'genuine customer deletion survives cleanup failure before or after',
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

        expect(fixture.results, ['customer']);
        expect(fixture.access.deletes, 1);
        expect(fixture.access.reads, 1);
        expect(fixture.store.writes, 3);
        expect(fixture.receipt?.acknowledged, afterClear ? isNull : isTrue);
      }
    },
  );

  testWidgets('stale customer dialog cannot accept a held deletion response', (
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
    expect(find.text('Customer'), findsNothing);

    fixture.access.deleteGate!.complete();
    await tester.pumpAndSettle();

    expect(fixture.results, isEmpty);
    expect(fixture.access.deletes, 1);
    expect(fixture.receipt!.dispatching, isTrue);
    expect(fixture.receipt!.acknowledged, isFalse);
    expect(_button(tester, 'Delete').onPressed, isNull);
  });

  testWidgets('customer confirmation scrolls at320px doubled German RTL', (
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
      MediaQuery.sizeOf(
        tester.element(find.byType(CustomerDeleteDialog)),
      ).width,
      320,
    );
    expect(tester.takeException(), isNull);

    await tester.tap(find.text('Abbrechen'));
    await tester.pumpAndSettle();

    expect(fixture.results, [null]);
    expect(fixture.access.deletes, 0);
  });

  testWidgets(
    'customer deletion freezes baseline before mutable parent changes',
    (tester) async {
      final phones = [
        const models.CustomerPhoneNumbersItem(number: 'original'),
      ];
      final fixture = _Fixture(baseline: _customer(phones: phones));
      addTearDown(fixture.dispose);

      await _open(tester, fixture);
      phones.clear();
      await tester.tap(find.byType(SsCheckbox));
      await tester.tap(find.text('Delete'));
      await tester.pumpAndSettle();

      expect(fixture.results, ['customer']);
      expect(fixture.access.deletes, 1);
      expect(
        fixture.store.snapshots.first.baseline.phoneNumbers.single.number,
        'original',
      );
      expect(fixture.baseline.phoneNumbers, isEmpty);
    },
  );

  testWidgets('held customer controls reject replacement owners and disposal', (
    tester,
  ) async {
    final fixture = _Fixture();
    addTearDown(fixture.dispose);

    await tester.pumpWidget(_direct(fixture, identity: 'first'));
    await tester.pumpAndSettle();

    final checkbox = tester.widget<SsCheckbox>(find.byType(SsCheckbox));
    final change = checkbox.onChanged!;
    final submit = _button(tester, 'Delete').onPressed!;

    await tester.pumpWidget(_direct(fixture, identity: 'replacement'));
    await tester.pumpAndSettle();

    expect(find.text('No permission'), findsOneWidget);
    expect(_button(tester, 'Delete').onPressed, isNull);

    change(true);
    submit();
    await tester.pump();

    expect(fixture.results, isEmpty);
    expect(fixture.access.deletes, 0);
    expect(fixture.store.writes, 0);

    await tester.pumpWidget(const SizedBox());

    change(true);
    submit();
    await tester.pump();

    expect(fixture.access.deletes, 0);
    expect(fixture.store.writes, 0);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'real final session rejects customer delete modal before storage',
    (tester) async {
      final session = SessionController();
      addTearDown(session.dispose);
      var completed = false;
      String? result = 'unresolved';

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Builder(
              builder: (context) {
                return TextButton(
                  onPressed: () async {
                    result = await showSessionCustomerDeleteDialog(
                      context,
                      session,
                      customer: _customer(),
                    );
                    completed = true;
                  },
                  child: const Text('Open'),
                );
              },
            ),
          ),
        ),
      );

      await tester.tap(find.text('Open'));
      await tester.pumpAndSettle();

      expect(completed, isTrue);
      expect(result, isNull);
      expect(find.byType(CustomerDeleteDialog), findsNothing);
      expect(tester.takeException(), isNull);
    },
  );
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
                  showCustomerDeleteDialog(
                    context,
                    customer: fixture.baseline,
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
              child: const Text('Open customer'),
            );
          },
        ),
      ),
    ),
  );

  await tester.tap(find.text('Open customer'));
  await tester.pumpAndSettle();
}

final class _Fixture extends ChangeNotifier {
  _Fixture({models.Customer? baseline}) : baseline = baseline ?? _customer() {
    access.customer = freezeCustomerDeleteBaseline(this.baseline);
  }

  final models.Customer baseline;
  final store = _Store();
  final access = _Access();
  final results = <String?>[];
  late final coordinator = CustomerDeleteCoordinator(
    access: access,
    receipts: store,
  );

  CustomerDeleteReceipt? get receipt {
    final encoded = store.encoded;

    return encoded == null ? null : CustomerDeleteReceipt.decode(encoded);
  }

  CustomerDeleteReceipt prepared() {
    return CustomerDeleteReceipt(
      scope: access.scope,
      nonce: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      createdAt: DateTime.utc(2024),
      input: const models.CustomersDeleteInput(id: 'customer'),
      baseline: baseline,
    );
  }

  void refresh() {
    notifyListeners();
  }
}

final class _Store implements CustomerDeleteReceiptStore {
  String? encoded;
  bool failRead = false;
  bool failClear = false;
  bool failAfterClear = false;
  int writes = 0;
  final snapshots = <CustomerDeleteReceipt>[];

  @override
  Future<CustomerDeleteReceipt?> read(String scope) async {
    if (failRead) {
      throw StateError('JOURNAL_READ_FAILED');
    }

    return encoded == null ? null : CustomerDeleteReceipt.decode(encoded!);
  }

  @override
  Future<void> write(CustomerDeleteReceipt receipt) async {
    writes++;
    encoded = receipt.encode();
    snapshots.add(CustomerDeleteReceipt.decode(encoded!));
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

final class _Access implements CustomerDeleteAccess {
  @override
  final scope = 'customer-dialog:scope';
  var customer = _customer();
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
  void checkDelete(models.CustomersDeleteInput input) {
    checkCurrent();

    if (!canDelete || input.id != 'customer') {
      throw StateError('DELETE_NOT_ALLOWED');
    }
  }

  @override
  Future<models.Customer> getCustomer(String id) async {
    checkCurrent();

    reads++;

    if (deleted) {
      throw StateError('MISSING_CUSTOMER');
    }

    return customer;
  }

  @override
  Future<models.CustomersDeleteOutput> deleteCustomer(
    models.CustomersDeleteInput input,
  ) async {
    checkDelete(input);

    deletes++;
    deleted = true;

    await deleteGate?.future;

    checkCurrent();

    if (loseAcknowledgement) {
      throw StateError('ACKNOWLEDGEMENT_LOST');
    }

    return const models.CustomersDeleteOutput(success: true);
  }
}

models.Customer _customer({
  String name = 'Customer',
  List<models.CustomerPhoneNumbersItem> phones = const [],
}) {
  return models.Customer(
    id: 'customer',
    name: name,
    phoneNumbers: phones,
    emailAddresses: const [],
    createdAt: DateTime.utc(2024),
    modifiedAt: DateTime.utc(2024, 2),
  );
}

Widget _direct(_Fixture fixture, {required Object identity}) {
  return MaterialApp(
    theme: ThemeData(fontFamily: 'packages/sortsys_ui/Ubuntu'),
    home: SsTheme(
      colors: SsColors.dark,
      child: Scaffold(
        body: CustomerDeleteDialog(
          customer: fixture.baseline,
          coordinator: fixture.coordinator,
          queryIdentity: identity,
          isCurrent: () {
            return fixture.access.current;
          },
          onDeleted: (id) {
            fixture.results.add(id);
          },
          onCancel: () {
            fixture.results.add(null);
          },
        ),
      ),
    ),
  );
}
