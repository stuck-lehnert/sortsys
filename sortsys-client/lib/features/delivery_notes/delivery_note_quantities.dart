import 'package:intl/intl.dart';

import '../../api/generated/models.g.dart' as models;

typedef DeliveryProductQuantity = ({num amount, String unit});

DeliveryProductQuantity upmatchedDeliveryQuantity(
  models.Product? product,
  num baseQuantity,
) {
  if (product == null || baseQuantity == 0 || !baseQuantity.isFinite) {
    return (amount: baseQuantity, unit: product?.baseUnit ?? '');
  }

  final entries = product.otherUnits.values.entries.where((entry) {
    return entry.value.isFinite &&
        entry.value > 0 &&
        entry.value <= baseQuantity;
  }).toList();

  entries.sort((left, right) {
    final comparison = right.value.compareTo(left.value);

    if (comparison != 0) {
      return comparison;
    }

    return left.key.compareTo(right.key);
  });

  for (final entry in entries) {
    final ratio = baseQuantity / entry.value;
    final quarter = (ratio * 4).roundToDouble() / 4;

    if ((ratio - quarter).abs() < 1e-6) {
      return (amount: quarter, unit: entry.key);
    }
  }

  return (amount: baseQuantity, unit: product.baseUnit);
}

DeliveryProductQuantity deliveryQuantityInUnit(
  models.Product product,
  num baseQuantity,
  String? unit,
) {
  if (unit == null || unit.isEmpty) {
    return upmatchedDeliveryQuantity(product, baseQuantity);
  }

  if (unit == product.baseUnit) {
    return (amount: baseQuantity, unit: unit);
  }

  final factor = product.otherUnits.values[unit];

  if (factor == null || factor == 0 || factor.isNaN) {
    return upmatchedDeliveryQuantity(product, baseQuantity);
  }

  return (amount: baseQuantity / factor, unit: unit);
}

String _number(num value, String language) {
  return NumberFormat(
    '#,##0.00##',
    language == 'en' ? 'en_GB' : 'de_DE',
  ).format(value);
}

String formatDeliveryProductAmount(num amount, String unit, String language) {
  final normalized = unit.trim();
  final number = _number(amount, language);

  return normalized.isEmpty ? number : '$number $normalized';
}

String formatDeliveryBaseQuantity(
  num baseQuantity,
  String baseUnit,
  String displayUnit,
  String language,
) {
  final normalizedBase = baseUnit.trim();
  final normalizedDisplay = displayUnit.trim();

  if (normalizedBase == normalizedDisplay) {
    return '-';
  }

  return formatDeliveryProductAmount(baseQuantity, normalizedBase, language);
}

num? deliveryRecordCost(
  models.DeliveryNotesCostsGetOutput? costs,
  String recordId,
) {
  if (costs == null) {
    return null;
  }

  for (final record in costs.records) {
    if (record.recordId != recordId) {
      continue;
    }

    final price = record.priceRecord;

    if (price == null) {
      return null;
    }

    return record.quantity * price.price;
  }

  return null;
}

num? deliveryAverageUnitPrice(
  models.DeliveryNotesCostsGetOutput? costs,
  String recordId,
  num baseQuantity,
) {
  final cost = deliveryRecordCost(costs, recordId);

  // The on-screen Webapp table checks truthiness, not positive quantity.
  if (baseQuantity == 0 || baseQuantity.isNaN || cost == null) {
    return null;
  }

  return cost / baseQuantity;
}
