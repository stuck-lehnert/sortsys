import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

import '../../state/session_controller.dart';
import '../../ui/query_view.dart';
import '../../ui/text.dart';
import '../contacts/contact_detail_screen.dart';
import '../delivery_notes/delivery_note_detail_screen.dart';
import '../products/product_detail_screen.dart';
import '../tools/tool_detail_screen.dart';
import '../users/user_detail_screen.dart';
import '../vendors/vendor_detail_screen.dart';
import 'catalog.dart';
import 'entity_presentation.dart';
import 'entity_record.dart';
import 'entity_repository.dart';

const _detailFields = {
  'customId': ('Nummer', 'Number'),
  'category': ('Kategorie', 'Category'),
  'brand': ('Marke', 'Brand'),
  'description': ('Beschreibung', 'Description'),
  'email': ('E-Mail', 'Email'),
  'phone': ('Telefon', 'Phone'),
  'username': ('Nutzername', 'Username'),
  'status': ('Status', 'Status'),
  'note': ('Notiz', 'Note'),
  'comment': ('Kommentar', 'Comment'),
  'createdAt': ('Erstellt', 'Created'),
  'modifiedAt': ('Geändert', 'Modified'),
  'finishedAt': ('Abgeschlossen', 'Completed'),
};

class EntityDetailScreen extends StatelessWidget {
  const EntityDetailScreen(this.spec, this.id, {super.key});

  final EntitySpec spec;
  final String id;

  @override
  Widget build(BuildContext context) {
    final session = context.watch<SessionController>();
    if (session.info?.can(spec.role) != true) {
      return const EntityAccessDenied();
    }

    if (spec.key == 'contacts') {
      return ContactDetailScreen(id: id);
    }

    if (spec.key == 'tools') {
      return ToolDetailScreen(id: id);
    }

    if (spec.key == 'vendors') {
      return VendorDetailScreen(id: id);
    }

    if (spec.key == 'products') {
      return ProductDetailScreen(id: id);
    }

    if (spec.key == 'users') {
      return UserDetailScreen(id: id);
    }

    if (spec.key == 'delivery-notes') {
      return DeliveryNoteDetailScreen(id: id);
    }

    return QueryView(
      requestKey: spec.get!,
      identity: id,
      load: (session) {
        return loadEntityDetail(session, spec.key, id);
      },

      builder: (context, row, reload) {
        if (row.id != id) {
          return Center(
            child: Text(
              text(
                context,
                'Der Datensatz gehört nicht zur Auswahl.',
                'The record does not match your selection.',
              ),
            ),
          );
        }

        return _EntityDetails(row: row, onReload: reload);
      },
    );
  }
}

class _EntityDetails extends StatelessWidget {
  const _EntityDetails({required this.row, required this.onReload});

  final EntityRecord row;
  final VoidCallback onReload;

  @override
  Widget build(BuildContext context) {
    final locale = Localizations.localeOf(context).languageCode;
    final dateFormat = DateFormat.yMd(locale).add_Hm();
    final fields = _visibleFields(context, dateFormat);

    return ListView(
      padding: EdgeInsets.zero,
      children: [
        Row(
          children: [
            Expanded(
              child: Text(recordTitle(row), style: SsTheme.of(context).heading),
            ),
            SsIconButton(
              label: text(context, 'Aktualisieren', 'Refresh'),
              onPressed: onReload,
              icon: 'refresh',
            ),
          ],
        ),
        if (row.address != null)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 16),
            child: SelectableText(row.address!),
          ),
        ...fields,
      ],
    );
  }

  List<Widget> _visibleFields(BuildContext context, DateFormat dateFormat) {
    final widgets = <Widget>[];

    for (final entry in _detailFields.entries) {
      final value = row.fields[entry.key];

      if (value == null) {
        continue;
      }

      final label = text(context, entry.value.$1, entry.value.$2);
      final content = value.format(dateFormat);

      widgets.add(
        Padding(
          padding: const EdgeInsets.only(bottom: 8),
          child: SsSurface(
            child: SsListTile(
              title: Text(label),
              subtitle: SelectableText(content),
            ),
          ),
        ),
      );
    }

    return widgets;
  }
}
