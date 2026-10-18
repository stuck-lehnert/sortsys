import 'package:flutter/widgets.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

import '../../ui/text.dart';
import 'project_filter.dart';

class ProjectStatusFilter extends StatelessWidget {
  const ProjectStatusFilter({
    required this.status,
    required this.onChanged,
    super.key,
  });

  final ProjectListStatus status;
  final ValueChanged<ProjectListStatus> onChanged;

  @override
  Widget build(BuildContext context) {
    return SsSelectField<ProjectListStatus>(
      value: status,
      label: 'Status',
      options: [
        for (final value in ProjectListStatus.values)
          SsOption(value: value, label: _label(context, value)),
      ],
      onChanged: onChanged,
    );
  }
}

String _label(BuildContext context, ProjectListStatus status) {
  return switch (status) {
    ProjectListStatus.active => text(context, 'Aktiv', 'Active'),
    ProjectListStatus.completed => text(context, 'Abgeschlossen', 'Completed'),
  };
}
