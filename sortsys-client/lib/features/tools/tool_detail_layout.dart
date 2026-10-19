import 'package:flutter/widgets.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

import '../../api/generated/models.g.dart' as models;
import '../../ui/text.dart';

String toolTitle(models.Tool tool) {
  final title = '${tool.brand} ${tool.category}';
  final label = tool.label;

  if (label != null && label.isNotEmpty) {
    return '$title $label';
  }

  return title;
}

String toolNumber(num number) {
  if (number % 1 == 0) {
    return number.toInt().toString();
  }

  return number.toString();
}

(String, String, SsTagTone) toolStatusPresentation(models.Tool tool) {
  return switch (tool.status) {
    models.ToolStatus.lost => ('abhanden', 'missing', SsTagTone.red),
    models.ToolStatus.broken => ('defekt', 'broken', SsTagTone.magenta),
    null => tool.available
        ? ('verfügbar', 'available', SsTagTone.green)
        : ('gebucht', 'booked', SsTagTone.cyan),
  };
}

class ToolDetailLayout extends StatelessWidget {
  const ToolDetailLayout({
    super.key,
    required this.tool,
    required this.child,
  });

  final models.Tool tool;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final title = '${toolNumber(tool.customId)} ${toolTitle(tool)}';
    final (statusDe, statusEn, tone) = toolStatusPresentation(tool);
    final status = text(context, statusDe, statusEn);
    final locale = Localizations.localeOf(context).languageCode == 'en'
        ? 'en_GB'
        : 'de_DE';
    final currency = NumberFormat.currency(
      locale: locale,
      name: 'EUR',
      symbol: '€',
      decimalDigits: 2,
    );

    return Title(
      title: title,
      color: SsTheme.of(context).surface,
      child: ListView(
        padding: EdgeInsets.zero,
        children: [
          SsPageHeader(
            title: title,
            subtitleWidget: SsTag(tone: tone, child: Text(status)),
          ),
          _divider(context),
          SsAttributeList(
            children: [
              SsAttribute(
                label: text(context, 'Nummer', 'Number'),
                child: Text(toolNumber(tool.customId)),
              ),
              SsAttribute(
                label: text(context, 'Marke', 'Brand'),
                child: _filterLink(context, 'brand', tool.brand),
              ),
              SsAttribute(
                label: text(context, 'Kategorie', 'Category'),
                child: _filterLink(context, 'category', tool.category),
              ),
              SsAttribute(
                label: text(context, 'Gebucht', 'Booked'),
                child: Text(
                  tool.available
                      ? text(context, 'Nein', 'No')
                      : text(context, 'Ja', 'Yes'),
                ),
              ),
              if (tool.label?.isNotEmpty == true)
                SsAttribute(
                  label: text(context, 'Modell', 'Model'),
                  child: Text(tool.label!),
                ),
              if (tool.status != null)
                SsAttribute(
                  label: text(context, 'Status', 'Status'),
                  child: Text(status),
                ),
            ],
          ),
          if (tool.purchasePrice != null || tool.usageCostPerDay != null) ...[
            const SizedBox(height: 8.8),
            SsAttributeList(
              children: [
                if (tool.purchasePrice != null)
                  SsAttribute(
                    label: text(context, 'Kaufpreis', 'Purchase price'),
                    child: Text(currency.format(tool.purchasePrice)),
                  ),
                if (tool.usageCostPerDay != null)
                  SsAttribute(
                    label: text(
                      context,
                      'Nutzungskosten pro Tag',
                      'Usage cost per day',
                    ),
                    child: Text(currency.format(tool.usageCostPerDay)),
                  ),
              ],
            ),
          ],
          _divider(context),
          child,
        ],
      ),
    );
  }
}

Widget _filterLink(BuildContext context, String filter, String value) {
  final uri = Uri(path: '/tools', queryParameters: {filter: value});

  return SsLink(
    uri: uri,
    onPressed: () {
      context.go(uri.toString());
    },
    child: Text(value),
  );
}

Widget _divider(BuildContext context) {
  return Padding(
    padding: const EdgeInsets.symmetric(vertical: 12),
    child: Container(height: 1, color: SsTheme.of(context).border),
  );
}
