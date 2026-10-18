import 'dart:async';

import 'package:flutter/material.dart' show Dialog;
import 'package:flutter/widgets.dart';
import 'package:provider/provider.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

import '../../api/generated/models.g.dart' as api_models;
import '../../state/session_controller.dart';
import '../../ui/text.dart';
import 'project_draft.dart';
import 'project_form_fields.dart';
import 'project_receipt.dart';
import 'project_write_coordinator.dart';
import 'secure_project_receipts.dart';
import 'session_project_access.dart';

Future<String?> showProjectEditor(
  BuildContext context, {
  api_models.Project? project,
}) {
  final session = context.read<SessionController>();
  final binding = session.binding;

  if (!session.authenticated || session.info?.can('manage:projects') != true) {
    throw StateError('PROJECT_EDITOR_FORBIDDEN');
  }

  final access = SessionProjectAccess(session);

  return showGeneralDialog<String>(
    context: context,
    barrierDismissible: false,
    pageBuilder: (routeContext, animation, secondaryAnimation) {
      return InheritedTheme.captureAll(
        context,
        _ProjectEditor(
          access: access,
          binding: binding,
          projectId: project?.id,
        ),
      );
    },

  );
}

final class _EditorSeed {
  const _EditorSeed({this.project, this.customer, this.leader, this.receipt});

  final api_models.Project? project;
  final api_models.Customer? customer;
  final api_models.User? leader;
  final ProjectWriteReceipt? receipt;
}

class _ProjectEditor extends StatefulWidget {
  const _ProjectEditor({
    required this.access,
    required this.binding,
    this.projectId,
  });

  final SessionProjectAccess access;
  final String binding;
  final String? projectId;

  @override
  State<_ProjectEditor> createState() {
    return _ProjectEditorState();
  }

}

class _ProjectEditorState extends State<_ProjectEditor> {
  final _form = GlobalKey<FormState>();
  late final ProjectWriteCoordinator _writer;
  late Future<_EditorSeed> _seed;
  ProjectFormValues? _values;
  ProjectWriteReceipt? _pending;
  Object? _error;
  bool _busy = false;
  bool _requiresReview = false;

  @override
  void initState() {
    super.initState();

    _writer = ProjectWriteCoordinator(
      access: widget.access,
      receipts: SecureProjectReceipts(),
    );
    _seed = _load();
  }

  Future<_EditorSeed> _load() async {
    final pending = await _writer.outstanding();

    if (pending != null) {
      return _EditorSeed(receipt: pending);
    }

    final id = widget.projectId;
    final project = id == null ? null : await widget.access.getProject(id);
    final customer = await widget.access.initialCustomer(project?.customerId);
    final leader = await widget.access.initialLeader(
      project?.responsibleProjectLeaderUserId,
    );
    widget.access.checkCurrent();

    return _EditorSeed(project: project, customer: customer, leader: leader);
  }

  @override
  void dispose() {
    _values?.dispose();

    super.dispose();
  }

  Future<void> _save(_EditorSeed seed) async {
    if (_busy || _requiresReview || _form.currentState?.validate() != true) {
      return;
    }

    final draft = _values!.draft();
    _form.currentState!.save();

    setState(() {
      _busy = true;
      _error = null;
    });

    try {
      final id = await _writer.save(draft, baseline: seed.project);

      if (!mounted) {
        return;
      }

      Navigator.of(context).pop(id);
    } catch (error) {
      final review =
          error is ProjectWriteException &&
          error.failure != ProjectWriteFailure.conflict;
      ProjectWriteReceipt? receipt;

      if (review) {
        try {
          receipt = await _writer.outstanding();
        } catch (_) {
          // Keep the editor blocked even when receipt storage cannot be read.
        }

      }

      if (!mounted) {
        return;
      }

      setState(() {
        _busy = false;
        _requiresReview = review;
        _pending = receipt;
        _error = error;
      });

    }

  }

  Future<void> _recover() async {
    if (_busy) {
      return;
    }

    setState(() {
      _busy = true;
      _error = null;
    });

    try {
      final id = await _writer.recover();

      if (!mounted) {
        return;
      }

      Navigator.of(context).pop(id);
    } catch (error) {
      if (!mounted) {
        return;
      }

      setState(() {
        _busy = false;
        _error = error;
      });

    }

  }

  Widget _message(Object error) {
    var message = errorText(context, error);

    if (error is ProjectWriteException) {
      message = error.failure == ProjectWriteFailure.conflict
          ? text(
              context,
              'Das Projekt wurde inzwischen geändert. Bitte das Formular '
                  'schließen und mit den aktuellen Daten erneut öffnen.',
              'The project has changed. Close this form and reopen it '
                  'with the current data.',
            )
          : text(
              context,
              'Der Ausgang einer Projektänderung ist noch nicht bestätigt. '
                  'Die Anfrage wird nicht erneut gesendet.',
              'A project change has not been confirmed. '
                  'The request will not be sent again.',
            );
    }

    return Padding(
      padding: const EdgeInsets.only(bottom: 16),
      child: Text(
        message,
        style: SsTheme.of(
          context,
        ).body.copyWith(color: SsTheme.of(context).danger),
      ),
    );
  }

