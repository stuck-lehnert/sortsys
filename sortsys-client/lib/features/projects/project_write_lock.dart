import 'project_write_lock_native.dart'
    if (dart.library.js_interop) 'project_write_lock_web.dart'
    as platform;

Future<T> withProjectWriteLock<T>(
  String scope,
  Future<T> Function() operation,
) {
  return platform.withProjectWriteLock(scope, operation);
}
