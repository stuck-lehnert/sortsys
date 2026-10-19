import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/features/delivery_notes/delivery_note_product_results.dart';

void main() {
  testWidgets('product peers complete independently with immutable views', (
    tester,
  ) async {
    final first = Completer<models.Product>();
    final second = Completer<models.Product>();
    Map<String, models.Product> products = const {};
    Set<String> pending = const {};

    await _pump(tester, {'first': first.future, 'second': second.future}, (
      values,
      waiting,
      failed,
    ) {
      products = values;
      pending = waiting;

      expect(failed, isFalse);
    });

    expect(pending, {'first', 'second'});
    expect(() => products.clear(), throwsUnsupportedError);
    expect(() => pending.clear(), throwsUnsupportedError);
    second.complete(_product('second'));
    await tester.pumpAndSettle();

    expect(products.keys, ['second']);
    expect(pending, {'first'});
    first.complete(_product('first'));
    await tester.pumpAndSettle();

    expect(products.keys, ['second', 'first']);
    expect(pending, isEmpty);
    expect(tester.takeException(), isNull);
  });

  testWidgets('product errors and wrong IDs retain successful peers', (
    tester,
  ) async {
    final error = Completer<models.Product>();
    final wrong = Completer<models.Product>();
    final good = Completer<models.Product>();
    Map<String, models.Product> products = const {};
    Set<String> pending = const {};
    var failed = false;

    await _pump(
      tester,
      {'error': error.future, 'wrong': wrong.future, 'good': good.future},
      (values, waiting, hasError) {
        products = values;
        pending = waiting;
        failed = hasError;
      },
    );
    error.completeError(StateError('read failed'));
    wrong.complete(_product('other'));
    good.complete(_product('good'));
    await tester.pumpAndSettle();

    expect(products.keys, ['good']);
    expect(pending, isEmpty);
    expect(failed, isTrue);
    expect(tester.takeException(), isNull);
  });

  testWidgets('product replacement ignores old success and failure', (
    tester,
  ) async {
    final old = Completer<models.Product>();
    final oldFailure = Completer<models.Product>();
    final current = Completer<models.Product>();
    Map<String, models.Product> products = const {};
    Set<String> pending = const {};
    var failed = false;

    void observe(
      Map<String, models.Product> values,
      Set<String> waiting,
      bool hasError,
    ) {
      products = values;
      pending = waiting;
      failed = hasError;
    }

    await _pump(tester, {
      'same': old.future,
      'old-error': oldFailure.future,
    }, observe);
    await _pump(tester, {'same': current.future}, observe);
    old.complete(_product('same', name: 'old'));
    oldFailure.completeError(StateError('obsolete failure'));
    await tester.pumpAndSettle();

    expect(products, isEmpty);
    expect(pending, {'same'});
    expect(failed, isFalse);
    current.complete(_product('same', name: 'current'));
    await tester.pumpAndSettle();

    expect(products['same']?.name, 'current');
    expect(pending, isEmpty);
    expect(failed, isFalse);
    expect(tester.takeException(), isNull);
  });

  testWidgets('disposed product results consume late failures safely', (
    tester,
  ) async {
    final late = Completer<models.Product>();
    await _pump(tester, {'late': late.future}, (products, pending, failed) {});
    await tester.pumpWidget(const SizedBox.shrink());
    late.completeError(StateError('late failure'));
    await tester.pumpAndSettle();

    expect(tester.takeException(), isNull);
  });
}

Future<void> _pump(
  WidgetTester tester,
  Map<String, Future<models.Product>> futures,
  void Function(Map<String, models.Product>, Set<String>, bool) observe,
) async {
  await tester.pumpWidget(
    Directionality(
      textDirection: TextDirection.ltr,
      child: DeliveryNoteProductResults(
        futures: futures,
        builder: (context, products, pending, failed) {
          observe(products, pending, failed);

          return Text(products.keys.join(','));
        },
      ),
    ),
  );
}

models.Product _product(String id, {String name = 'Product'}) {
  return models.Product(
    id: id,
    customId: 0,
    name: name,
    baseUnit: 'kg',
    otherUnits: models.ApplyPriceImportRowOtherUnits(const {}),
    categories: const [],
  );
}
