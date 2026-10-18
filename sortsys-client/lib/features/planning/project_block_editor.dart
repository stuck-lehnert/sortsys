import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

import '../../api/generated/models.g.dart' as models;
import '../../state/session_controller.dart';
import '../../ui/text.dart';
import 'planning_data.dart';
import 'project_block_form_fields.dart';
import 'project_block_receipt.dart';
import 'project_block_review.dart';
import 'project_block_write_coordinator.dart';
import 'secure_project_block_receipts.dart';
import 'session_project_block_access.dart';

Future<ProjectBlockWriteResult?> showProjectBlockEditor(
  BuildContext context, {
  required PlanningViewData view,
  required models.ProjectsUnavailabilityListResultItem baseline,
}) async {
  final session = context.read<SessionController>();
  final binding = session.binding;
  final info = session.info;

  if (!session.authenticated ||
      info == null ||
      view.data.identity != binding ||
      !view.canViewAll ||
      !info.can('manage:projectDeployments')) {
    throw StateError('STALE_PLANNING_SCOPE');
  }

  final canDelete = info.can('delete:projectDeployments');
  var active = true;
  final access = SessionProjectBlockAccess(
    session,
    isActive: () {
      return active && session.binding == binding;
    },
  );
  final coordinator = ProjectBlockWriteCoordinator(
    access: access,
    receipts: SecureProjectBlockReceipts(),
  );
  final themes = InheritedTheme.capture(
    from: context,
    to: Navigator.of(context, rootNavigator: true).context,
  );

  void checkEditable() {
    access.checkUpdate();

    if (session.info?.can('view:projectDeployments') != true ||
        session.info?.can('delete:projectDeployments') != canDelete) {
      throw StateError('PROJECT_BLOCK_EDITOR_PERMISSION_CHANGED');
    }
  }

  checkEditable();

  try {
    return await showGeneralDialog<ProjectBlockWriteResult>(
      context: context,
      barrierDismissible: false,
      pageBuilder: (routeContext, animation, secondaryAnimation) {
        return themes.wrap(
          ProjectBlockEditorDialog(
            coordinator: coordinator,
            data: view.data,
            baseline: baseline,
            canDelete: canDelete,
            loadProject: access.initialProject,
            checkCurrent: checkEditable,
            scopeChanges: session,
            onDispose: () {
              active = false;
            },
          ),
        );
      },
    );
  } finally {
    active = false;
  }
}

class ProjectBlockEditorDialog extends StatefulWidget {
  const ProjectBlockEditorDialog({
    super.key,
    required this.coordinator,
    required this.data,
    required this.baseline,
    this.canDelete = false,
    this.loadProject,
    this.checkCurrent,
    this.scopeChanges,
    this.onDispose,
  });

  final ProjectBlockWriteCoordinator coordinator;
  final PlanningData data;
  final models.ProjectsUnavailabilityListResultItem baseline;
  final bool canDelete;
  final Future<models.Project> Function(String id)? loadProject;
  final VoidCallback? checkCurrent;
  final Listenable? scopeChanges;
  final VoidCallback? onDispose;

  @override
  State<ProjectBlockEditorDialog> createState() {
    return _ProjectBlockEditorDialogState();
  }
}

class _ProjectBlockEditorDialogState extends State<ProjectBlockEditorDialog> {
  final _form = GlobalKey<FormState>();
  final _ownedValues = <ProjectBlockFormValues>[];
  late Future<_ProjectBlockSeed> _initial;
  ProjectBlockReceipt? _pending;
  Object? _error;
  bool _busy = false;
  bool _review = false;
  bool _scopeChanged = false;
  bool _needsReload = false;

  ProjectBlockWriteCoordinator get _writer {
    return widget.coordinator;
  }

  @override
  void initState() {
    super.initState();
    widget.scopeChanges?.addListener(_scopeNotification);
    _initial = _load();
  }

  @override
  void dispose() {
    widget.scopeChanges?.removeListener(_scopeNotification);
    widget.onDispose?.call();

    for (final values in _ownedValues) {
      values.dispose();
    }

    super.dispose();
  }

  void _checkOpen() {
    if (!mounted || _scopeChanged) {
      throw StateError('PROJECT_BLOCK_EDITOR_CLOSED');
    }

    _writer.access.checkCurrent();
    final check = widget.checkCurrent;

    if (check == null) {
      _writer.access.checkUpdate();
    } else {
      check();
    }
  }

  void _scopeNotification() {
    if (!mounted || _scopeChanged) {
      return;
    }

    try {
      _checkOpen();
    } catch (_) {
      setState(() {
        _scopeChanged = true;
      });
    }
  }

