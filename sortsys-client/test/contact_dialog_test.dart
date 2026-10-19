import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/api.g.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/api/model.dart';
import 'package:sortsys_client/api/procedure.dart';
import 'package:sortsys_client/features/contacts/contact_dialog.dart';
import 'package:sortsys_client/features/contacts/contact_draft.dart';
import 'package:sortsys_client/features/contacts/contact_form_fields.dart';
import 'package:sortsys_client/features/contacts/contact_receipt.dart';
import 'package:sortsys_client/features/contacts/contact_rpc_access.dart';
import 'package:sortsys_client/features/contacts/contact_write_coordinator.dart';
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

  testWidgets('contact create waits for genuine-ID readback', (tester) async {
    final fixture = _Fixture();
    final gate = Completer<void>();
    fixture.readGate = gate;

    addTearDown(() {
      if (!gate.isCompleted) {
        gate.complete();
      }
    });

    await _pump(tester, fixture);

    expect(_values(tester).firstName.text, 'After');
    expect(_values(tester).lastName.text, 'Name');

    await _enter(tester, _values(tester).salutation, '  Dr  ');
    await tester.tap(find.text('Create'));
    await _waitFor(tester, () {
      return fixture.reads == 1;
    });

    expect(fixture.saved, isEmpty);
    expect(fixture.writes, 1);
    expect(_button(tester, 'Create').onPressed, isNull);
    expect(_button(tester, 'Cancel').onPressed, isNull);
    expect(
      ContactWriteReceipt.decode(fixture.store.encoded!).acknowledged,
      isTrue,
    );

    gate.complete();
    await _waitFor(tester, () {
      return fixture.saved.isNotEmpty;
    });

    final input = fixture.createdInput!;

    expect(input.salutation.value, 'Dr');
    expect(input.firstName.value, 'After');
    expect(input.lastName.value, 'Name');
    expect(input.address.presence, RpcPresence.value);
    expect(input.address.value, isNull);
    expect(input.phoneNumbers.value, isEmpty);
    expect(input.emailAddresses.value, isEmpty);
    expect(fixture.saved.single.id, 'contact');
    expect(fixture.store.encoded, isNull);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'contact edit pins target and submits canonical nullable values',
    (tester) async {
      final fixture = _Fixture(update: true);

      await _pump(tester, fixture);

      expect(_values(tester).firstName.text, 'Before');

      await _enter(tester, _values(tester).firstName, '  After  ');
      await _enter(tester, _values(tester).salutation, ' ');
      await tester.tap(find.text('Save'));
      await _waitFor(tester, () {
        return fixture.saved.isNotEmpty;
      });

      expect(fixture.updatedInput?.id, 'contact');
      expect(fixture.updatedInput?.data.firstName.value, 'After');
      expect(fixture.updatedInput?.data.salutation.presence, RpcPresence.value);
      expect(fixture.updatedInput?.data.salutation.value, isNull);
      expect(fixture.writes, 1);
      expect(fixture.reads, 2);
      expect(fixture.store.encoded, isNull);
    },
  );

  testWidgets(
    'contact lost create acknowledgement exposes no inferred recovery',
    (tester) async {
      final fixture = _Fixture();
      fixture.loseAcknowledgement = true;

      await _pump(tester, fixture);
      await tester.tap(find.text('Create'));
      await _waitFor(tester, () {
        return find
            .textContaining('server acknowledgement is missing')
            .evaluate()
            .isNotEmpty;
      });

      expect(fixture.writes, 1);
      expect(fixture.reads, 0);
      expect(fixture.saved, isEmpty);
      expect(fixture.store.encoded, isNotNull);
      expect(find.text('Verify with read-only request'), findsNothing);
      expect(find.text('Discard unsent operation'), findsNothing);
      expect(_button(tester, 'Create').onPressed, isNull);
    },
  );

  testWidgets(
    'contact edit recovery remains read-only after manage revocation',
    (tester) async {
      final fixture = _Fixture(update: true);
      fixture.loseAcknowledgement = true;

      await _pump(tester, fixture);
      await _enter(tester, _values(tester).firstName, 'After');
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

      expect(fixture.saved.single.firstName, 'After');
      expect(fixture.writes, 1);
      expect(fixture.reads, 2);
      expect(fixture.store.encoded, isNull);
    },
  );

  testWidgets(
    'contact pending work permits unsent discard or genuine-ID proof',
    (tester) async {
      for (final unsent in [true, false]) {
        final fixture = _Fixture();
        final input = ContactDraft.fromQuery('After Name').createInput();
        final receipt = ContactWriteReceipt(
          scope: fixture.scope,
          nonce: '0123456789abcdef0123456789abcdef',
          createdAt: DateTime.utc(2024),
          createInput: input,
        );
        final pending = unsent
            ? receipt
            : receipt.started().confirmedCreate(
                const models.ContactsCreateOutput(id: 'contact'),
              );
        fixture.store.encoded = pending.encode();
        fixture.apply(input);
        fixture.manage = false;

        await _pump(tester, fixture);
        await tester.tap(
          find.text(
            unsent
                ? 'Discard unsent operation'
                : 'Verify with read-only request',
          ),
        );
        await _waitFor(tester, () {
          return unsent
              ? find.byType(ContactFormFields).evaluate().isNotEmpty
              : fixture.saved.isNotEmpty;
        });

        expect(fixture.writes, 0);
        expect(fixture.reads, unsent ? 0 : 1);
        expect(fixture.store.encoded, isNull);
        expect(_button(tester, 'Create').onPressed, isNull);
      }
    },
  );

  testWidgets('contact stale owner cannot publish success during readback', (
    tester,
  ) async {
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
    await _waitFor(tester, () {
      return fixture.reads == 1;
    });

    fixture.current = false;
    fixture.refresh();
    await tester.pump();

    expect(find.text('No permission'), findsOneWidget);
    expect(find.byType(ContactFormFields), findsNothing);

    gate.complete();
    await _waitFor(tester, () {
      return _button(tester, 'Cancel').onPressed != null;
    });

    expect(fixture.saved, isEmpty);
    expect(fixture.writes, 1);
    expect(fixture.store.encoded, isNotNull);
  });

  testWidgets('contact conflict requires close and reload without writing', (
    tester,
  ) async {
    final fixture = _Fixture(update: true);
    fixture.apply(ContactDraft.fromQuery('Other Name').createInput());

    await _pump(tester, fixture);
    await _enter(tester, _values(tester).firstName, 'After');
    await tester.tap(find.text('Save'));
    await _waitFor(tester, () {
      return find
          .textContaining('The contact has changed.')
          .evaluate()
          .isNotEmpty;
    });

    expect(fixture.writes, 0);
    expect(fixture.reads, 1);
    expect(fixture.store.encoded, isNull);
    expect(_button(tester, 'Save').onPressed, isNull);
    expect(fixture.saved, isEmpty);
  });

  testWidgets('contact journal must be checked before editing or dispatch', (
    tester,
  ) async {
    final fixture = _Fixture();
    fixture.store.failRead = true;

    await _pump(tester, fixture);

    expect(find.byType(ContactFormFields), findsNothing);
    expect(_button(tester, 'Create').onPressed, isNull);
    expect(fixture.writes, 0);

    fixture.store.failRead = false;

    await tester.tap(find.text('Reload'));
    await _waitFor(tester, () {
      return find.byType(ContactFormFields).evaluate().isNotEmpty;
    });

    expect(_values(tester).firstName.text, 'After');
    expect(fixture.writes, 0);
    expect(fixture.reads, 0);
  });
}

