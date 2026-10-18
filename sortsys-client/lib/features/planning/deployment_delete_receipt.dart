import 'dart:convert';

import '../../api/contract.dart' show jsonMap;
import '../../api/generated/models.g.dart' as models;
import '../../api/model.dart';
import '../../api/wire.dart';

const _maximumReceiptBytes = 131072;

final class DeploymentDeleteReceipt {
  const DeploymentDeleteReceipt({
    required this.scope,
    required this.nonce,
    required this.createdAt,
    required this.baseline,
    this.dispatching = false,
    this.acknowledged = false,
  });

  final String scope;
  final String nonce;
  final DateTime createdAt;
  final models.Deployment baseline;
  final bool dispatching;
  final bool acknowledged;

  DeploymentDeleteReceipt started() {
    if (dispatching || acknowledged) {
      throw StateError('INVALID_DEPLOYMENT_DELETE_STAGE');
    }

    return _copy(dispatching: true, acknowledged: false);
  }

  DeploymentDeleteReceipt confirmed() {
    if (!dispatching || acknowledged) {
      throw StateError('INVALID_DEPLOYMENT_DELETE_STAGE');
    }

    return _copy(dispatching: false, acknowledged: true);
  }

  DeploymentDeleteReceipt _copy({
    required bool dispatching,
    required bool acknowledged,
  }) {
    return DeploymentDeleteReceipt(
      scope: scope,
      nonce: nonce,
      createdAt: createdAt,
      baseline: baseline,
      dispatching: dispatching,
      acknowledged: acknowledged,
    );
  }

  String encode() {
    _validate();

    final data = <String, Object?>{
      'version': 1,
      'scope': scope,
      'nonce': nonce,
      'createdAt': createdAt,
      'baseline': encodeRpcValue(baseline),
      'dispatching': dispatching,
      'acknowledged': acknowledged,
    };
    final encoded = jsonEncode(serializeWire(data));

    _checkSize(encoded);

    return encoded;
  }

  factory DeploymentDeleteReceipt.decode(String encoded) {
    _checkSize(encoded);

    final envelope = jsonMap(jsonDecode(encoded));
    final data = readRpcObject(deserializeWire(envelope), const {
      'version',
      'scope',
      'nonce',
      'createdAt',
      'baseline',
      'dispatching',
      'acknowledged',
    });

    if (data.length != 7) {
      throw const FormatException('INVALID_DEPLOYMENT_DELETE_RECEIPT');
    }

    readRpcLiteral(data['version'], 1);

    final receipt = DeploymentDeleteReceipt(
      scope: readRpcString(data['scope']),
      nonce: readRpcString(data['nonce']),
      createdAt: readRpcDate(data['createdAt']),
      baseline: models.Deployment.fromWire(data['baseline']),
      dispatching: readRpcBoolean(data['dispatching']),
      acknowledged: readRpcBoolean(data['acknowledged']),
    );

    receipt._validate();

    return receipt;
  }

  void _validate() {
    if (scope.isEmpty ||
        !RegExp(r'^[0-9a-f]{32}$').hasMatch(nonce) ||
        createdAt.year < 100 ||
        baseline.id.isEmpty ||
        baseline.userId.isEmpty ||
        baseline.projectId.isEmpty ||
        !baseline.from.isBefore(baseline.to) ||
        baseline.from.year < 100 ||
        baseline.to.year < 100 ||
        (dispatching && acknowledged)) {
      throw const FormatException('INVALID_DEPLOYMENT_DELETE_RECEIPT');
    }
  }
}

abstract interface class DeploymentDeleteStore {
  Future<DeploymentDeleteReceipt?> read(String scope);

  Future<void> write(DeploymentDeleteReceipt receipt);

  Future<void> clear(String scope);
}

String deploymentDeleteKey(models.Deployment deployment) {
  final encoded = serializeWire(encodeRpcValue(deployment));

  return jsonEncode(encoded);
}

void _checkSize(String encoded) {
  if (utf8.encode(encoded).length > _maximumReceiptBytes) {
    throw const FormatException('DEPLOYMENT_DELETE_RECEIPT_TOO_LARGE');
  }
}
