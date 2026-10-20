import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/features/tools/tool_draft.dart';

void main() {
  test('tool draft requires create number brand and category', () {
    const draft = ToolDraft();

    expect(draft.validate(), {
      'customId': ToolDraftIssue.required,
      'brand': ToolDraftIssue.required,
      'category': ToolDraftIssue.required,
    });
    expect(() {
      draft.createInput();
    }, throwsFormatException);
  });

  test('tool create owns exact canonical fields and nullable costs', () {
    final input = _draft(
      customId: ' 0042 ',
      brand: ' Brand ',
      category: ' Category ',
    ).createInput();

    expect(input.toWire(), {
      'customId': 42,
      'brand': 'Brand',
      'category': 'Category',
      'label': null,
      'purchasePrice': null,
      'usageCostPerDay': null,
    });
    expect(input.status.isAbsent, isTrue);
  });

  test('tool create enforces positive i32 without input truncation', () {
    expect(_draft(customId: '2147483647').createInput().customId, 2147483647);

    for (final value in [
      '0',
      '-1',
      '+1',
      '1.2',
      '1,2',
      '1e2',
      '0x10',
      '2147483648',
    ]) {
      final draft = _draft(customId: value);

      expect(draft.validate()['customId'], ToolDraftIssue.positiveInteger);
      expect(() {
        draft.createInput();
      }, throwsFormatException);
    }
  });

  test('tool costs accept decimal comma and finite nonnegative zero', () {
    for (final (raw, expected) in [
      ('0', 0.0),
      ('0,5', 0.5),
      (' 12.50 ', 12.5),
    ]) {
      final input = _draft(
        purchasePrice: raw,
        usageCostPerDay: raw,
      ).createInput();

      expect(input.purchasePrice.value, expected);
      expect(input.usageCostPerDay.value, expected);
    }

    for (final value in [
      '-1',
      '+1',
      '.5',
      '5.',
      '1e2',
      '1,2,3',
      'NaN',
      'Infinity',
      _repeat('9', 400),
    ]) {
      final draft = _draft(purchasePrice: value, usageCostPerDay: value);

      expect(
        draft.validate()['purchasePrice'],
        ToolDraftIssue.nonnegativeNumber,
      );
      expect(
        draft.validate()['usageCostPerDay'],
        ToolDraftIssue.nonnegativeNumber,
      );
      expect(() {
        draft.createInput();
      }, throwsFormatException);
    }
  });

  test('tool storage trim matches Rust whitespace and preserves BOM', () {
    final whitespace = [
      ...List.generate(5, (index) {
        return 0x0009 + index;
      }),
      0x0020,
      0x0085,
      0x00a0,
      0x1680,
      ...List.generate(11, (index) {
        return 0x2000 + index;
      }),
      0x2028,
      0x2029,
      0x202f,
      0x205f,
      0x3000,
    ];
    final bom = String.fromCharCode(0xfeff);
    final mongolianVowelSeparator = String.fromCharCode(0x180e);

    expect(whitespace.length, 25);

    for (final codeUnit in whitespace) {
      final space = String.fromCharCode(codeUnit);

      expect(normalizeToolText('${space}Brand$space'), 'Brand');
      expect(_draft(brand: '${space}Brand$space').createInput().brand, 'Brand');
    }

    final input = _draft(
      brand: ' $bom Brand $bom ',
      label: ' $bom Model $bom ',
    ).createInput();

    expect(input.brand, '$bom Brand $bom');
    expect(input.label.value, '$bom Model $bom');
    expect(
      normalizeToolText(' $mongolianVowelSeparator '),
      mongolianVowelSeparator,
    );
  });

  test('tool form trim keeps exact JavaScript BOM and NEL semantics', () {
    final bom = String.fromCharCode(0xfeff);
    final nel = String.fromCharCode(0x0085);

    expect(_draft(brand: bom).validate()['brand'], ToolDraftIssue.required);
    expect(_draft(brand: nel).validate()['brand'], ToolDraftIssue.required);
    expect(_draft(customId: '${bom}12$bom').createInput().customId, 12);
    expect(
      _draft(purchasePrice: '${bom}0,5$bom').createInput().purchasePrice.value,
      0.5,
    );
    expect(
      _draft(customId: '${nel}12$nel').validate()['customId'],
      ToolDraftIssue.positiveInteger,
    );
    expect(
      _draft(purchasePrice: '${nel}0,5$nel').validate()['purchasePrice'],
      ToolDraftIssue.nonnegativeNumber,
    );
    expect(_draft(brand: '$nel$bom').createInput().brand, bom);
  });

  test('tool text limits count normalized UTF8 bytes in all text fields', () {
    final valid = _draft(
      brand: '${_repeat('ä', 63)}a',
      category: '${_repeat('😀', 31)}abc',
      label: '${_repeat('ä', 127)}a',
    );
    final invalid = _draft(
      brand: _repeat('ä', 64),
      category: _repeat('😀', 32),
      label: _repeat('ä', 128),
    );

    final input = valid.createInput();

    expect(valid.validate(), isEmpty);
    expect(input.brand, valid.brand);
    expect(input.category, valid.category);
    expect(input.label.value, valid.label);
    expect(invalid.validate(), {
      'brand': ToolDraftIssue.tooLong,
      'category': ToolDraftIssue.tooLong,
      'label': ToolDraftIssue.tooLong,
    });
    expect(() {
      invalid.createInput();
    }, throwsFormatException);
    expect(_draft(brand: ' ${_repeat('a', 127)} ').validate(), isEmpty);
  });

  test('tool text rejects unpaired surrogates before wire encoding', () {
    for (final value in [
      String.fromCharCode(0xd800),
      String.fromCharCode(0xdc00),
      '${String.fromCharCode(0xd800)}x',
    ]) {
      final draft = _draft(brand: value, category: value, label: value);

      expect(draft.validate()['brand'], ToolDraftIssue.invalidText);
      expect(draft.validate()['category'], ToolDraftIssue.invalidText);
      expect(draft.validate()['label'], ToolDraftIssue.invalidText);
      expect(() {
        draft.createInput();
      }, throwsFormatException);
    }
  });

  test(
    'tool draft loads raw model fields and edit status without mutation',
    () {
      final tool = _tool();
      final before = tool.toWire();
      final draft = ToolDraft.fromTool(tool);

      expect(draft.isEditing, isTrue);
      expect(draft.toolId, tool.id);
      expect(draft.customId, '42');
      expect(draft.brand, ' Brand ');
      expect(draft.category, ' Category ');
      expect(draft.label, ' Model ');
      expect(draft.purchasePrice, '0.25');
      expect(draft.usageCostPerDay, '12.5');
      expect(draft.status, models.ToolStatus.lost);
      expect(draft.validate(), isEmpty);
      expect(tool.toWire(), before);
    },
  );

  test('stored tool numbers round trip and reject nonfinite costs', () {
    for (final value in [5e-324, 1e-30, 1e21, 1.7976931348623157e308]) {
      final draft = ToolDraft.fromTool(
        _tool(purchasePrice: value, usageCostPerDay: value),
      );
      final input = draft.updateInput();

      expect(draft.purchasePrice.toLowerCase().contains('e'), isFalse);
      expect(draft.usageCostPerDay.toLowerCase().contains('e'), isFalse);
      expect(input.data.purchasePrice.value, value);
      expect(input.data.usageCostPerDay.value, value);
    }

    for (final value in [
      double.infinity,
      double.negativeInfinity,
      double.nan,
    ]) {
      final draft = ToolDraft.fromTool(
        _tool(purchasePrice: value, usageCostPerDay: value),
      );

      expect(
        draft.validate()['purchasePrice'],
        ToolDraftIssue.nonnegativeNumber,
      );
      expect(
        draft.validate()['usageCostPerDay'],
        ToolDraftIssue.nonnegativeNumber,
      );
      expect(() {
        draft.updateInput();
      }, throwsFormatException);
    }
  });

  test('tool edit owns six fields and explicitly clears nullable values', () {
    final input = _draft(
      toolId: 'known',
      customId: 'ignored edit number',
    ).updateInput();

    expect(input.toWire(), {
      'id': 'known',
      'data': {
        'brand': 'Brand',
        'category': 'Category',
        'label': null,
        'purchasePrice': null,
        'usageCostPerDay': null,
        'status': null,
      },
    });
    expect(
      _draft(
        toolId: 'known',
        status: models.ToolStatus.broken,
      ).updateInput().data.status.value,
      models.ToolStatus.broken,
    );
  });

  test('tool draft guards mode target status and immutable validation', () {
    final emptyTarget = _draft(toolId: '');
    final issues = const ToolDraft().validate();

    expect(() {
      _draft(toolId: 'known').createInput();
    }, throwsStateError);
    expect(() {
      _draft().updateInput();
    }, throwsStateError);
    expect(emptyTarget.validate()['id'], ToolDraftIssue.required);
    expect(() {
      emptyTarget.updateInput();
    }, throwsFormatException);
    expect(
      _draft(status: models.ToolStatus.lost).validate()['status'],
      ToolDraftIssue.invalidContext,
    );
    expect(() {
      _draft(status: models.ToolStatus.lost).createInput();
    }, throwsFormatException);

    expect(() {
      issues.clear();
    }, throwsUnsupportedError);
  });

  test('tool nullable model values load blank and clear in edit payload', () {
    final draft = ToolDraft.fromTool(
      _tool(
        label: null,
        purchasePrice: null,
        usageCostPerDay: null,
        status: null,
      ),
    );
    final input = draft.updateInput();

    expect(draft.label, '');
    expect(draft.purchasePrice, '');
    expect(draft.usageCostPerDay, '');
    expect(draft.status, isNull);
    expect(input.data.label.value, isNull);
    expect(input.data.purchasePrice.value, isNull);
    expect(input.data.usageCostPerDay.value, isNull);
    expect(input.data.status.value, isNull);
  });
}

ToolDraft _draft({
  String? toolId,
  String customId = '1',
  String brand = 'Brand',
  String category = 'Category',
  String label = '',
  String purchasePrice = '',
  String usageCostPerDay = '',
  models.ToolStatus? status,
}) {
  return ToolDraft(
    toolId: toolId,
    customId: customId,
    brand: brand,
    category: category,
    label: label,
    purchasePrice: purchasePrice,
    usageCostPerDay: usageCostPerDay,
    status: status,
  );
}

models.Tool _tool({
  String? label = ' Model ',
  num? purchasePrice = 0.25,
  num? usageCostPerDay = 12.5,
  models.ToolStatus? status = models.ToolStatus.lost,
}) {
  return models.Tool(
    id: 'tool',
    customId: 42,
    brand: ' Brand ',
    category: ' Category ',
    label: label,
    purchasePrice: purchasePrice,
    usageCostPerDay: usageCostPerDay,
    status: status,
    available: true,
    createdByUserId: 'actor',
    createdAt: DateTime.utc(2024),
    modifiedAt: DateTime.utc(2024, 2),
    archivedSince: DateTime.utc(2024, 3),
  );
}

String _repeat(String value, int count) {
  return List.filled(count, value).join();
}
