import '../../api/generated/models.g.dart' as models;

abstract interface class ProductCategoriesWriteAccess {
  String get scope;

  String get productId;

  void checkCurrent();

  void checkSet(models.ProductsCategoriesSetInput input);

  Future<models.ProductsCategoriesSetOutput> setCategories(
    models.ProductsCategoriesSetInput input,
  );

  Future<models.Product?> getProduct(String id);
}
