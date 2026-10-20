import '../../api/generated/models.g.dart' as models;
import 'product_categories_draft.dart';
import 'product_categories_matcher.dart';

void checkProductCategoriesInput(models.ProductsCategoriesSetInput input) {
  final draft = ProductCategoriesDraft(
    productId: input.id,
    categories: input.categories,
  );

  if (draft.validate().isNotEmpty) {
    throw const FormatException('INVALID_PRODUCT_CATEGORIES_INPUT');
  }
}

List<String> productCategoriesStoredValues(
  models.ProductsCategoriesSetInput input,
) {
  checkProductCategoriesInput(input);

  final seen = <String>{};
  final categories = <String>[];

  for (final raw in input.categories) {
    final value = trimProductCategory(raw);
    final key = lowercaseProductCategory(value);

    if (seen.add(key)) {
      categories.add(value);
    }
  }

  return List.unmodifiable(categories);
}

bool productCategoriesInputMatches(
  models.ProductsCategoriesSetInput input,
  models.Product product,
) {
  return product.id == input.id &&
      sameProductCategoryValues(
        productCategoriesStoredValues(input),
        product.categories,
      );
}

bool sameProductCategoryValues(List<String> left, List<String> right) {
  if (left.length != right.length) {
    return false;
  }

  final counts = <String, int>{};

  for (final value in left) {
    counts[value] = (counts[value] ?? 0) + 1;
  }

  for (final value in right) {
    final remaining = counts[value];

    if (remaining == null) {
      return false;
    }

    if (remaining == 1) {
      counts.remove(value);
    } else {
      counts[value] = remaining - 1;
    }
  }

  return counts.isEmpty;
}
