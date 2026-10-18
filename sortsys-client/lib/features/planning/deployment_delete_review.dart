import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

import '../../ui/text.dart';
import 'deployment_delete_receipt.dart';

class DeploymentDeleteReview extends StatelessWidget {
  const DeploymentDeleteReview({
    super.key,
    required this.receipt,
    required this.busy,
    required this.onRecover,
  });

  final DeploymentDeleteReceipt? receipt;
  final bool busy;
  final VoidCallback onRecover;

  String _message(BuildContext context) {
    final pending = receipt;

    if (pending == null) {
      return text(
        context,
        'Der Status des Löschvorgangs konnte nicht gelesen werden. '
            'Der Vorgang wird nicht wiederholt.',
        'The deletion status could not be read. '
            'The operation will not be repeated.',
      );
    }

    if (pending.dispatching) {
      return text(
        context,
        'Für den Löschvorgang fehlt die Bestätigung. '
            'Der Vorgang bleibt gespeichert und wird nicht wiederholt.',
        'The deletion has no acknowledgement. '
            'The operation remains stored and will not be repeated.',
      );
    }

    if (pending.acknowledged) {
      return text(
        context,
        'Die API hat den Einsatz gelöscht. '
            'Schließe den gespeicherten Vorgang ab.',
        'The API acknowledged deletion. Finish clearing the stored operation.',
      );
    }

    return text(
      context,
      'Der Löschvorgang wurde nicht gesendet. '
          'Du kannst den ungesendeten Vorgang verwerfen.',
      'The deletion was not submitted. You can discard the unsent operation.',
    );
  }

  @override
  Widget build(BuildContext context) {
    final pending = receipt;
    final dateTime = DateFormat('dd.MM.yyyy HH:mm');

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(_message(context)),
        if (pending != null) ...[
          const SizedBox(height: 12),
          Text(
            text(
              context,
              'Einsatz ${pending.baseline.id}',
              'Assignment ${pending.baseline.id}',
            ),
          ),
          Text(
            '${dateTime.format(pending.baseline.from.toLocal())} – '
            '${dateTime.format(pending.baseline.to.toLocal())}',
          ),
          Text(
            text(
              context,
              'Projekt: ${pending.baseline.projectId} · '
                  'Mitarbeiter: ${pending.baseline.userId}',
              'Project: ${pending.baseline.projectId} · '
                  'Employee: ${pending.baseline.userId}',
            ),
          ),
        ],
        if (pending != null && !pending.dispatching) ...[
          const SizedBox(height: 12),
          Align(
            alignment: Alignment.centerRight,
            child: SsButton(
              onPressed: busy ? null : onRecover,
              child: Text(
                pending.acknowledged
                    ? text(context, 'Vorgang abschließen', 'Finish operation')
                    : text(
                        context,
                        'Ungesendeten Vorgang verwerfen',
                        'Discard unsent operation',
                      ),
              ),
            ),
          ),
        ],
      ],
    );
  }
}
