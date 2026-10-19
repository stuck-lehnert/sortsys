import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/features/tools/tool_list_filter.dart';

void main() {
  test('default tool filters match the canonical nullable request', () {
    final filter = ToolListFilter.fromUri(Uri.parse('/tools'));

    expect(filter.input('').toWire(), {
      'status': null,
      'brand': null,
      'category': null,
    });
    expect(filter.archivedOnly, isFalse);
  });

  test('all canonical statuses use the generated wire values', () {
    for (final status in models.ToolsListRequestStatus.values) {
      final filter = ToolListFilter.fromUri(
        Uri.parse('/tools?status=${status.wireValue}'),
      );

      expect(filter.status, status);
      expect(filter.input('').toWire()['status'], status.wireValue);
    }
  });

  test('URL filters preserve the first value and exact decoded strings', () {
    final filter = ToolListFilter.fromUri(
      Uri.parse(
        '/tools?status=lost&status=available'
        '&brand=%20A%26B%2B%20&brand=ignored'
        '&category=S%C3%A4gen%2FBohrer&category=ignored'
        '&other=one&other=two#details',
      ),
    );

    expect(filter.input('').toWire(), {
      'status': 'lost',
      'brand': ' A&B+ ',
      'category': 'Sägen/Bohrer',
    });
  });

  test('invalid status is ignored without normalizing empty filters', () {
    final filter = ToolListFilter.fromUri(
      Uri.parse('/tools?status=AVAILABLE&status=lost&brand=&category='),
    );

    expect(filter.input('').toWire(), {
      'status': null,
      'brand': '',
      'category': '',
    });
  });

  test('archive mode accepts only the canonical first yes value', () {
    for (final value in ['', 'true', '1', 'YES', 'no', 'yes%20']) {
      final filter = ToolListFilter.fromUri(
        Uri.parse('/tools?archived=$value'),
      );

      expect(filter.archivedOnly, isFalse, reason: value);
    }

    expect(
      ToolListFilter.fromUri(
        Uri.parse('/tools?archived=yes&archived=no'),
      ).archivedOnly,
      isTrue,
    );
    expect(
      ToolListFilter.fromUri(
        Uri.parse('/tools?archived=no&archived=yes'),
      ).archivedOnly,
      isFalse,
    );
  });

  test('archive partition preserves response order and source rows', () {
    final tools = [
      _tool('active-b', 3),
      _tool('archived', 1, archivedSince: DateTime.utc(2026, 1, 1)),
      _tool('active-a', 2),
    ];
    final originalRows = tools.map((tool) => tool.toWire()).toList();
    final active = const ToolListFilter().visibleRows(tools);
    final archived = const ToolListFilter(
      archivedOnly: true,
    ).visibleRows(tools);

    expect(active.map((tool) => tool.id), ['active-b', 'active-a']);
    expect(archived.map((tool) => tool.id), ['archived']);
    expect(tools.map((tool) => tool.toWire()).toList(), originalRows);
    expect(active.first, same(tools.first));
    expect(archived.single, same(tools[1]));
    expect(const ToolListFilter().visibleRows(const []), isEmpty);
  });

  test('existing search stays exact and is absent only when empty', () {
    const filter = ToolListFilter(brand: 'A&B');

    expect(filter.input('').toWire().containsKey('search'), isFalse);
    expect(filter.input(' Bohrer + ').toWire(), {
      'search': ' Bohrer + ',
      'status': null,
      'brand': 'A&B',
      'category': null,
    });
  });
}

models.Tool _tool(String id, num customId, {DateTime? archivedSince}) {
  return models.Tool(
    id: id,
    customId: customId,
    brand: 'Makita',
    category: 'Bohrer',
    available: true,
    createdAt: DateTime.utc(2026, 1, 1),
    modifiedAt: DateTime.utc(2026, 1, 1),
    archivedSince: archivedSince,
  );
}
