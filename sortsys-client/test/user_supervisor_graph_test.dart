import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/features/users/user_supervisor_graph.dart';

void main() {
  test('supervisor graph preserves roots, sibling order and stable ties', () {
    final source = [
      _user('child-b', 'Ben', supervisor: 'root'),
      _user('root', 'Zoe'),
      _user('orphan', 'Ada', supervisor: 'missing'),
      _user('child-a', 'Amy', supervisor: 'root'),
      _user('tie-first', 'Same', supervisor: 'root'),
      _user('tie-second', 'Same', supervisor: 'root'),
    ];
    final originalIds = _ids(source);

    final graph = UserSupervisorGraph(source, compareNames: _compare);

    expect(_ids(graph.roots), ['orphan', 'root']);
    expect(_ids(graph.children['root']!), [
      'child-a',
      'child-b',
      'tie-first',
      'tie-second',
    ]);
    expect(graph.cycleRoots, isEmpty);
    expect(graph.expandableIds, {'root'});
    expect(_ids(source), originalIds);
  });

  test('supervisor graph uses supplied full-name comparator', () {
    final observed = <String>[];
    final source = [
      _user('first', 'First', lastName: 'One'),
      _user('second', 'Second', lastName: 'Two'),
    ];

    final graph = UserSupervisorGraph(
      source,
      compareNames: (left, right) {
        observed.addAll([left, right]);

        return right.compareTo(left);
      },
    );

    expect(_ids(graph.users), ['second', 'first']);
    expect(observed.toSet(), {'First One', 'Second Two'});
  });

  test('supervisor cycles retain every unreachable root and stop per path', () {
    final graph = UserSupervisorGraph([
      _user('a', 'A', supervisor: 'b'),
      _user('b', 'B', supervisor: 'a'),
      _user('c', 'C', supervisor: 'b'),
      _user('root', 'Root', supervisor: 'missing'),
      _user('self', 'Self', supervisor: 'self'),
    ], compareNames: _compare);

    final rows = graph.visibleRows(
      graph.defaultSupervisor('a')!,
      graph.expandableIds,
    );
    final selfRows = graph.visibleRows(
      graph.defaultSupervisor('self')!,
      graph.expandableIds,
    );

    expect(_ids(graph.roots), ['root']);
    expect(_ids(graph.cycleRoots), ['a', 'b', 'c', 'self']);
    expect(_rowIds(rows), ['a', 'b', 'a', 'c']);
    expect([for (final row in rows) row.depth], [0, 1, 2, 2]);
    expect([for (final row in rows) row.cycle], [false, false, true, false]);
    expect(_rowIds(selfRows), ['self', 'self']);
    expect(selfRows.last.cycle, isTrue);
  });

  test(
    'supervisor expansion and snapshots retain immutable graph ownership',
    () {
      final source = [
        _user('root', 'A'),
        _user('child', 'B', supervisor: 'root'),
        _user('grandchild', 'C', supervisor: 'child'),
      ];
      final graph = UserSupervisorGraph(source, compareNames: _compare);
      final selected = <String>{'unrelated'};

      source.clear();

      final expanded = graph.toggleAll(selected);
      final root = graph.roots.single;
      final collapsedRows = graph.visibleRows(root, {});
      final expandedRows = graph.visibleRows(root, expanded);

      expect(selected, {'unrelated'});
      expect(expanded, {'root', 'child'});
      expect(graph.allExpanded(expanded), isTrue);
      expect(graph.toggleAll(expanded), isEmpty);
      expect(_rowIds(collapsedRows), ['root']);
      expect(_rowIds(expandedRows), ['root', 'child', 'grandchild']);
      expect(graph.defaultSupervisor('foreign'), isNull);
      expect(graph.defaultSupervisor(null), isNull);
      expect(graph.defaultSupervisor('child')?.firstName, 'B');
      expect(() => graph.users.clear(), throwsUnsupportedError);
      expect(() => graph.roots.clear(), throwsUnsupportedError);
      expect(() => graph.children.clear(), throwsUnsupportedError);
      expect(() => graph.children['root']!.clear(), throwsUnsupportedError);
      expect(() => graph.expandableIds.clear(), throwsUnsupportedError);
      expect(() => expandedRows.clear(), throwsUnsupportedError);
    },
  );

  test(
    'supervisor graph rejects ambiguous identities and handles deep chains',
    () {
      for (final invalid in [
        [_user('', 'Empty')],
        [_user('same', 'First'), _user('same', 'Second')],
      ]) {
        expect(
          () => UserSupervisorGraph(invalid, compareNames: _compare),
          throwsFormatException,
        );
      }

      final empty = UserSupervisorGraph([], compareNames: _compare);
      final chain = UserSupervisorGraph([
        for (var index = 0; index < 128; index++)
          _user(
            '$index',
            '$index',
            supervisor: index == 0 ? null : '${index - 1}',
          ),
      ], compareNames: _compare);
      final rows = chain.visibleRows(chain.roots.single, chain.expandableIds);

      expect(empty.allExpanded({}), isFalse);
      expect(empty.toggleAll({}), isEmpty);
      expect(empty.defaultSupervisor('missing'), isNull);
      expect(chain.cycleRoots, isEmpty);
      expect(rows, hasLength(128));
      expect(rows.last.depth, 127);
      expect(rows.last.user.id, '127');
      expect(rows.last.cycle, isFalse);
    },
  );
}

int _compare(String left, String right) {
  return left.compareTo(right);
}

List<String> _ids(Iterable<models.User> users) {
  return [for (final user in users) user.id];
}

List<String> _rowIds(Iterable<UserSupervisorRow> rows) {
  return [for (final row in rows) row.user.id];
}

models.User _user(
  String id,
  String firstName, {
  String? lastName,
  String? supervisor,
}) {
  return models.User(
    id: id,
    firstName: firstName,
    lastName: lastName,
    username: id,
    contractType: models.UserContractType.internal,
    supervisorUserId: supervisor,
    createdAt: DateTime.utc(2024),
    modifiedAt: DateTime.utc(2024),
  );
}
