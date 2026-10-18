import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:provider/provider.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

import '../api/model.dart';
import '../api/wire.dart';
import '../state/session_controller.dart';
import 'text.dart';

class QueryView<T> extends HookWidget {
  const QueryView({
    super.key,
    required this.requestKey,
    required this.identity,
    required this.load,
    required this.builder,
  });

  final String requestKey;
  final Object? identity;
  final Future<T> Function(SessionController) load;
  final Widget Function(BuildContext, T, VoidCallback) builder;

  @override
  Widget build(BuildContext context) {
    final session = context.watch<SessionController>();
    final revision = useState(0);
    final inputKey = jsonEncode(serializeWire(encodeRpcValue(identity)));

    final future = useMemoized(() {
      return load(session);
    }, [session.binding, requestKey, inputKey, revision.value]);
    final result = useFuture(future, preserveState: false);

    void reload() {
      revision.value++;
    }

    if (result.connectionState != ConnectionState.done) {
      return const Center(child: SsSpinner());
    }

    if (result.hasError) {
      return _QueryFailure(error: result.error, onReload: reload);
    }

    // A completed nullable contract result is valid, unlike requireData's guard.
    final data = result.data as T;

    return builder(context, data, reload);
  }
}

class _QueryFailure extends StatelessWidget {
  const _QueryFailure({required this.error, required this.onReload});

  final Object? error;
  final VoidCallback onReload;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(errorText(context, error)),
            const SizedBox(height: 16),
            SsButton(
              kind: SsButtonKind.secondary,
              onPressed: onReload,
              child: Text(text(context, 'Erneut laden', 'Reload')),
            ),
          ],
        ),
      ),
    );
  }
}
