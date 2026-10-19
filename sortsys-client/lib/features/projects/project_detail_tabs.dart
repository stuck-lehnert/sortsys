import 'package:flutter/widgets.dart';
import 'package:go_router/go_router.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

import '../../ui/text.dart';

enum ProjectDetailTab { overview, regieReports }

String projectDetailLocation(String id, ProjectDetailTab tab) {
  final base = '/projects/${Uri.encodeComponent(id)}';

  return tab == ProjectDetailTab.overview ? base : '$base/regieReports';
}

class ProjectDetailTabs extends StatelessWidget {
  const ProjectDetailTabs({
    super.key,
    required this.id,
    required this.tab,
    required this.canViewTools,
    required this.canViewRegieReports,
  });

  final String id;
  final ProjectDetailTab tab;
  final bool canViewTools;
  final bool canViewRegieReports;

  @override
  Widget build(BuildContext context) {
    final tabs = [
      if (canViewTools)
        SsTab(
          value: ProjectDetailTab.overview,
          label: text(context, 'Übersicht', 'Overview'),
        ),
      if (canViewRegieReports)
        SsTab(
          value: ProjectDetailTab.regieReports,
          label: text(context, 'Regieberichte', 'Time-and-material reports'),
        ),
    ];

    if (tabs.isEmpty) {
      return const SizedBox.shrink();
    }

    return SsTabs(
      tabs: tabs,
      value: tab,
      onChanged: (next) {
        if (next != tab) {
          context.go(projectDetailLocation(id, next));
        }
      },
    );
  }
}