ContactFormValues _values(WidgetTester tester) {
  return tester
      .widget<ContactFormFields>(find.byType(ContactFormFields))
      .values;
}

SsButton _button(WidgetTester tester, String label) {
  return tester.widget<SsButton>(find.widgetWithText(SsButton, label));
}

Future<void> _enter(
  WidgetTester tester,
  TextEditingController controller,
  String value,
) async {
  final field = find.byWidgetPredicate((widget) {
    return widget is EditableText && widget.controller == controller;
  });

  await tester.ensureVisible(field);
  await tester.enterText(field, value);
  await tester.pump();
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

  fail('Contact dialog did not reach the expected I/O state.');
}

Future<void> _pump(WidgetTester tester, _Fixture fixture) async {
  await tester.pumpWidget(
    MaterialApp(
      locale: const Locale('en'),
      supportedLocales: const [Locale('en'), Locale('de')],
      localizationsDelegates: GlobalMaterialLocalizations.delegates,
      home: SsTheme(
        colors: SsColors.light,
        child: Scaffold(
          body: ListenableBuilder(
            listenable: fixture,
            builder: (context, child) {
              return ContactDialog(
                contact: fixture.baseline,
                initialQuery: '  After  Name  ',
                coordinator: fixture.coordinator,
                queryIdentity: fixture.scope,
                isCurrent: () {
                  return fixture.current;
                },
                enabled: fixture.manage,
                onSaved: fixture.saved.add,
                onCancel: () {},
              );
            },
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

final class _Fixture extends ChangeNotifier {
  _Fixture({bool update = false}) {
    scope = 'origin|tenant|actor|$update';
    baseline = update ? contact : null;
    coordinator = ContactWriteCoordinator(
      access: ContactRpcAccess(
        scope: scope,
        contactId: update ? 'contact' : null,
        read: read,
        write: write,
        isCurrent: () {
          return current;
        },
        can: can,
      ),
      receipts: store,
    );
  }

  final store = _Store();
  final saved = <models.Contact>[];
  late final String scope;
  late final models.Contact? baseline;
  late final ContactWriteCoordinator coordinator;
  models.Contact contact = models.Contact(
    id: 'contact',
    salutation: 'Dr',
    firstName: 'Before',
    lastName: 'Name',
    phoneNumbers: [],
    emailAddresses: [],
    createdAt: DateTime.utc(2024),
    modifiedAt: DateTime.utc(2024, 2),
  );
  bool current = true;
  bool manage = true;
  bool loseAcknowledgement = false;
  int writes = 0;
  int reads = 0;
  Completer<void>? readGate;
  models.ContactsCreateInput? createdInput;
  models.ContactsUpdateInput? updatedInput;

  bool can(String permission) {
    return permission == 'view:contacts' ||
        (permission == 'manage:contacts' && manage);
  }

  void refresh() {
    notifyListeners();
  }

  void apply(models.ContactsCreateInput input) {
    contact = models.Contact(
      id: 'contact',
      salutation: input.salutation.value,
      firstName: input.firstName.value,
      lastName: input.lastName.value,
      address: input.address.value,
      phoneNumbers: input.phoneNumbers.value,
      emailAddresses: input.emailAddresses.value,
      createdAt: contact.createdAt,
      modifiedAt: DateTime.utc(2024, 3),
    );
  }

  Future<O> write<I, O>(RpcMutation<I, O> mutation, I input) async {
    writes++;
    final Object output;

    if (mutation == ApiMutations.contactsCreate) {
      final value = input as models.ContactsCreateInput;
      createdInput = value;
      apply(value);
      output = const models.ContactsCreateOutput(id: 'contact');
    } else {
      expect(mutation, same(ApiMutations.contactsUpdate));

      final value = input as models.ContactsUpdateInput;
      updatedInput = value;
      apply(value.data);
      output = const models.ContactsUpdateOutput(success: true);
    }

    if (loseAcknowledgement) {
      throw StateError('ACKNOWLEDGEMENT_LOST');
    }

    return output as O;
  }

  Future<O> read<I, O>(RpcQuery<I, O> query, I input) async {
    expect(query, same(ApiQueries.contactsGet));
    expect((input as models.ContactsGetInput).id, 'contact');
    reads++;

    final gate = readGate;

    if (gate != null) {
      await gate.future;
    }

    return contact as O;
  }
}

final class _Store implements ContactReceiptStore {
  String? encoded;
  bool failRead = false;

  @override
  Future<ContactWriteReceipt?> read(String scope) async {
    if (failRead) {
      throw StateError('JOURNAL_READ_FAILED');
    }

    return encoded == null ? null : ContactWriteReceipt.decode(encoded!);
  }

  @override
  Future<void> write(ContactWriteReceipt receipt) async {
    encoded = receipt.encode();
  }

  @override
  Future<void> clear(String scope) async {
    encoded = null;
  }
}