  Widget _pendingBody(ProjectWriteReceipt? receipt) {
    final knownId = receipt?.confirmedProjectId ?? receipt?.updateInput?.id;

    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          text(
            context,
            'Eine frühere Projektänderung muss geprüft werden, bevor eine '
                'weitere Änderung gesendet werden kann.',
            'An earlier project change must be checked before another '
                'change can be sent.',
          ),
        ),
        if (receipt != null) ...[
          const SizedBox(height: 12),
          Text(receipt.createInput?.title ?? receipt.updateInput!.id),
          Text(ssDateText(receipt.createdAt)),
        ],
        if (knownId != null) ...[
          const SizedBox(height: 16),
          SsButton(
            kind: SsButtonKind.secondary,
            onPressed: _busy ? null : _recover,
            child: Text(text(context, 'Ergebnis prüfen', 'Check result')),
          ),
        ],
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    final session = context.watch<SessionController>();
    final allowed =
        session.authenticated &&
        session.binding == widget.binding &&
        session.info?.can('manage:projects') == true;
    final colors = SsTheme.of(context);
    final creating = widget.projectId == null;

    return PopScope(
      canPop: !_busy,
      child: Dialog(
        backgroundColor: colors.surface,
        insetPadding: const EdgeInsets.all(16),
        shape: Border.all(color: colors.border),
        child: ConstrainedBox(
          constraints: BoxConstraints(
            maxWidth: 640,
            maxHeight: MediaQuery.sizeOf(context).height - 32,
          ),
          child: FutureBuilder<_EditorSeed>(
            future: _seed,
            builder: (context, snapshot) {
              final seed = snapshot.data;
              final pending = _pending ?? seed?.receipt;
              final reviewing = _requiresReview || pending != null;
              final ready = allowed && seed != null && !reviewing;

              if (ready && _values == null) {
                final project = seed.project;
                _values = ProjectFormValues(
                  project == null
                      ? const ProjectDraft(title: '')
                      : ProjectDraft.fromProject(project),
                );
              }

              return Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Padding(
                    padding: const EdgeInsets.all(20),
                    child: Row(
                      children: [
                        Expanded(
                          child: Text(
                            creating
                                ? text(
                                    context,
                                    'Projekt erstellen',
                                    'Create project',
                                  )
                                : text(
                                    context,
                                    'Projekt bearbeiten',
                                    'Edit project',
                                  ),
                            style: colors.heading,
                          ),
                        ),
                        SsIconButton(
                          icon: 'x',
                          label: text(context, 'Schließen', 'Close'),
                          onPressed: _busy
                              ? null
                              : () {
                                  Navigator.of(context).pop();
                                },

                        ),
                      ],
                    ),
                  ),
                  Container(height: 1, color: colors.border),
                  Flexible(
                    child: SingleChildScrollView(
                      padding: const EdgeInsets.all(20),
                      child: !allowed
                          ? Text(
                              text(
                                context,
                                'Keine Berechtigung',
                                'No permission',
                              ),
                            )
                          : Column(
                              crossAxisAlignment: CrossAxisAlignment.stretch,
                              children: [
                                if (_error != null) _message(_error!),
                                if (snapshot.hasError) ...[
                                  _message(snapshot.error!),
                                  SsButton(
                                    kind: SsButtonKind.secondary,
                                    onPressed: () {
                                      setState(() {
                                        _seed = _load();
                                      });

                                    },

                                    child: Text(
                                      text(context, 'Erneut laden', 'Reload'),
                                    ),
                                  ),
                                ] else if (reviewing)
                                  _pendingBody(pending)
                                else if (seed == null)
                                  const Center(child: SsSpinner())
                                else
                                  Form(
                                    key: _form,
                                    child: ProjectFormFields(
                                      values: _values!,
                                      access: widget.access,
                                      customer: seed.customer,
                                      leader: seed.leader,
                                      enabled: !_busy,
                                    ),
                                  ),
                              ],
                            ),
                    ),
                  ),
                  Container(height: 1, color: colors.border),
                  Padding(
                    padding: const EdgeInsets.all(16),
                    child: Wrap(
                      alignment: WrapAlignment.end,
                      spacing: 12,
                      runSpacing: 12,
                      children: [
                        if (_busy) const SsSpinner(size: 20),
                        SsButton(
                          kind: SsButtonKind.secondary,
                          onPressed: _busy
                              ? null
                              : () {
                                  Navigator.of(context).pop();
                                },

                          child: Text(text(context, 'Abbrechen', 'Cancel')),
                        ),
                        if (ready)
                          SsButton(
                            onPressed: _busy
                                ? null
                                : () {
                                    unawaited(_save(seed));
                                  },

                            child: Text(
                              creating
                                  ? text(context, 'Erstellen', 'Create')
                                  : text(context, 'Speichern', 'Save'),
                            ),
                          ),
                      ],
                    ),
                  ),
                ],
              );
            },

          ),
        ),
      ),
    );
  }

}
