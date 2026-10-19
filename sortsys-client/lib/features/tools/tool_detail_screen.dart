import 'package:flutter/widgets.dart';
import 'package:provider/provider.dart';

import '../../api/generated/api.g.dart';
import '../../api/generated/models.g.dart' as models;
import '../../state/session_controller.dart';
import '../../ui/query_view.dart';
import '../entities/entity_presentation.dart';
import '../projects/project_history.dart';
import 'tool_detail_layout.dart';
import 'tool_read_repository.dart';

class ToolDetailScreen extends StatelessWidget {
  const ToolDetailScreen({super.key, required this.id});

  final String id;

  @override
  Widget build(BuildContext context) {
    final session = context.watch<SessionController>();
    final binding = session.binding;

    if (!session.authenticated || session.info?.can('view:tools') != true) {
      return const EntityAccessDenied();
    }

    return QueryView<models.Tool>(
      requestKey: ApiQueries.toolsGet.path,
      identity: id,
      load: (current) {
        return ToolReadRepository(
          toolId: id,
          read: current.read,
          isCurrent: () {
            return current.authenticated && current.binding == binding;
          },
          can: (permission) {
            return current.info?.can(permission) == true;
          },
        ).get();
      },
      builder: (context, tool, reload) {
        return ToolDetailLayout(
          tool: tool,
          child: KeyedSubtree(
            key: ValueKey((binding, tool.id, tool.modifiedAt)),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                ProjectRemarks(
                  projectId: tool.id,
                  resourceType: models.RemarksListRequestResourceType.tool,
                ),
                const SizedBox(height: 16),
                ProjectActivity(
                  projectId: tool.id,
                  resourceType: models.ActivityResourceType.tool,
                ),
              ],
            ),
          ),
        );
      },
    );
  }
}
