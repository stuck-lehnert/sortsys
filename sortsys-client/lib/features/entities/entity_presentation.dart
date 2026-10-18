import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../../ui/text.dart';
import 'entity_record.dart';

String recordTitle(EntityRecord row) {
  return row.title;
}

String recordSubtitle(EntityRecord row, String locale) {
  final address = row.address;

  if (address != null) {
    return address;
  }

  final createdAt = row.createdAt;
  final parts = [
    ...row.subtitleParts,
    if (createdAt != null) DateFormat.yMd(locale).format(createdAt),
  ];

  return parts.join(' · ');
}

class EntityAccessDenied extends StatelessWidget {
  const EntityAccessDenied({super.key});

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Text(
        text(
          context,
          'Keine Berechtigung für diesen Bereich.',
          'You do not have permission for this section.',
        ),
      ),
    );
  }
}