  Future<_ProjectBlockSeed> _load() async {
    _checkOpen();

    final receipt = await _writer.outstanding();

    _checkOpen();

    if (receipt != null) {
      return _ProjectBlockSeed.pending(receipt);
    }

    final original = widget.baseline;
    final fresh = await _writer.access.getBlock(
      id: original.id,
      from: original.from,
      to: original.to,
    );

    _checkOpen();

    if (fresh == null) {
      throw const ProjectBlockWriteException(ProjectBlockWriteFailure.conflict);
    }

    models.Project? project;

    for (final candidate in widget.data.projects) {
      if (candidate.id == fresh.projectId) {
        project = candidate;

        break;
      }
    }

    final loader = widget.loadProject;

    if (project == null && loader != null) {
      project = await loader(fresh.projectId);
    }

    _checkOpen();

    if (project != null && project.id != fresh.projectId) {
      throw const FormatException('PROJECT_RESPONSE_ID_MISMATCH');
    }

    final values = ProjectBlockFormValues(
      from: fresh.from,
      to: fresh.to,
      project: project,
      reason: fresh.reason,
      note: fresh.note,
    );

    // Keep earlier form controllers alive until their widgets leave the route.
    _ownedValues.add(values);

    return _ProjectBlockSeed.form(fresh, values);
  }

  void _reload() {
    if (_busy || _review || _scopeChanged) {
      return;
    }

    setState(() {
      _error = null;
      _needsReload = false;
      _initial = _load();
    });
  }

  Future<void> _showFailure(Object error) async {
    if (!mounted) {
      return;
    }

    ProjectBlockReceipt? pending;
    var readable = false;

    try {
      pending = await _writer.outstanding();
      readable = true;
    } catch (_) {
      // Unreadable intent must not enable another business write.
    }

    if (!mounted) {
      return;
    }

    _scopeNotification();

    final conflict =
        error is ProjectBlockWriteException &&
        error.failure == ProjectBlockWriteFailure.conflict &&
        readable &&
        pending == null;

    setState(() {
      _busy = false;
      _error = error;
      _pending = pending;
      _needsReload = conflict;
      _review = !conflict;
    });
  }

  Future<void> _run(
    Future<ProjectBlockWriteResult> Function() operation,
  ) async {
    if (_busy || _scopeChanged) {
      return;
    }

    FocusScope.of(context).unfocus();

    setState(() {
      _busy = true;
      _error = null;
    });

    try {
      _checkOpen();

      final result = await operation();

      if (!mounted) {
        return;
      }

      _checkOpen();

      setState(() {
        _busy = false;
      });

      Navigator.of(context).pop(result);
    } catch (error) {
      await _showFailure(error);
    }
  }

  Future<void> _save(
    models.ProjectsUnavailabilityListResultItem baseline,
    ProjectBlockFormValues values,
  ) async {
    if (_busy || _review || _needsReload || _scopeChanged) {
      return;
    }

    if (_form.currentState?.validate() != true) {
      return;
    }

    await _run(() {
      return _writer.save(values.draft(), baseline);
    });
  }

  Future<void> _remove(
    models.ProjectsUnavailabilityListResultItem baseline,
  ) async {
    if (!widget.canDelete ||
        _busy ||
        _review ||
        _needsReload ||
        _scopeChanged) {
      return;
    }

    await _run(() {
      return _writer.remove(baseline);
    });
  }

  Future<void> _recover(ProjectBlockReceipt receipt) async {
    if (receipt.kind == ProjectBlockWriteKind.delete && receipt.dispatching) {
      return;
    }

    await _run(() {
      return _writer.recover(expectedNonce: receipt.nonce);
    });
  }

