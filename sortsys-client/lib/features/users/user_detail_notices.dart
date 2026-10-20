import 'package:flutter/widgets.dart';
import 'package:intl/intl.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

import '../../api/generated/models.g.dart' as models;
import '../../ui/text.dart';

class UserDetailNotices extends StatelessWidget {
  const UserDetailNotices({super.key, required this.user, this.now});

  final models.User user;
  final DateTime? now;

  String _date(BuildContext context, DateTime date) {
    final english = Localizations.localeOf(context).languageCode == 'en';

    return DateFormat(english ? 'MM/dd/yyyy' : 'dd.MM.yyyy')
        .format(date.toLocal());
  }

  @override
  Widget build(BuildContext context) {
    final deactivatedAt = user.deactivatedAt;
    final archivedAt = user.archivedAt;
    final current = now ?? DateTime.now();

    if (deactivatedAt == null && archivedAt == null) {
      return const SizedBox.shrink();
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (deactivatedAt != null)
          SsInfoCallout(
            kind: SsCalloutKind.warning,
            icon: 'lock',
            child: Text(
              deactivatedAt.isAfter(current)
                  ? text(
                      context,
                      'Benutzer wird am ${_date(context, deactivatedAt)} deaktiviert.',
                      'User will be deactivated on ${_date(context, deactivatedAt)}.',
                    )
                  : text(
                      context,
                      'Benutzer ist seit ${_date(context, deactivatedAt)} deaktiviert.',
                      'User has been deactivated since ${_date(context, deactivatedAt)}.',
                    ),
            ),
          ),
        if (archivedAt != null)
          SsInfoCallout(
            icon: 'archive',
            child: Text(
              text(
                context,
                'Benutzer ist seit ${_date(context, archivedAt)} archiviert.',
                'User has been archived since ${_date(context, archivedAt)}.',
              ),
            ),
          ),
      ],
    );
  }
}
