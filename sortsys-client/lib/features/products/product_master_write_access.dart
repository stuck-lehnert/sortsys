import '../../api/generated/models.g.dart' as models;

abstract interface class ProductMasterWriteAccess {
  String get scope;

  void checkCurrent();

  void checkCreate(models.ProductsCreateInput input);

  void checkUpdate(models.ProductsUpdateInput input);

  Future<models.ProductsCreateOutput> createProduct(
    models.ProductsCreateInput input,
  );

  Future<models.ProductsUpdateOutput> updateProduct(
    models.ProductsUpdateInput input,
  );

  Future<models.Product?> getProduct(String id);
}