  Widget _fields(
    models.ProjectsUnavailabilityListResultItem baseline,
    ProjectBlockFormValues values,
  ) {
    return Form(
      key: _form,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          ProjectBlockFormFields(
            key: ObjectKey(values),
            values: values,
            data: widget.data,
            identity: (widget.data.identity, values),
            checkCurrent: _checkOpen,
            enabled: !_busy && !_needsReload,
          ),
          if (widget.canDelete) ...[
            const SizedBox(height: 12),
            Align(
              alignment: Alignment.centerLeft,
              child: SsButton(
                kind: SsButtonKind.ghost,
                onPressed: _busy || _needsReload
                    ? null
                    : () {
                        unawaited(_remove(baseline));
                      },
                child: Text(text(context, 'Sperre löschen', 'Delete block')),
              ),
            ),
          ],
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<_ProjectBlockSeed>(
      future: _initial,
      builder: (context, snapshot) {
        final ready = snapshot.connectionState == ConnectionState.done;
        final seed = snapshot.data;
        final pending = _review ? _pending : seed?.receipt;
        final reviewing = _review || pending != null;
        final baseline = seed?.baseline;
        final values = seed?.values;
        final error = _error ?? snapshot.error;
        final formReady =
            ready &&
            !snapshot.hasError &&
            !reviewing &&
            !_scopeChanged &&
            baseline != null &&
            values != null;
        Widget content;

        if (_scopeChanged) {
          content = Text(
            text(
              context,
              'Anmeldung oder Berechtigung wurde geändert. Schließe dieses Fenster.',
              'The session or permission changed. Close this window.',
            ),
          );
        } else if (!ready) {
          content = SsSpinner(
            label: text(
              context,
              'Unterbrechung wird geladen …',
              'Loading interruption …',
            ),
          );
        } else if (reviewing) {
          content = ProjectBlockReview(
            receipt: pending,
            busy: _busy,
            onRecover: () {
              if (pending != null) {
                unawaited(_recover(pending));
              }
            },
          );
        } else if (baseline != null && values != null && !snapshot.hasError) {
          content = _fields(baseline, values);
        } else {
          content = const SizedBox.shrink();
        }

        final footer = Wrap(
          alignment: WrapAlignment.end,
          spacing: 8,
          runSpacing: 8,
          children: [
            if (_busy)
              SsSpinner(
                label: text(
                  context,
                  'Vorgang läuft …',
                  'Operation in progress …',
                ),
              ),
            SsButton(
              kind: SsButtonKind.ghost,
              onPressed: _busy
                  ? null
                  : () {
                      Navigator.of(context).pop();
                    },
              child: Text(text(context, 'Schließen', 'Close')),
            ),
            if (ready &&
                !reviewing &&
                !_scopeChanged &&
                (snapshot.hasError || _needsReload))
              SsButton(
                kind: SsButtonKind.secondary,
                onPressed: _busy ? null : _reload,
                child: Text(text(context, 'Neu laden', 'Reload')),
              ),
            if (formReady)
              SsButton(
                onPressed: _busy || _needsReload
                    ? null
                    : () {
                        unawaited(_save(baseline, values));
                      },
                child: Text(text(context, 'Speichern', 'Save')),
              ),
          ],
        );

        final body = Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (error != null) ...[
              Semantics(
                liveRegion: true,
                child: Text(
                  _needsReload
                      ? text(
                          context,
                          'Die Unterbrechung wurde geändert oder ist nicht mehr '
                              'im geladenen Zeitraum. Lade die Daten neu.',
                          'The interruption changed or is no longer in the loaded '
                              'range. Reload the data.',
                        )
                      : text(
                          context,
                          'Der Vorgang konnte nicht abgeschlossen werden.',
                          'The operation could not be completed.',
                        ),
                ),
              ),
              const SizedBox(height: 12),
            ],
            content,
          ],
        );

        return PopScope(canPop: !_busy, child: _frame(body, footer));
      },
    );
  }

  Widget _frame(Widget body, Widget footer) {
    final theme = SsTheme.of(context);
    final size = MediaQuery.sizeOf(context);

    return Dialog(
      backgroundColor: theme.surface,
      insetPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 16),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.zero,
        side: BorderSide(color: theme.border),
      ),
      child: ConstrainedBox(
        constraints: BoxConstraints(
          maxWidth: 768,
          maxHeight: size.height * 0.9,
        ),
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: LayoutBuilder(
            builder: (context, constraints) {
              final scrollAll = constraints.maxHeight < 280;
              final column = Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text(
                    text(
                      context,
                      'Unterbrechung bearbeiten',
                      'Edit interruption',
                    ),
                    style: theme.body.copyWith(
                      fontSize: 18,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(height: 12),
                  if (scrollAll)
                    body
                  else
                    Flexible(child: SingleChildScrollView(child: body)),
                  const SizedBox(height: 12),
                  footer,
                ],
              );

              if (scrollAll) {
                return SingleChildScrollView(child: column);
              }

              return column;
            },
          ),
        ),
      ),
    );
  }
}

final class _ProjectBlockSeed {
  const _ProjectBlockSeed.pending(this.receipt)
    : baseline = null,
      values = null;

  const _ProjectBlockSeed.form(this.baseline, this.values) : receipt = null;

  final ProjectBlockReceipt? receipt;
  final models.ProjectsUnavailabilityListResultItem? baseline;
  final ProjectBlockFormValues? values;
}
