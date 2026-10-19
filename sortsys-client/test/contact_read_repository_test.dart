import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/api/procedure.dart';
import 'package:sortsys_client/features/contacts/contact_read_repository.dart';

void main() {
  test('contact reads reject missing owner permission before dispatch', () async {
    final fixture = _Fixture();
    fixture.permissions.remove('view:contacts');

    await expectLater(fixture.repository.customers(), throwsStateError);
    await expectLater(fixture.repository.projects(), throwsStateError);
    expect(fixture.requests, isEmpty);
  });

  test('assigned project reads do not invent a global view requirement', () async {
    final fixture = _Fixture();
    fixture.permissions.remove('view:projects');
    fixture.permissions.remove('view:customers');

    final projects = await fixture.repository.projects();

    expect(projects.single.id, 'project-one');
    expect(fixture.requests.single.path, 'contacts.projects.list');
    expect(fixture.requests.single.input, {'contactId': 'contact-one'});
    await expectLater(fixture.repository.customers(), throwsStateError);
    expect(fixture.requests, hasLength(1));
  });

  test('customer reads use the exact generated contact filter', () async {
    final fixture = _Fixture();

    final customers = await fixture.repository.customers();

    expect(customers, isEmpty);
    expect(fixture.requests.single.path, 'contacts.customers.list');
    expect(fixture.requests.single.input, {'contactId': 'contact-one'});
  });

  test('customer permission revocation rejects a pending response', () async {
    final fixture = _Fixture();
    final pending = Completer<List<models.Customer>>();
    fixture.responses['contacts.customers.list'] = pending.future;
    final request = fixture.repository.customers();
    final rejected = expectLater(request, throwsStateError);
    fixture.permissions.remove('view:customers');
    pending.complete(const []);

    await rejected;
    expect(fixture.requests, hasLength(1));
  });

  test('changed session rejects pending project results', () async {
    final fixture = _Fixture();
    final pending = Completer<List<models.Project>>();
    fixture.responses['contacts.projects.list'] = pending.future;
    final request = fixture.repository.projects();
    final rejected = expectLater(request, throwsStateError);
    fixture.current = false;
    pending.complete(const []);

    await rejected;
    expect(fixture.requests, hasLength(1));
  });

  test('project visibility downgrade rejects a broader snapshot', () async {
    final fixture = _Fixture();
    final pending = Completer<List<models.Project>>();
    fixture.responses['contacts.projects.list'] = pending.future;
    final request = fixture.repository.projects();
    final rejected = expectLater(request, throwsStateError);
    fixture.permissions.remove('view:projects');
    pending.complete(const []);

    await rejected;
    expect(fixture.requests, hasLength(1));
  });

  test('owner permission revocation rejects pending customer results', () async {
    final fixture = _Fixture();
    final pending = Completer<List<models.Customer>>();
    fixture.responses['contacts.customers.list'] = pending.future;
    final request = fixture.repository.customers();
    final rejected = expectLater(request, throwsStateError);
    fixture.permissions.remove('view:contacts');
    pending.complete(const []);

    await rejected;
    expect(fixture.requests, hasLength(1));
  });
}

class _Fixture {
  _Fixture() {
    repository = ContactReadRepository(
      contactId: 'contact-one',
      read: read,
      isCurrent: () {
        return current;
      },
      can: permissions.contains,
    );
  }

  final permissions = {'view:contacts', 'view:customers', 'view:projects'};
  final requests = <({String path, Object? input})>[];
  final responses = <String, Object?>{
    'contacts.customers.list': <models.Customer>[],
    'contacts.projects.list': <models.Project>[
      models.Project(
        id: 'project-one',
        title: 'Assigned project',
        createdAt: DateTime.utc(2026, 1, 1),
        modifiedAt: DateTime.utc(2026, 1, 1),
      ),
    ],
  };
  late final ContactReadRepository repository;
  bool current = true;

  Future<O> read<I, O>(RpcQuery<I, O> query, I input) async {
    requests.add((path: query.path, input: query.encodeInput(input)));
    final response = responses[query.path];
    final Object? result;

    if (response is Future<Object?>) {
      result = await response;
    } else {
      result = response;
    }

    return result as O;
  }
}
