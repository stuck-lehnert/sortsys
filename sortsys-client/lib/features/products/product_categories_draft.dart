import 'dart:convert';

import '../../api/generated/models.g.dart' as models;

enum ProductCategoriesDraftIssue { required, tooLong, invalidUnicode }

final class ProductCategoriesDraft {
  ProductCategoriesDraft({
    required this.productId,
    List<String> categories = const [],
  }) : categories = List.unmodifiable(categories);

  factory ProductCategoriesDraft.fromProduct(models.Product product) {
    return ProductCategoriesDraft(
      productId: product.id,
      categories: product.categories,
    );
  }

  final String productId;
  final List<String> categories;

  Map<String, ProductCategoriesDraftIssue> validate() {
    final issues = <String, ProductCategoriesDraftIssue>{};

    if (productId.isEmpty) {
      issues['id'] = ProductCategoriesDraftIssue.required;
    }

    for (final (index, raw) in categories.indexed) {
      final value = trimProductCategory(raw);
      final field = 'category:$index';

      if (value.isEmpty) {
        issues[field] = ProductCategoriesDraftIssue.required;
      } else if (!_isWellFormedUnicode(value)) {
        issues[field] = ProductCategoriesDraftIssue.invalidUnicode;
      } else if (utf8.encode(value).length > 127) {
        issues[field] = ProductCategoriesDraftIssue.tooLong;
      }
    }

    return Map.unmodifiable(issues);
  }

  models.ProductsCategoriesSetInput setInput() {
    if (validate().isNotEmpty) {
      throw const FormatException('INVALID_PRODUCT_CATEGORIES_DRAFT');
    }

    // The Webapp submits raw selections. The server owns trimming and
    // case-insensitive deduplication, including the first spelling retained.
    return models.ProductsCategoriesSetInput(
      id: productId,
      categories: categories,
    );
  }
}

String trimProductCategory(String value) {
  var start = 0;
  var end = value.length;

  while (start < end && _isRustWhitespace(value.codeUnitAt(start))) {
    start++;
  }

  while (end > start && _isRustWhitespace(value.codeUnitAt(end - 1))) {
    end--;
  }

  return value.substring(start, end);
}

bool _isWellFormedUnicode(String value) {
  for (var index = 0; index < value.length; index++) {
    final codeUnit = value.codeUnitAt(index);

    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 == value.length) {
        return false;
      }

      final next = value.codeUnitAt(index + 1);

      if (next < 0xdc00 || next > 0xdfff) {
        return false;
      }

      index++;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }

  return true;
}

bool _isRustWhitespace(int codePoint) {
  // Rust str::trim uses Unicode White_Space, which excludes BOM. Dart trim
  // removes BOM too, so it cannot validate these category values unchanged.
  return (codePoint >= 0x0009 && codePoint <= 0x000d) ||
      codePoint == 0x0020 ||
      codePoint == 0x0085 ||
      codePoint == 0x00a0 ||
      codePoint == 0x1680 ||
      (codePoint >= 0x2000 && codePoint <= 0x200a) ||
      codePoint == 0x2028 ||
      codePoint == 0x2029 ||
      codePoint == 0x202f ||
      codePoint == 0x205f ||
      codePoint == 0x3000;
}
