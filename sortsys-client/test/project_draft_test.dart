import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as api_models;
import 'package:sortsys_client/features/projects/project_draft.dart';
import 'package:sortsys_client/features/projects/project_receipt.dart';

api_models.Project baseline() {
  return api_models.Project(
    id: 'project-1',
    title: 'Harbor',
    createdAt: DateTime.utc(2026, 1, 1),
    modifiedAt: DateTime.utc(2026, 1, 2),
  );
}

void main() {
  test(
    'create preserves exact entered title and explicit nullable base fields',
    () {
      const draft = ProjectDraft(title: '  Harbor  ');

      expect(draft.createInput().toWire(), {
        'title': '  Harbor  ',
        'address': null,
        'customerId': null,
        'responsibleProjectLeaderUserId': null,
        'orderReceivedAt': null,
      });
    },
  );

  test('blank titles and incomplete enabled addresses fail before a write', () {
    expect(() {
      const ProjectDraft(title: '  ').createInput();
    }, throwsFormatException);
    expect(() {
      const ProjectDraft(title: 'Harbor', useAddress: true).createInput();
    }, throwsFormatException);
  });

  test('title-only edits omit every untouched field and all contacts', () {
    final project = baseline();
    const draft = ProjectDraft(title: 'Harbor crane');

    expect(draft.updateInput(project).toWire(), {
      'id': 'project-1',
      'data': {'title': 'Harbor crane'},
    });
  });

  test('unchanged drafts produce no update fields', () {
    final project = baseline();
    final draft = ProjectDraft.fromProject(project);

    expect(draft.updateInput(project).data.toWire(), isEmpty);
  });

  test('disabled addresses do not send stale hidden address values', () {
    const draft = ProjectDraft(
      title: 'Harbor',
      streetAddress: 'Hidden street',
      city: 'Hidden city',
    );

    expect(draft.createInput().address.value, isNull);
  });

  test('receipt round trips the real generated request and Date value', () {
    final orderDate = DateTime.utc(2026, 10, 11);
    final request = ProjectDraft(
      title: 'Harbor',
      orderReceivedAt: orderDate,
    ).createInput();
    final receipt = ProjectWriteReceipt(
      scope: 'instance/tenant/user',
      nonce: 'local-operation-1',
      createdAt: DateTime.utc(2026, 10, 12),
      createInput: request,
    );

    final restored = ProjectWriteReceipt.decode(receipt.encode());

    expect(restored.scope, receipt.scope);
    expect(restored.createInput!.orderReceivedAt.value, orderDate);
    expect(restored.updateInput, isNull);
    expect(restored.confirmedProjectId, isNull);
  });

  test('receipts reject ambiguous operation kinds', () {
    final receipt = ProjectWriteReceipt(
      scope: 'instance/tenant/user',
      nonce: 'local-operation-1',
      createdAt: DateTime.utc(2026),
    );

    expect(receipt.encode, throwsFormatException);
    expect(() {
      ProjectWriteReceipt.decode('{"json":{"version":2}}');
    }, throwsFormatException);
  });

  test('project recovery comparisons preserve exact field values', () {
    final project = baseline();
    final unchanged = ProjectDraft.fromProject(project).createInput();
    final changed = const ProjectDraft(title: 'Other').createInput();

    expect(projectMatchesInput(project, unchanged), isTrue);
    expect(projectMatchesInput(project, changed), isFalse);
  });
}
