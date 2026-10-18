import 'dart:convert';

import '../../api/contract.dart';
import '../../api/generated/models.g.dart' as api_models;
import '../../api/model.dart';
import '../../api/wire.dart';

final class ProjectWriteReceipt {
  const ProjectWriteReceipt({
    required this.scope,
    required this.nonce,
    required this.createdAt,
    this.createInput,
    this.updateInput,
    this.confirmedProjectId,
  });

  final String scope;
  final String nonce;
  final DateTime createdAt;
  final api_models.ProjectsCreateInput? createInput;
  final api_models.ProjectsUpdateInput? updateInput;
  final String? confirmedProjectId;

  ProjectWriteReceipt confirmed(String projectId) {
    return ProjectWriteReceipt(
      scope: scope,
      nonce: nonce,
      createdAt: createdAt,
      createInput: createInput,
      updateInput: updateInput,
      confirmedProjectId: projectId,
    );
  }

  String encode() {
    if ((createInput == null) == (updateInput == null)) {
      throw const FormatException('INVALID_PROJECT_RECEIPT_KIND');
    }

    final data = <String, Object?>{
      'version': 1,
      'scope': scope,
      'nonce': nonce,
      'createdAt': createdAt,
      'kind': createInput != null ? 'create' : 'update',
      'input': encodeRpcValue(createInput ?? updateInput),
      'confirmedProjectId': confirmedProjectId,
    };
    final encoded = jsonEncode(serializeWire(data));

    if (utf8.encode(encoded).length > 131072) {
      throw const FormatException('PROJECT_RECEIPT_TOO_LARGE');
    }

    return encoded;
  }

  factory ProjectWriteReceipt.decode(String encoded) {
    if (utf8.encode(encoded).length > 131072) {
      throw const FormatException('PROJECT_RECEIPT_TOO_LARGE');
    }

    final envelope = jsonMap(jsonDecode(encoded));
    final data = readRpcObject(deserializeWire(envelope), const {
      'version',
      'scope',
      'nonce',
      'createdAt',
      'kind',
      'input',
      'confirmedProjectId',
    });

    readRpcLiteral(data['version'], 1);
    final scope = readRpcString(data['scope']);
    final nonce = readRpcString(data['nonce']);
    final created = readRpcDate(data['createdAt']);
    final kind = readRpcString(data['kind']);
    final confirmed = readRpcNullable(
      data['confirmedProjectId'],
      readRpcString,
    );

    if (scope.isEmpty ||
        nonce.isEmpty ||
        (kind != 'create' && kind != 'update')) {
      throw const FormatException('INVALID_PROJECT_RECEIPT');
    }

    return ProjectWriteReceipt(
      scope: scope,
      nonce: nonce,
      createdAt: created,
      createInput: kind == 'create'
          ? api_models.ProjectsCreateInput.fromWire(data['input'])
          : null,
      updateInput: kind == 'update'
          ? api_models.ProjectsUpdateInput.fromWire(data['input'])
          : null,
      confirmedProjectId: confirmed,
    );
  }
}

abstract interface class ProjectReceiptStore {
  Future<ProjectWriteReceipt?> read(String scope);

  Future<void> write(ProjectWriteReceipt receipt);

  Future<void> clear(String scope);
}
