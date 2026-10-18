import 'dart:convert';

import '../../api/generated/api.g.dart';
import '../../api/generated/models.g.dart' as models;
import '../../api/model.dart';
import '../../state/session_controller.dart';
import 'absence_write_coordinator.dart';

final class SessionAbsenceAccess implements AbsenceWriteAccess {
  SessionAbsenceAccess(SessionController session, {bool Function()? isActive})
    : this._(session, isActive);

  SessionAbsenceAccess._(this.session, this._isActive)
    : _binding = session.binding,
      scope = jsonEncode([
        session.instance?.origin.toString(),
        session.tenant,
        session.info?.userId,
      ]);

  final SessionController session;
  final bool Function()? _isActive;
  final String _binding;

  @override
  final String scope;

  @override
  void checkCurrent() {
    final active = _isActive?.call() ?? true;

    if (!active ||
        !session.authenticated ||
        session.binding != _binding ||
        session.instance == null) {
      throw StateError('ABSENCE_WRITE_SCOPE_CHANGED');
    }
  }

  @override
  void checkCreate(models.UsersVacationsCreateInput input) {
    checkCurrent();

    final info = session.info!;
    final target = input.userId.valueOrNull ?? info.userId;

    if (target.isEmpty) {
      throw const FormatException('ABSENCE_USER_REQUIRED');
    }

    if (target != info.userId && !info.can('manage:userVacations')) {
      throw StateError('ABSENCE_RECIPIENT_NOT_ALLOWED');
    }
  }

  @override
  Future<models.UsersVacationsCreateResult> createAbsence(
    models.UsersVacationsCreateInput input,
  ) async {
    checkCreate(input);

    final result = await session.write(
      ApiMutations.usersVacationsCreate,
      input,
    );

    checkCurrent();

    if (result.id.isEmpty) {
      throw const FormatException('INVALID_ABSENCE_CREATE_RESULT');
    }

    return result;
  }

  @override
  Future<models.UsersVacationsListResultItem?> getAbsence(
    String id,
    models.UsersVacationsCreateInput target,
  ) async {
    checkCurrent();

    final userId = target.userId.valueOrNull;
    final from = readRpcDate(target.from);
    final to = readRpcDate(target.to);

    if (id.isEmpty || userId == null || userId.isEmpty || from.isAfter(to)) {
      throw const FormatException('INVALID_ABSENCE_READ_WINDOW');
    }

    final input = models.UsersVacationsListInput(
      from: RpcOptional.value(from),
      to: RpcOptional.value(to),
      userId: RpcOptional.value(userId),
      includeDenied: const RpcOptional.value(true),
    );

    // Decisions may change after creation; denied records remain observable.
    final records = await session.read(ApiQueries.usersVacationsList, input);

    checkCurrent();

    models.UsersVacationsListResultItem? match;

    for (final record in records) {
      if (record.id != id) {
        continue;
      }

      if (match != null) {
        throw const FormatException('DUPLICATE_ABSENCE_RESPONSE_ID');
      }

      match = record;
    }

    return match;
  }
}
