import 'dart:js_interop';
import 'dart:js_interop_unsafe';

import 'package:web/web.dart' as web;

Future<T> withProjectWriteLock<T>(
  String scope,
  Future<T> Function() operation,
) async {
  final navigator = web.window.navigator;

  if (!web.window.isSecureContext || !navigator.has('locks')) {
    throw StateError('PROJECT_WRITE_LOCK_UNAVAILABLE');
  }

  late T result;
  Object? failure;
  StackTrace? failureStack;

  Future<JSAny?> run(web.Lock? lock) async {
    try {
      if (lock == null) {
        throw StateError('PROJECT_WRITE_BUSY');
      }

      result = await operation();
    } catch (error, stack) {
      failure = error;
      failureStack = stack;
    }

    return null;
  }

  final options = web.LockOptions(mode: 'exclusive', ifAvailable: true);
  final callback = ((web.Lock? lock) {
    return run(lock).toJS;
  }).toJS;

  await navigator.locks
      .request('sortsys.project_write.v1.$scope', options, callback)
      .toDart;

  final error = failure;

  if (error != null) {
    Error.throwWithStackTrace(error, failureStack!);
  }

  return result;
}
