import 'package:flutter/widgets.dart';

import '../../api/generated/models.g.dart' as models;

class DeliveryNoteProductResults extends StatefulWidget {
  const DeliveryNoteProductResults({
    super.key,
    required this.futures,
    required this.builder,
  });

  final Map<String, Future<models.Product>> futures;
  final Widget Function(
    BuildContext context,
    Map<String, models.Product> products,
    Set<String> pending,
    bool failed,
  )
  builder;

  @override
  State<DeliveryNoteProductResults> createState() {
    return _DeliveryNoteProductResultsState();
  }
}

class _DeliveryNoteProductResultsState
    extends State<DeliveryNoteProductResults> {
  int _generation = 0;
  Map<String, models.Product> _products = const {};
  Set<String> _pending = const {};
  bool _failed = false;

  @override
  void initState() {
    super.initState();
    _observe();
  }

  @override
  void didUpdateWidget(DeliveryNoteProductResults oldWidget) {
    super.didUpdateWidget(oldWidget);

    if (!identical(oldWidget.futures, widget.futures)) {
      _observe();
    }
  }

  void _observe() {
    final generation = ++_generation;
    _products = {};
    _pending = widget.futures.keys.toSet();
    _failed = false;

    for (final entry in widget.futures.entries) {
      // Subscribe to every future immediately; one pending peer blocks none.
      entry.value.then<void>(
        (product) {
          if (!mounted || generation != _generation) {
            return;
          }

          setState(() {
            _pending.remove(entry.key);

            if (product.id == entry.key) {
              _products[entry.key] = product;
            } else {
              _failed = true;
            }
          });
        },
        onError: (Object error, StackTrace stack) {
          if (!mounted || generation != _generation) {
            return;
          }

          setState(() {
            _pending.remove(entry.key);
            _failed = true;
          });
        },
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    return widget.builder(
      context,
      Map.unmodifiable(_products),
      Set.unmodifiable(_pending),
      _failed,
    );
  }
}
