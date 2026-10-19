import 'package:flutter/widgets.dart';
import 'package:intl/intl.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

import '../../api/generated/models.g.dart' as models;
import '../../ui/text.dart';
import 'delivery_note_list_state.dart';

class DeliveryNoteDetailLayout extends StatelessWidget {
  const DeliveryNoteDetailLayout({
    super.key,
    required this.note,
    required this.project,
    this.author,
    this.costs,
    this.products,
    this.specialItems,
  });

  final models.DeliveryNote note;
  final Widget project;
  final Widget? author;
  final models.DeliveryNotesCostsGetOutput? costs;
  final Widget? products;
  final Widget? specialItems;

  @override
  Widget build(BuildContext context) {
    final number = deliveryNoteNumber(note);
    final title = text(
      context,
      'Lieferschein #$number',
      'Delivery note #$number',
    );
    final english = Localizations.localeOf(context).languageCode == 'en';
    final dates = DateFormat(english ? 'MM/dd/yyyy' : 'dd.MM.yyyy');
    final currency = NumberFormat.currency(
      locale: english ? 'en_GB' : 'de_DE',
      name: 'EUR',
      symbol: '€',
      decimalDigits: 2,
    );
    final costs = this.costs;

    return Title(
      title: title,
      color: SsTheme.of(context).text,
      child: ListView(
        padding: EdgeInsets.zero,
        children: [
          SsPageHeader(title: title),
          SsAttributeList(
            children: [
              SsAttribute(
                label: text(context, 'Projekt', 'Project'),
                child: project,
              ),
              if (note.comment?.isNotEmpty == true)
                SsAttribute(
                  label: text(context, 'Kommentar', 'Comment'),
                  child: Text(note.comment!),
                ),
              SsAttribute(
                label: text(context, 'Erstellt am', 'Created on'),
                child: Text(dates.format(note.createdAt.toLocal())),
              ),
              if (note.createdByUserId?.isNotEmpty == true && author != null)
                SsAttribute(
                  label: text(context, 'Erstellt von', 'Created by'),
                  child: author!,
                ),
              if (costs != null && costs.noteId == note.id)
                SsAttribute(
                  label: text(context, 'Kosten', 'Costs'),
                  child: Text(currency.format(costs.totalCost)),
                ),
            ],
          ),
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 19.2),
            child: Container(
              height: 1,
              color: SsTheme.of(context).text.withValues(alpha: 0.3),
            ),
          ),
          if (note.records.isNotEmpty && products != null)
            SsDisclosure(
              title: text(context, 'Produkte', 'Products'),
              initiallyExpanded: true,
              child: products!,
            ),
          if (note.specialRecords.isNotEmpty && specialItems != null)
            SsDisclosure(
              title: text(context, 'Sonderposten', 'Special items'),
              initiallyExpanded: true,
              child: specialItems!,
            ),
        ],
      ),
    );
  }
}
