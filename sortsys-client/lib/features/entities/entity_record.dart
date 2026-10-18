import 'package:intl/intl.dart';

import '../../api/generated/models.g.dart' as api_models;
import '../../api/model.dart';
import '../../domain/models.dart' show projectAddress;

sealed class EntityFieldValue {
  const EntityFieldValue();

  String format(DateFormat dates);
}

final class EntityTextValue extends EntityFieldValue {
  const EntityTextValue(this.value);

  final String value;

  @override
  String format(DateFormat dates) {
    return value;
  }
}

final class EntityDateValue extends EntityFieldValue {
  const EntityDateValue(this.value);

  final DateTime value;

  @override
  String format(DateFormat dates) {
    return dates.format(value);
  }
}

final class EntityRecord {
  const EntityRecord({
    required this.resource,
    required this.id,
    required this.title,
    required this.fields,
    this.address,
    this.subtitleParts = const [],
    this.createdAt,
    this.finishedAt,
  });

  final RpcValue resource;
  final String id;
  final String title;
  final Map<String, EntityFieldValue?> fields;
  final String? address;
  final List<String> subtitleParts;
  final DateTime? createdAt;
  final DateTime? finishedAt;

  factory EntityRecord.fromResource(RpcValue resource) {
    switch (resource) {
      case api_models.Project():
        return EntityRecord(
          resource: resource,
          id: resource.id,
          title: _title([resource.title], resource.id),
          address: _address(resource.address),
          createdAt: resource.createdAt,
          finishedAt: resource.finishedAt,
          fields: {
            'createdAt': _date(resource.createdAt),
            'modifiedAt': _date(resource.modifiedAt),
            'finishedAt': _date(resource.finishedAt),
          },
        );
      case api_models.Product():
        final product = [
          resource.brand,
          resource.description,
        ].whereType<String>().join(' ');

        return EntityRecord(
          resource: resource,
          id: resource.id,
          title: _title([resource.name, product], resource.id),
          subtitleParts: ['${resource.customId}'],
          fields: {
            'customId': _text('${resource.customId}'),
            'brand': _text(resource.brand),
            'description': _text(resource.description),
          },
        );
      case api_models.Tool():
        final status = resource.status?.wireValue;
        final subtitle = [
          '${resource.customId}',
          resource.category,
          status,
        ].whereType<String>().toList(growable: false);

        return EntityRecord(
          resource: resource,
          id: resource.id,
          title: _title([resource.label, resource.brand], resource.id),
          subtitleParts: subtitle,
          createdAt: resource.createdAt,
          fields: {
            'customId': _text('${resource.customId}'),
            'category': _text(resource.category),
            'brand': _text(resource.brand),
            'status': _text(status),
            'createdAt': _date(resource.createdAt),
            'modifiedAt': _date(resource.modifiedAt),
          },
        );
      case api_models.User():
        final person = [
          resource.firstName,
          resource.lastName,
        ].whereType<String>().join(' ');

        return EntityRecord(
          resource: resource,
          id: resource.id,
          title: _title([person], resource.username),
          createdAt: resource.createdAt,
          fields: {
            'email': _text(resource.email),
            'phone': _text(resource.phone),
            'username': _text(resource.username),
            'createdAt': _date(resource.createdAt),
            'modifiedAt': _date(resource.modifiedAt),
          },
        );
      case api_models.Customer():
        return EntityRecord(
          resource: resource,
          id: resource.id,
          title: _title([resource.name], resource.id),
          address: _address(resource.address),
          createdAt: resource.createdAt,
          fields: {
            'createdAt': _date(resource.createdAt),
            'modifiedAt': _date(resource.modifiedAt),
          },
        );
      case api_models.Contact():
        final person = [
          resource.firstName,
          resource.lastName,
        ].whereType<String>().join(' ');

        return EntityRecord(
          resource: resource,
          id: resource.id,
          title: _title([person], resource.id),
          address: _address(resource.address),
          createdAt: resource.createdAt,
          fields: {
            'createdAt': _date(resource.createdAt),
            'modifiedAt': _date(resource.modifiedAt),
          },
        );
      case api_models.ProductVendor():
        final description = resource.description ?? '';

        return EntityRecord(
          resource: resource,
          id: resource.id,
          title: _title([resource.name, description], resource.id),
          createdAt: resource.createdAt,
          fields: {
            'description': _text(resource.description),
            'createdAt': _date(resource.createdAt),
            'modifiedAt': _date(resource.modifiedAt),
          },
        );
      case api_models.DeliveryNote():
        return EntityRecord(
          resource: resource,
          id: resource.id,
          title: resource.id,
          createdAt: resource.createdAt,
          fields: {
            'comment': _text(resource.comment),
            'createdAt': _date(resource.createdAt),
          },
        );
      case api_models.RegieReport():
        return EntityRecord(
          resource: resource,
          id: resource.id,
          title: resource.id,
          createdAt: resource.createdAt,
          fields: {'createdAt': _date(resource.createdAt)},
        );
      default:
        throw const FormatException('UNSUPPORTED_ENTITY_RESOURCE');
    }
  }
}

String _title(List<String?> preferred, String fallback) {
  for (final value in preferred) {
    if (value != null && value.isNotEmpty) {
      return value;
    }
  }

  return fallback;
}

String? _address(api_models.ProjectAddress? value) {
  if (value == null) {
    return null;
  }

  return projectAddress(value);
}

EntityTextValue? _text(String? value) {
  if (value == null) {
    return null;
  }

  return EntityTextValue(value);
}

EntityDateValue? _date(DateTime? value) {
  if (value == null) {
    return null;
  }

  return EntityDateValue(value);
}
