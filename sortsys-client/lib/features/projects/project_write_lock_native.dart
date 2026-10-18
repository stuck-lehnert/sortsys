final _activeScopes = <String>{};

Future<T> withProjectWriteLock<T>(
  String scope,
  Future<T> Function() operation,
) async {
  if (!_activeScopes.add(scope)) {
    throw StateError('PROJECT_WRITE_BUSY');
  }

  try {
    return await operation();
  } finally {
    _activeScopes.remove(scope);
  }
}
