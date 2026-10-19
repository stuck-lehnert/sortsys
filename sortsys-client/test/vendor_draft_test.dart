import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/api/model.dart';
import 'package:sortsys_client/features/vendors/vendor_draft.dart';

void main() {
  test('vendor create matches canonical trimmed fields and explicit null description', () {
    const draft = VendorDraft(
      name: '  Vendor Alpha  ',
      description: RpcOptional.value('  supplier note  '),
    );

    expect(draft.validate(), isEmpty);
    expect(draft.createInput().toWire(), {
      'name': 'Vendor Alpha',
      'description': 'supplier note',
    });
    expect(const VendorDraft(name: 'Vendor').createInput().toWire(), {
      'name': 'Vendor',
      'description': null,
    });
  });

  test(
    'vendor form normalizes absent undefined null blank and padded description',
    () {
      const descriptions = <RpcOptional<String?>>[
        RpcOptional.absent(),
        RpcOptional.undefined(),
        RpcOptional.value(null),
        RpcOptional.value(''),
        RpcOptional.value('  note  '),
      ];

      for (final description in descriptions) {
        final draft = VendorDraft(name: 'Vendor', description: description);
        final input = draft.createInput();

        final value = description.valueOrNull?.trim();

        expect(input.description.hasValue, isTrue);
        expect(
          input.description.valueOrNull,
          value == null || value.isEmpty ? null : value,
        );
        expect(input.toWire().containsKey('description'), isTrue);
      }
    },
  );

  test('vendor edit uses known ID and original nullable description', () {
    final vendor = models.ProductVendor(
      id: 'vendor/one',
      name: '  Original vendor  ',
      createdAt: DateTime.utc(2024),
      modifiedAt: DateTime.utc(2024, 2),
    );
    final draft = VendorDraft.fromVendor(vendor);

    expect(draft.updateInput().toWire(), {
      'id': 'vendor/one',
      'data': {'name': 'Original vendor', 'description': null},
    });
    expect(draft.createInput, throwsFormatException);
    expect(
      const VendorDraft(name: 'New vendor').updateInput,
      throwsFormatException,
    );
    expect(const VendorDraft(name: 'Vendor', vendorId: '').validate(), {
      'id': VendorDraftIssue.required,
    });
  });

  test(
    'vendor validation uses trimmed UTF-8 byte limits without truncation',
    () {
      final name = '${List.filled(63, 'é').join()}a';
      final description = '${List.filled(127, 'é').join()}a';
      final draft = VendorDraft(
        name: '  $name  ',
        description: RpcOptional.value('  $description  '),
      );

      expect(draft.validate(), isEmpty);
      expect(draft.createInput().name, name);
      expect(draft.createInput().description.valueOrNull, description);
      expect(
        VendorDraft(
          name: '${name}b',
          description: RpcOptional.value('${description}b'),
        ).validate(),
        {
          'name': VendorDraftIssue.tooLong,
          'description': VendorDraftIssue.tooLong,
        },
      );
      expect(const VendorDraft(name: ' \t\n ').validate(), {
        'name': VendorDraftIssue.required,
      });
    },
  );

  test(
    'vendor invalid drafts cannot produce payloads and issues are immutable',
    () {
      const draft = VendorDraft(name: '', vendorId: '');
      final issues = draft.validate();

      expect(draft.createInput, throwsFormatException);
      expect(draft.updateInput, throwsFormatException);
      expect(() {
        issues['description'] = VendorDraftIssue.tooLong;
      }, throwsUnsupportedError);
    },
  );
}
