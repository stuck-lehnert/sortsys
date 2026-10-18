import '../api/contract.dart';
import '../api/generated/models.g.dart' as api_models;

String requiredString(JsonMap data, String key) {
  final value = data[key];

  if (value is! String) {
    throw FormatException('INVALID_$key');
  }

  return value;
}

String? optionalString(JsonMap data, String key) {
  final value = data[key];

  if (value == null || value is RpcUndefined) {
    return null;
  }

  if (value is! String) {
    throw FormatException('INVALID_$key');
  }

  return value;
}

DateTime requiredDate(JsonMap data, String key) {
  final value = data[key];

  if (value is! DateTime) {
    throw FormatException('INVALID_$key');
  }

  return value;
}

List<JsonMap> recordList(Object? value) {
  if (value is! List<Object?>) {
    throw const FormatException('INVALID_RECORD_LIST');
  }

  return value.map(jsonMap).toList(growable: false);
}

final class SessionInfo {
  SessionInfo(this.record);

  SessionInfo.fromWire(Object? value)
    : record = api_models.SessionInfo.fromWire(value);

  final api_models.SessionInfo record;
  late final Set<String> roles = record.roles
      .map((role) => role.wireValue)
      .toSet();

  api_models.SessionInfo get data => record;
  api_models.SessionInfoUser get user => record.user;
  api_models.SessionInfoTenant get tenant => record.tenant;
  api_models.SessionInfoSession get session => record.session;

  String get userId => user.id;
  String get sessionId => session.id;
  String get locale => user.locale.wireValue == 'en' ? 'en' : 'de';
  bool get supportsFiles => tenant.objectStorageEnabled;

  String get displayName {
    final names = [user.firstName, user.lastName];

    return names.whereType<String>().where((name) => name.isNotEmpty).join(' ');
  }

  bool can(String role) {
    final explicitlyGranted = roles.contains(':admin') || roles.contains(role);
    final manageableView =
        role.startsWith('view:') &&
        roles.contains('manage:${role.substring(5)}');

    return explicitlyGranted || manageableView;
  }
}

String projectAddress(api_models.ProjectAddress? address) {
  if (address == null) {
    return '';
  }

  final locality = [
    address.zip.valueOrNull,
    address.city,
  ].whereType<String>().join(' ');
  final parts = [address.streetAddress, locality, address.country.valueOrNull];

  return parts.whereType<String>().where((part) => part.isNotEmpty).join(', ');
}

final class Project {
  Project(this.record);

  Project.fromWire(Object? value) : record = api_models.Project.fromWire(value);

  final api_models.Project record;

  api_models.Project get data => record;
  String get id => record.id;
  String get title => record.title;
  bool get finished => record.finishedAt != null;
  String get address => projectAddress(record.address);
}

final class Deployment {
  Deployment(this.record);

  Deployment.fromWire(Object? value)
    : record = api_models.Deployment.fromWire(value);

  final api_models.Deployment record;

  api_models.Deployment get data => record;
  String get id => record.id;
  String get userId => record.userId;
  String get projectId => record.projectId;
  DateTime get from => record.from.toLocal();
  DateTime get to => record.to.toLocal();
  String? get note => record.note;
}
