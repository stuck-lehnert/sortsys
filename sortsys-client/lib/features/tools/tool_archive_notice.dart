import 'package:flutter/widgets.dart';
import 'package:intl/intl.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

import '../../ui/text.dart';

class ToolArchiveNotice extends StatelessWidget {
  const ToolArchiveNotice({super.key, required this.archivedSince});

  final DateTime archivedSince;

  @override
  Widget build(BuildContext context) {
    final pattern = text(context, 'dd.MM.yyyy', 'MM/dd/yyyy');
    final date = DateFormat(pattern).format(archivedSince.toLocal());

    return SsInfoCallout(
      child: Text(
        text(
          context,
          'Werkzeug ist seit $date archiviert.',
          'Tool has been archived since $date.',
        ),
      ),
    );
  }
}
