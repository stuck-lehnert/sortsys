import '../../api/generated/models.g.dart' as models;

abstract interface class ToolWriteAccess {
  String get scope;

  String? get toolId;

  void checkCurrent();

  void checkCreate(models.ToolsCreateInput input);

  void checkUpdate(models.ToolsUpdateInput input);

  Future<models.ToolsCreateOutput> createTool(models.ToolsCreateInput input);

  Future<models.ToolsUpdateOutput> updateTool(models.ToolsUpdateInput input);

  Future<models.Tool?> getTool(String id);
}
