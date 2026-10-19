import 'package:flutter/widgets.dart';
import 'package:intl/intl.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

import '../../api/generated/models.g.dart' as models;
import '../../ui/entity_external_link.dart';
import '../../ui/text.dart';
import 'user_list_state.dart';

class UserDetailLayout extends StatelessWidget {
  const UserDetailLayout({
    super.key,
    required this.user,
    this.supervisor,
    this.onSupervisorPressed,
    this.notices,
    this.bookedTools,
  });

  final models.User user;
  final models.User? supervisor;
  final VoidCallback? onSupervisorPressed;
  final Widget? notices;
  final Widget? bookedTools;

  Widget _divider(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 19.2),
      child: Container(
        height: 1,
        color: SsTheme.of(context).text.withValues(alpha: 0.3),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final title = userListName(user);
    final language = Localizations.localeOf(context).languageCode;
    final currency = NumberFormat.currency(
      locale: language == 'en' ? 'en_GB' : 'de_DE',
      name: 'EUR',
      symbol: '€',
      decimalDigits: 2,
    );
    final supervisor = this.supervisor;
    final content = ListView(
      padding: EdgeInsets.zero,
      children: [
        SsPageHeader(title: title),
        ?notices,
        _divider(context),
        SsAttributeList(
          children: [
            SsAttribute(
              label: text(context, 'Vorname', 'First name'),
              child: Text(user.firstName),
            ),
            if (user.lastName?.isNotEmpty == true)
              SsAttribute(
                label: text(context, 'Nachname', 'Last name'),
                child: Text(user.lastName!),
              ),
            SsAttribute(
              label: text(context, 'Anmeldename', 'Username'),
              child: Text(
                user.username,
                // Do not carry Ubuntu's asset-package prefix into a system font.
                style: TextStyle(
                  inherit: false,
                  fontFamily: 'monospace',
                  fontSize: SsTheme.of(context).body.fontSize,
                  fontWeight: SsTheme.of(context).body.fontWeight,
                  height: SsTheme.of(context).body.height,
                  color: SsTheme.of(context).text,
                ),
              ),
            ),
            if (user.email?.isNotEmpty == true)
              SsAttribute(
                label: text(context, 'E-Mail', 'Email'),
                child: EntityExternalLink(
                  uri: Uri(scheme: 'mailto', path: user.email),
                  label: user.email!,
                ),
              ),
            if (user.phone?.isNotEmpty == true)
              SsAttribute(
                label: text(context, 'Telefon', 'Phone'),
                child: EntityExternalLink(
                  uri: Uri(scheme: 'tel', path: user.phone),
                  label: user.phone!,
                ),
              ),
            SsAttribute(
              label: text(context, 'Vertrag', 'Contract'),
              child: Text(
                userColumnText(user, UserSortColumn.contract, language),
              ),
            ),
            if (supervisor != null &&
                user.supervisorUserId?.isNotEmpty == true &&
                supervisor.id == user.supervisorUserId)
              SsAttribute(
                label: text(context, 'Vorgesetzter', 'Supervisor'),
                child: SsLink(
                  uri: Uri.parse(
                    '/users/${Uri.encodeComponent(supervisor.id)}',
                  ),
                  onPressed: onSupervisorPressed,
                  child: Text(userListName(supervisor)),
                ),
              ),
            if (user.costPerHour != null && user.costPerHour != 0)
              SsAttribute(
                label: text(context, 'Kosten pro Std', 'Cost per hour'),
                child: Text(currency.format(user.costPerHour)),
              ),
            if (user.vacationDaysPerYear != null)
              SsAttribute(
                label: text(
                  context,
                  'Urlaubstage pro Jahr',
                  'Leave days per year',
                ),
                child: Text(
                  user.vacationDaysPerYear.toString().replaceFirst(
                    RegExp(r'\.0$'),
                    '',
                  ),
                ),
              ),
          ],
        ),
        _divider(context),
        ?bookedTools,
      ],
    );

    if (title.isEmpty) {
      return content;
    }

    return Title(title: title, color: SsTheme.of(context).text, child: content);
  }
}
