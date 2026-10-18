import 'package:flutter/widgets.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

import '../../ui/text.dart';
import 'project_block_receipt.dart';

class ProjectBlockReview extends StatelessWidget {
  const ProjectBlockReview({
    super.key,
    required this.receipt,
    required this.busy,
    required this.onRecover,
  });

  final ProjectBlockReceipt? receipt;
  final bool busy;
  final VoidCallback onRecover;

  @override
  Widget build(BuildContext context) {
    final pending = receipt;

    if (pending == null) {
      return Text(
        text(
          context,
          'Der Vorgangsstatus konnte nicht gelesen werden. '
              'Der Vorgang wird nicht wiederholt.',
          'The operation status could not be read. '
              'The operation will not be repeated.',
        ),
      );
    }

    final prepared = !pending.dispatching && !pending.acknowledged;
    final deleting = pending.kind == ProjectBlockWriteKind.delete;
    final unknownDelete = deleting && pending.dispatching;
    final baseline = pending.baseline;
    final period = '${ssDateText(baseline.from)} – ${ssDateText(baseline.to)}';
    String description;
    String action;

    if (prepared) {
      description = text(
        context,
        'Der Vorgang wurde nicht gesendet.',
        'The operation was not submitted.',
      );
      action = text(
        context,
        'Ungesendeten Vorgang verwerfen',
        'Discard unsent operation',
      );
    } else if (unknownDelete) {
      description = text(
        context,
        'Die API hat die Löschung nicht bestätigt. Der Vorgang bleibt '
            'gespeichert und wird nicht wiederholt.',
        'The API has not acknowledged deletion. The operation remains '
            'stored and will not be repeated.',
      );
      action = '';
    } else if (deleting) {
      description = text(
        context,
        'Die API hat die Löschung bestätigt. Der gespeicherte Vorgang '
            'muss noch abgeschlossen werden.',
        'The API acknowledged deletion. The stored operation '
            'still needs to be finished.',
      );
      action = text(context, 'Vorgang abschließen', 'Finish operation');
    } else {
      description = text(
        context,
        'Die Änderung muss anhand der bekannten ID geprüft werden. '
            'Die Prüfung sendet keine Änderung erneut.',
        'Verify the update using the known ID. '
            'Verification does not submit another update.',
      );
      action = text(context, 'Vorgang prüfen', 'Verify operation');
    }

    final details = <Widget>[
      Text('${baseline.id} · ${baseline.projectId}'),
      const SizedBox(height: 4),
      Text(period),
      const SizedBox(height: 4),
      Text(baseline.reason),
    ];
    final baselineNote = baseline.note;

    if (baselineNote != null && baselineNote.isNotEmpty) {
      details.addAll([
        const SizedBox(height: 4),
        Text('${text(context, 'Kommentar', 'Comment')}: $baselineNote'),
      ]);
    }

    if (!deleting) {
      final target = projectBlockTargetDraft(baseline, pending.updateInput);
      final targetPeriod =
          '${ssDateText(target.from)} – ${ssDateText(target.to)}';

      details.addAll([
        const SizedBox(height: 12),
        Text(text(context, 'Angeforderte Änderung', 'Requested update')),
        const SizedBox(height: 4),
        Text('${target.projectId} · $targetPeriod'),
        const SizedBox(height: 4),
        Text(target.reason),
      ]);

      if (target.note.isNotEmpty) {
        details.addAll([
          const SizedBox(height: 4),
          Text('${text(context, 'Kommentar', 'Comment')}: ${target.note}'),
        ]);
      }
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        ...details,
        const SizedBox(height: 12),
        Text(description),
        if (!unknownDelete) ...[
          const SizedBox(height: 12),
          Align(
            alignment: Alignment.centerRight,
            child: SsButton(
              kind: prepared ? SsButtonKind.secondary : SsButtonKind.primary,
              onPressed: busy ? null : onRecover,
              child: Text(action),
            ),
          ),
        ],
      ],
    );
  }
}
