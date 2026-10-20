import '../../api/contract.dart';
import '../../api/generated/api.g.dart';
import '../../api/procedure.dart';
import 'tool_draft.dart' show isToolScalarText;
import 'tool_rpc_access.dart';

final class ToolFormReads {
  const ToolFormReads({required this.access});

  final ToolRpcAccess access;

  void _checkScope() {
    access.checkCurrent();

    if (!access.can('manage:tools')) {
      throw StateError('TOOL_FORM_FORBIDDEN');
    }
  }

  Future<int?> suggestNumber() async {
    _checkScope();

    if (access.toolId != null) {
      throw const FormatException('INVALID_TOOL_NUMBER_CONTEXT');
    }

    final value = await access.read(
      ApiQueries.toolsSuggestNextCustomId,
      rpcUndefined,
    );

    _checkScope();

    if (!value.isFinite ||
        value < 0 ||
        value > 2147483647 ||
        value != value.truncateToDouble()) {
      throw const FormatException('INVALID_TOOL_NUMBER_SUGGESTION');
    }

    // The canonical form leaves the current number unchanged for zero.
    return value == 0 ? null : value.toInt();
  }

  Future<List<String>> brands() {
    return _options(ApiQueries.toolsBrands);
  }

  Future<List<String>> categories() {
    return _options(ApiQueries.toolsCategories);
  }

  Future<List<String>> _options(
    RpcQuery<RpcUndefined, List<String>> query,
  ) async {
    _checkScope();

    final options = await access.read(query, rpcUndefined);

    _checkScope();

    if (options.any((option) {
      return !isToolScalarText(option);
    })) {
      throw const FormatException('INVALID_TOOL_FORM_SUGGESTIONS');
    }

    // Preserve the server's raw order, case, whitespace and multiplicity.
    return List<String>.unmodifiable(options);
  }
}
