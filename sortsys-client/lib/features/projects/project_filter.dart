import '../../api/generated/models.g.dart' as api_models;
import '../../api/model.dart';

enum ProjectListStatus {
  active(false),
  completed(true);

  const ProjectListStatus(this.finished);

  final bool finished;
}

api_models.ProjectsListInput projectListInput(
  String search,
  ProjectListStatus status,
) {
  final querySearch = search.isEmpty
      ? const RpcOptional<String>.absent()
      : RpcOptional<String>.value(search);

  return api_models.ProjectsListInput(
    search: querySearch,
    finished: RpcOptional.value(status.finished),
  );
}
