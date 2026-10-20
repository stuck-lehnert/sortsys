import '../products/product_categories_matcher.dart'
    show lowercaseProductCategory, normalizeProductCategoryQuery;

List<String> matchToolSuggestions(List<String> options, String query) {
  final normalized = normalizeProductCategoryQuery(query);

  if (normalized.isEmpty) {
    return const [];
  }

  // Reuse the pinned ECMAScript rules, without the multiselect's 20-item cap.
  return List<String>.unmodifiable(
    options.where((option) {
      return lowercaseProductCategory(option).contains(normalized);
    }),
  );
}
