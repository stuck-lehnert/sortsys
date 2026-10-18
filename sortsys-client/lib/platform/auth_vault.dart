import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../api/contract.dart';

final class AuthVault {
  static const _key = 'sortsys.active_auth';

  final FlutterSecureStorage _storage = const FlutterSecureStorage(
    iOptions: IOSOptions(
      accessibility: KeychainAccessibility.first_unlock_this_device,
    ),
  );

  Future<void> _pending = Future<void>.value();

  Future<void> _serialize(Future<void> Function() action) {
    final next = _pending.then(
      (_) => action(),
      onError: (Object error, StackTrace stack) => action(),
    );
    _pending = next;

    return next;
  }

  Future<JsonMap?> read() async {
    if (kIsWeb) {
      return null;
    }

    await _pending;
    final value = await _storage.read(key: _key);
    if (value == null) {
      return null;
    }

    final Object? decoded = jsonDecode(value);

    return jsonMap(decoded);
  }

  Future<void> write(JsonMap value) {
    return _serialize(() async {
      if (!kIsWeb) {
        await _storage.write(key: _key, value: jsonEncode(value));
      }
    });
  }

  Future<void> clear() {
    return _serialize(() async {
      if (!kIsWeb) {
        await _storage.delete(key: _key);
      }
    });
  }
}
