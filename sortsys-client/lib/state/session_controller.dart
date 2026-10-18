import 'dart:async';

import 'package:flutter/foundation.dart';

import '../api/client.dart';
import '../api/contract.dart';
import '../api/generated/api.g.dart';
import '../api/generated/models.g.dart' as api_models;
import '../api/procedure.dart';
import '../api/typed_client.dart';
import '../domain/instance.dart';
import '../domain/models.dart';
import '../platform/auth_vault.dart';

final class SessionController extends ChangeNotifier {
  SessionController({AuthVault? vault}) : _vault = vault ?? AuthVault();

  final AuthVault _vault;

  SessionApi? _api;
  SessionInfo? info;
  SortsysInstance? instance;
  String? tenant;
  Object? error;
  bool busy = false;

  bool _disposed = false;
  int _epoch = 0;

  bool get authenticated => info != null && _api != null;

  String get binding {
    return '${instance?.origin}|$tenant|'
        '${info?.userId}|${info?.sessionId}|$_epoch';
  }

  void _notify() {
    if (!_disposed) {
      notifyListeners();
    }
  }

  void _check(int epoch) {
    if (_disposed || epoch != _epoch) {
      throw StateError('DISPOSED_SESSION');
    }
  }

  SessionApi _client(SortsysInstance value, int epoch) {
    return RpcClient(
      value,
      onUnauthorized: () {
        if (!_disposed && _epoch == epoch) {
          unawaited(logout(notifyServer: false));
        }
      },
    );
  }

  Future<void> restore() async {
    final epoch = ++_epoch;
    SessionApi? candidate;

    busy = true;
    error = null;
    _notify();

    try {
      final saved = await _vault.read();
      _check(epoch);
      if (saved == null) {
        return;
      }

      final origin = SortsysInstance.parse(requiredString(saved, 'origin'));
      candidate = _client(origin, epoch);
      candidate.setToken(requiredString(saved, 'token'));

      final result = await candidate.read(
        ApiQueries.authSessionInfo,
        rpcUndefined,
      );
      final session = SessionInfo(result);
      _check(epoch);

      if (session.userId != requiredString(saved, 'userId')) {
        throw StateError('AUTH_SCOPE_MISMATCH');
      }

      instance = origin;
      tenant = requiredString(saved, 'tenant');
      info = session;
      _api = candidate;
      candidate = null;
    } catch (value) {
      if (!_disposed && epoch == _epoch) {
        error = value;
        await _vault.clear();
      }
    } finally {
      candidate?.close();
      _finish(epoch);
    }
  }

  Future<void> login(String domain, String account, String password) async {
    if (busy) {
      return;
    }

    final epoch = ++_epoch;
    SessionApi? candidate;

    busy = true;
    error = null;
    _api?.close();
    _api = null;
    info = null;
    _notify();

    try {
      final origin = SortsysInstance.parse(domain);
      final parts = _validateAccount(account, password);
      candidate = _client(origin, epoch);

      final request = api_models.AuthLoginInput(
        tenant: parts[1],
        username: parts[0],
        password: password,
      );

      final result = await candidate.write(ApiMutations.authLogin, request);
      _check(epoch);

      final token = result.token;
      if (token.isEmpty) {
        throw const FormatException('INVALID_TOKEN');
      }

      candidate.setToken(token);
      final sessionResult = await candidate.read(
        ApiQueries.authSessionInfo,
        rpcUndefined,
      );
      final session = SessionInfo(sessionResult);
      _check(epoch);

      await _vault.write({
        'origin': origin.origin.toString(),
        'tenant': parts[1],
        'userId': session.userId,
        'token': token,
      });
      _check(epoch);

      instance = origin;
      tenant = parts[1];
      info = session;
      _api = candidate;
      candidate = null;
    } catch (value) {
      if (!_disposed && epoch == _epoch) {
        error = value;
      }
    } finally {
      candidate?.close();
      _finish(epoch);
    }
  }

  List<String> _validateAccount(String account, String password) {
    final parts = account.trim().split('@');
    final allowedPart = RegExp(r'^[a-zA-Z0-9_.-]+$');
    final valid =
        parts.length == 2 &&
        allowedPart.hasMatch(parts[0]) &&
        allowedPart.hasMatch(parts[1]) &&
        password.isNotEmpty;

    if (!valid) {
      throw const FormatException('INVALID_ACCOUNT');
    }

    return parts;
  }

  void _finish(int epoch) {
    if (!_disposed && epoch == _epoch) {
      busy = false;
      _notify();
    }
  }

  Future<Object?> query(String path, [Object? input = rpcUndefined]) async {
    final api = _api;
    final epoch = _epoch;
    if (api == null || info == null) {
      throw StateError('NO_SESSION');
    }

    final value = await api.query(path, input);
    _check(epoch);

    return value;
  }

  Future<O> read<I, O>(RpcQuery<I, O> procedure, I input) async {
    final request = procedure.encodeInput(input);

    final response = await query(procedure.path, request);

    return procedure.decodeOutput(response);
  }

  Future<O> write<I, O>(
    RpcMutation<I, O> procedure,
    I input, {
    Duration timeout = const Duration(seconds: 20),
  }) async {
    final api = _api;
    final epoch = _epoch;

    if (api == null || info == null) {
      throw StateError('NO_SESSION');
    }

    final response = await api.write(procedure, input, timeout: timeout);
    _check(epoch);

    return response;
  }

  Future<void> logout({bool notifyServer = true}) async {
    final previous = _api;

    ++_epoch;
    _api = null;
    info = null;
    error = null;
    busy = false;
    _notify();

    try {
      if (notifyServer && previous != null) {
        try {
          await previous.write(ApiMutations.authLogout, rpcUndefined);
        } catch (_) {
          // Local access remains closed if remote logout fails.
        }
      }
    } finally {
      previous?.close();
      await _vault.clear();
      _notify();
    }
  }

  @override
  void dispose() {
    _disposed = true;
    ++_epoch;

    _api?.close();
    _api = null;
    info = null;

    super.dispose();
  }
}
