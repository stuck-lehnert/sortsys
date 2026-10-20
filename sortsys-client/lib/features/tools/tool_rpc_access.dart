import '../../api/generated/api.g.dart';
import '../../api/generated/models.g.dart' as models;
import '../../api/procedure.dart';
import 'tool_draft.dart' show isToolScalarText;
import 'tool_read_repository.dart' show ToolRead;
import 'tool_receipt.dart' show freezeToolWriteBaseline;
import 'tool_write_access.dart';
import 'tool_write_inputs.dart';

typedef ToolWrite =
    Future<O> Function<I, O>(RpcMutation<I, O> mutation, I input);

final class ToolRpcAccess implements ToolWriteAccess {
  const ToolRpcAccess({
    required this.scope,
    this.toolId,
    required this.read,
    required this.write,
    required this.isCurrent,
    required this.can,
  });

  @override
  final String scope;

  @override
  final String? toolId;

  final ToolRead read;
  final ToolWrite write;
  final bool Function() isCurrent;
  final bool Function(String permission) can;

  @override
  void checkCurrent() {
    final target = toolId;

    if (scope.isEmpty ||
        !isToolScalarText(scope) ||
        (target != null && (target.isEmpty || !isToolScalarText(target)))) {
      throw const FormatException('INVALID_TOOL_WRITE_OWNER');
    }

    if (!isCurrent() || !can('view:tools')) {
      throw StateError('TOOL_WRITE_SCOPE_CHANGED');
    }
  }

  void _checkManage() {
    checkCurrent();

    if (!can('manage:tools')) {
      throw StateError('TOOL_WRITE_FORBIDDEN');
    }
  }

  @override
  void checkCreate(models.ToolsCreateInput input) {
    _checkManage();

    if (toolId != null) {
      throw const FormatException('INVALID_TOOL_CREATE_TARGET');
    }

    checkToolCreateInput(input);
  }

  @override
  void checkUpdate(models.ToolsUpdateInput input) {
    _checkManage();

    if (toolId == null || input.id != toolId) {
      throw const FormatException('INVALID_TOOL_UPDATE_TARGET');
    }

    checkToolUpdateInput(input);
  }

  @override
  Future<models.ToolsCreateOutput> createTool(
    models.ToolsCreateInput input,
  ) async {
    checkCreate(input);

    final request = copyToolCreateInput(input);

    final result = await write(ApiMutations.toolsCreate, request);

    // Manage-role loss alone must not erase a genuine server acknowledgement.
    checkCurrent();

    if (result.id.isEmpty || !isToolScalarText(result.id)) {
      throw const FormatException('INVALID_TOOL_CREATE_ACK');
    }

    return result;
  }

  @override
  Future<models.ToolsUpdateOutput> updateTool(
    models.ToolsUpdateInput input,
  ) async {
    checkUpdate(input);

    final request = copyToolUpdateInput(input);

    final result = await write(ApiMutations.toolsUpdate, request);

    checkCurrent();

    if (!result.success) {
      throw const FormatException('INVALID_TOOL_UPDATE_ACK');
    }

    return result;
  }

  @override
  Future<models.Tool?> getTool(String id) async {
    checkCurrent();

    if (id.isEmpty ||
        !isToolScalarText(id) ||
        (toolId != null && id != toolId)) {
      throw const FormatException('INVALID_TOOL_READBACK_TARGET');
    }

    final tool = await read(ApiQueries.toolsGet, models.ToolsGetInput(id: id));

    checkCurrent();

    if (tool.id != id) {
      throw const FormatException('TOOL_READBACK_ID_MISMATCH');
    }

    return freezeToolWriteBaseline(tool);
  }
}
