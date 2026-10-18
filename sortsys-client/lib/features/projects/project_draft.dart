import 'dart:convert';

import '../../api/generated/models.g.dart' as api_models;
import '../../api/model.dart';
import '../../api/wire.dart';

final class ProjectDraft {
  const ProjectDraft({
    required this.title,
    this.useAddress = false,
    this.streetAddress = '',
    this.city = '',
    this.zip = '',
    this.country = '',
    this.customerId,
    this.projectLeaderId,
    this.orderReceivedAt,
  });

  final String title;
  final bool useAddress;
  final String streetAddress;
  final String city;
  final String zip;
  final String country;
  final String? customerId;
  final String? projectLeaderId;
  final DateTime? orderReceivedAt;

  factory ProjectDraft.fromProject(api_models.Project project) {
    final address = project.address;

    return ProjectDraft(
      title: project.title,
      useAddress: address != null,
      streetAddress: address?.streetAddress ?? '',
      city: address?.city ?? '',
      zip: address?.zip.valueOrNull ?? '',
      country: address?.country.valueOrNull ?? '',
      customerId: project.customerId,
      projectLeaderId: project.responsibleProjectLeaderUserId,
      orderReceivedAt: project.orderReceivedAt,
    );
  }

  void validate() {
    if (title.trim().isEmpty) {
      throw const FormatException('PROJECT_TITLE_REQUIRED');
    }

    if (useAddress && (streetAddress.trim().isEmpty || city.trim().isEmpty)) {
      throw const FormatException('PROJECT_ADDRESS_INCOMPLETE');
    }
  }

  api_models.ProjectAddress? _address() {
    if (!useAddress) {
      return null;
    }

    return api_models.ProjectAddress(
      streetAddress: streetAddress,
      city: city,
      zip: RpcOptional.value(zip),
      country: RpcOptional.value(country),
    );
  }

  api_models.ProjectsCreateInput createInput() {
    validate();

    return api_models.ProjectsCreateInput(
      title: title,
      address: RpcOptional.value(_address()),
      customerId: RpcOptional.value(customerId),
      responsibleProjectLeaderUserId: RpcOptional.value(projectLeaderId),
      orderReceivedAt: RpcOptional.value(orderReceivedAt),
    );
  }

  api_models.ProjectsUpdateInput updateInput(api_models.Project baseline) {
    validate();

    final original = ProjectDraft.fromProject(baseline);
    final addressChanged =
        useAddress != original.useAddress ||
        (useAddress &&
            (streetAddress != original.streetAddress ||
                city != original.city ||
                zip != original.zip ||
                country != original.country));

    final data = api_models.ProjectsUpdateRequestData(
      title: title == original.title
          ? const RpcOptional.absent()
          : RpcOptional.value(title),
      address: addressChanged
          ? RpcOptional.value(_address())
          : const RpcOptional.absent(),
      customerId: customerId == original.customerId
          ? const RpcOptional.absent()
          : RpcOptional.value(customerId),
      responsibleProjectLeaderUserId:
          projectLeaderId == original.projectLeaderId
          ? const RpcOptional.absent()
          : RpcOptional.value(projectLeaderId),
      orderReceivedAt: orderReceivedAt == original.orderReceivedAt
          ? const RpcOptional.absent()
          : RpcOptional.value(orderReceivedAt),
    );

    return api_models.ProjectsUpdateInput(id: baseline.id, data: data);
  }
}

String projectValueKey(Object? value) {
  final envelope = serializeWire(encodeRpcValue(value));

  return jsonEncode(_orderedValue(envelope));
}

Object? _orderedValue(Object? value) {
  if (value is Map<String, Object?>) {
    final keys = value.keys.toList()..sort();

    return {for (final key in keys) key: _orderedValue(value[key])};
  }

  if (value is List<Object?>) {
    return value.map(_orderedValue).toList(growable: false);
  }

  return value;
}

bool projectMatchesInput(api_models.Project project, RpcValue input) {
  final actual = project.toWire();
  final requested = input.toWire();

  if (requested is! Map<String, Object?>) {
    throw const FormatException('INVALID_PROJECT_WRITE_INPUT');
  }

  for (final entry in requested.entries) {
    if (projectValueKey(actual[entry.key]) != projectValueKey(entry.value)) {
      return false;
    }
  }

  return true;
}
