import '../../api/generated/models.g.dart' as api_models;

enum ProjectLifecycleAction { finish, resume }

final class ProjectLifecycleIntent {
  const ProjectLifecycleIntent({required this.id, required this.action});

  final String id;
  final ProjectLifecycleAction action;

  bool get finished {
    return action == ProjectLifecycleAction.finish;
  }

  api_models.ProjectsFinishInput get input {
    return api_models.ProjectsFinishInput(id: id);
  }

  void validate() {
    if (id.isEmpty) {
      throw const FormatException('INVALID_PROJECT_LIFECYCLE_ID');
    }
  }

  factory ProjectLifecycleIntent.fromWire(String kind, Object? value) {
    final action = switch (kind) {
      'finish' => ProjectLifecycleAction.finish,
      'resume' => ProjectLifecycleAction.resume,
      _ => throw const FormatException('INVALID_PROJECT_LIFECYCLE_KIND'),
    };
    final input = api_models.ProjectsFinishInput.fromWire(value);
    final intent = ProjectLifecycleIntent(id: input.id, action: action);
    intent.validate();

    return intent;
  }
}
