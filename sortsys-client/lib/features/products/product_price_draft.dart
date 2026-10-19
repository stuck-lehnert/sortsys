import 'dart:convert';

import '../../api/generated/models.g.dart' as models;
import '../../api/model.dart';

enum ProductPriceDraftIssue {
  required,
  number,
  nonnegativeNumber,
  unit,
  finitePrice,
  tooLong,
}

final class ProductPriceDraft {
  ProductPriceDraft({
    required models.Product product,
    this.totalPrice = '',
    this.amount = '',
    String? unit,
    this.date,
    this.comment = '',
    this.isRealPurchase = false,
  }) : productId = product.id,
       baseUnit = product.baseUnit,
       otherUnits = Map.unmodifiable(product.otherUnits.values),
       unit = unit ?? product.baseUnit;

  final String productId;
  final String baseUnit;
  final Map<String, num> otherUnits;
  final String totalPrice;
  final String amount;
  final String unit;
  final DateTime? date;
  final String comment;
  final bool isRealPurchase;

  List<String> get units {
    return List.unmodifiable([baseUnit, ...otherUnits.keys]);
  }

  num? get _factor {
    return unit == baseUnit ? 1 : otherUnits[unit];
  }

  num? get pricePerBaseUnit {
    final price = _number(totalPrice);
    final quantity = _number(amount);
    final factor = _factor;

    if (price == null || quantity == null || factor == null || !factor.isFinite) {
      return null;
    }

    final converted = price / (quantity * factor);

    return converted.isFinite ? converted : null;
  }

  Map<String, ProductPriceDraftIssue> validate() {
    final issues = <String, ProductPriceDraftIssue>{};
    final price = _number(totalPrice);
    final quantity = _number(amount);
    final factor = _factor;

    if (productId.isEmpty) {
      issues['product'] = ProductPriceDraftIssue.required;
    }

    if (totalPrice.trim().isEmpty) {
      issues['price'] = ProductPriceDraftIssue.required;
    } else if (price == null) {
      issues['price'] = ProductPriceDraftIssue.number;
    }

    if (amount.trim().isEmpty) {
      issues['amount'] = ProductPriceDraftIssue.required;
    } else if (quantity == null || quantity < 0) {
      issues['amount'] = ProductPriceDraftIssue.nonnegativeNumber;
    }

    if (factor == null || !factor.isFinite) {
      issues['unit'] = ProductPriceDraftIssue.unit;
    } else if (price != null &&
        quantity != null &&
        quantity >= 0 &&
        pricePerBaseUnit == null) {
      issues['price'] = ProductPriceDraftIssue.finitePrice;
    }

    if (date == null) {
      issues['date'] = ProductPriceDraftIssue.required;
    }

    if (utf8.encode(comment.trim()).length > 255) {
      issues['comment'] = ProductPriceDraftIssue.tooLong;
    }

    return Map.unmodifiable(issues);
  }

  models.ProductsPriceRecordsCreateInput createInput() {
    if (validate().isNotEmpty) {
      throw StateError('INVALID_PRODUCT_PRICE_DRAFT');
    }

    final localDate = date!.toLocal();

    // The canonical form submits local start-of-day and the raw comment.
    // Its vendor picker is not included in the mutation payload.
    return models.ProductsPriceRecordsCreateInput(
      productId: productId,
      pricePerBaseUnit: pricePerBaseUnit!,
      timestamp: DateTime(localDate.year, localDate.month, localDate.day),
      isRealPurchase: isRealPurchase,
      comment: RpcOptional.value(comment),
    );
  }
}

num? _number(String source) {
  final value = source.trim();

  if (!RegExp(r'^-?[0-9]+([,.][0-9]+)?$').hasMatch(value)) {
    return null;
  }

  final parsed = double.tryParse(value.replaceFirst(',', '.'));

  return parsed != null && parsed.isFinite ? parsed : null;
}
