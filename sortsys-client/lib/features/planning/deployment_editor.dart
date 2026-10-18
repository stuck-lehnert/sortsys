import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

import '../../api/generated/models.g.dart' as models;
import '../../state/session_controller.dart';
import '../../ui/text.dart';
import 'deployment_delete_coordinator.dart';
import 'deployment_delete_receipt.dart';
import 'deployment_delete_review.dart';
import 'deployment_form_fields.dart';
import 'deployment_receipt.dart';
import 'deployment_write_coordinator.dart';
import 'planning_board.dart';
import 'planning_data.dart';
import 'secure_deployment_delete_receipts.dart';
import 'secure_deployment_receipts.dart';
import 'session_deployment_access.dart';
import 'session_deployment_delete_access.dart';

Future<DeploymentWriteResult?> showDeploymentEditor(
  BuildContext context, {
  required PlanningViewData view,
  PlanningPreset? preset,
  models.Deployment? deployment,
}) async {
  final session = context.read<SessionController>();
  final binding = session.binding;
  final canDelete = session.info?.can('delete:projectDeployments') == true;

  if (view.data.identity != binding) {
    throw StateError('STALE_PLANNING_SCOPE');
  }

  var active = true;
  final access = SessionDeploymentAccess(
    session,
    isActive: () {
      return active &&
          session.binding == binding &&
          (session.info?.can('delete:projectDeployments') == true) == canDelete;
    },
  );

  access.checkCurrent();

  final writeReceipts = SecureDeploymentReceipts();
  final deleteReceipts = SecureDeploymentDeleteReceipts();
  final deleteAccess = SessionDeploymentDeleteAccess(
    session,
    isActive: () {
      return active && session.binding == binding;
    },
  );

  if (deleteAccess.scope != access.scope) {
    throw StateError('DEPLOYMENT_DELETE_SCOPE_MISMATCH');
  }

  final deletion = DeploymentDeleteCoordinator(
    access: deleteAccess,
    receipts: deleteReceipts,
    pendingWrites: writeReceipts,
  );
  final coordinator = DeploymentWriteCoordinator(
    access: access,
    receipts: DeletionGuardedDeploymentReceipts(
      writes: writeReceipts,
      deletions: deleteReceipts,
    ),
  );
  final themes = InheritedTheme.capture(
    from: context,
    to: Navigator.of(context, rootNavigator: true).context,
  );

  try {
    return await showGeneralDialog<DeploymentWriteResult>(
      context: context,
      barrierDismissible: false,
      pageBuilder: (routeContext, animation, secondaryAnimation) {
        return themes.wrap(
          DeploymentEditorDialog(
            coordinator: coordinator,
            deleteCoordinator: deletion,
            canDelete: canDelete,
            view: view,
            preset: preset,
            deployment: deployment,
            loadUser: access.initialUser,
            loadProject: access.initialProject,
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

class DeploymentEditorDialog extends StatefulWidget {
  const DeploymentEditorDialog({
    super.key,
    required this.coordinator,
    required this.view,
    required this.loadUser,
    required this.loadProject,
    this.preset,
    this.deployment,
    this.scopeChanges,
    this.onDispose,
    this.deleteCoordinator,
    this.canDelete = false,
  });

  final DeploymentWriteCoordinator coordinator;
  final PlanningViewData view;
  final Future<models.User?> Function(String? id) loadUser;
  final Future<models.Project?> Function(String? id) loadProject;
  final PlanningPreset? preset;
  final models.Deployment? deployment;
  final Listenable? scopeChanges;
  final VoidCallback? onDispose;
  final DeploymentDeleteCoordinator? deleteCoordinator;
  final bool canDelete;

  @override
  State<DeploymentEditorDialog> createState() {
    return _DeploymentEditorDialogState();
  }
}

class _DeploymentEditorDialogState extends State<DeploymentEditorDialog> {
  final _form = GlobalKey<FormState>();
  late Future<_DeploymentSeed> _seed;
  DeploymentFormValues? _values;
  DeploymentWriteReceipt? _pending;
  DeploymentDeleteReceipt? _pendingDeletion;
  DeploymentWriteResult? _partial;
  Object? _error;
  bool _busy = false;
  bool _review = false;
  bool _reviewDeletion = false;
  bool _needsReload = false;
  bool _scopeChanged = false;

  DeploymentWriteCoordinator get _writer {
    return widget.coordinator;
  }

  @override
  void initState() {
    super.initState();
    widget.scopeChanges?.addListener(_scopeNotification);
    _seed = _load();
  }

  @override
  void dispose() {
    widget.scopeChanges?.removeListener(_scopeNotification);
    widget.onDispose?.call();
    _values?.dispose();
    super.dispose();
  }

  void _checkOpen() {
    if (!mounted || _scopeChanged) {
      throw StateError('DEPLOYMENT_EDITOR_CLOSED');
    }

    _writer.access.checkCurrent();
  }

  void _scopeNotification() {
    if (!mounted || _scopeChanged) {
      return;
    }

    try {
      _writer.access.checkCurrent();
    } catch (_) {
      setState(() {
        _scopeChanged = true;
      });
    }
  }

  Future<models.User?> _selectedUser(String? id) async {
    if (id == null) {
      return null;
    }

    for (final user in widget.view.data.users) {
      if (user.id == id) {
        return user;
      }
    }

    try {
      final user = await widget.loadUser(id);
      _checkOpen();

      return user;
    } catch (_) {
      _checkOpen();

      return null;
    }
  }

  Future<models.Project?> _selectedProject(String? id) async {
    if (id == null) {
      return null;
    }

    for (final project in widget.view.data.projects) {
      if (project.id == id) {
        return project;
      }
    }

    try {
      final project = await widget.loadProject(id);
      _checkOpen();

      return project;
    } catch (_) {
      _checkOpen();

      return null;
    }
  }

  Future<_DeploymentSeed> _load() async {
    _checkOpen();

    final deletion = widget.deleteCoordinator;

    if (deletion != null) {
      final pendingDeletion = await deletion.outstanding();

      _checkOpen();

      if (pendingDeletion != null) {
        return _DeploymentSeed(deletion: pendingDeletion);
      }
    }

    final pending = await _writer.outstanding();
    _checkOpen();

    if (pending != null) {
      return _DeploymentSeed(receipt: pending);
    }

    final original = widget.deployment;
    models.Deployment? baseline;

    if (original != null) {
      baseline = await _writer.access.getDeployment(
        original.id,
        from: original.from,
        to: original.to,
      );
      _checkOpen();

      if (baseline == null) {
        throw const DeploymentWriteException(DeploymentWriteFailure.conflict);
      }
    }

    final userId = baseline?.userId ?? widget.preset?.userId;
    final projectId = baseline?.projectId ?? widget.preset?.projectId;
    final user = await _selectedUser(userId);
    final project = await _selectedProject(projectId);
    _checkOpen();

    return _DeploymentSeed(
      baseline: baseline,
      user: user,
      project: project,
      userUnavailable: userId != null && user == null,
      projectUnavailable: projectId != null && project == null,
    );
  }

  DeploymentFormValues _formValues(_DeploymentSeed seed) {
    final day = widget.preset?.day ?? widget.view.state.focusDay;
    final baseline = seed.baseline;

    return DeploymentFormValues(
      from: baseline?.from ?? DateTime(day.year, day.month, day.day, 7),
      to: baseline?.to ?? DateTime(day.year, day.month, day.day, 16),
      users: [?seed.user],
      project: seed.project,
      note: baseline?.note,
    );
  }

  void _reload() {
    if (_busy || _review || _scopeChanged) {
      return;
    }

    final previous = _values;

    setState(() {
      _values = null;
      _error = null;
      _needsReload = false;
      _seed = _load();
    });
    WidgetsBinding.instance.addPostFrameCallback((_) {
      previous?.dispose();
    });
  }

  void _finish(DeploymentWriteResult result) {
    setState(() {
      _busy = false;
      _error = null;
    });

    if (result.complete) {
      Navigator.of(context).pop(result);

      return;
    }

    setState(() {
      _partial = result;
      _pending = null;
      _review = true;
    });
  }

  Future<void> _save(_DeploymentSeed seed) async {
    final values = _values;

    if (values == null || _busy || _review || _needsReload || _scopeChanged) {
      return;
    }

    if (_form.currentState?.validate() != true) {
      return;
    }

    FocusScope.of(context).unfocus();
    setState(() {
      _busy = true;
      _error = null;
    });

    try {
      final draft = values.draft();
      final result = await _writer.save(draft, baseline: seed.baseline);

      if (mounted) {
        _finish(result);
      }
    } catch (error) {
      DeploymentWriteReceipt? pending;
      DeploymentDeleteReceipt? pendingDeletion;
      var receiptReadFailed = false;

      try {
        final deletion = widget.deleteCoordinator;

        if (deletion != null) {
          pendingDeletion = await deletion.outstanding();
        }

        if (pendingDeletion == null) {
          pending = await _writer.outstanding();
        }
      } catch (_) {
        receiptReadFailed = true;
      }

      if (!mounted) {
        return;
      }

      final failure = error is DeploymentWriteException ? error.failure : null;

      setState(() {
        _busy = false;
        _error = error;
        _pending = pending;
        _pendingDeletion = pendingDeletion;
        _reviewDeletion = pendingDeletion != null;
        _review =
            pending != null ||
            pendingDeletion != null ||
            receiptReadFailed ||
            failure == DeploymentWriteFailure.uncertain;
        _needsReload = failure == DeploymentWriteFailure.conflict;
      });
    }
  }

  Future<void> _delete(models.Deployment baseline) async {
    final deletion = widget.deleteCoordinator;

    if (deletion == null ||
        _busy ||
        _review ||
        _needsReload ||
        _scopeChanged ||
        !widget.canDelete) {
      return;
    }

    await _runDeletion(() {
      return deletion.remove(baseline);
    });
  }

  Future<void> _recoverDeletion(DeploymentDeleteReceipt receipt) async {
    final deletion = widget.deleteCoordinator;

    if (deletion == null) {
      return;
    }

    await _runDeletion(() {
      return deletion.recover(expectedNonce: receipt.nonce);
    });
  }

  Future<void> _runDeletion(
    Future<DeploymentDeleteResult> Function() operation,
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

      await operation();

      if (!mounted) {
        return;
      }

      _checkOpen();
      setState(() {
        _busy = false;
      });
      Navigator.of(context).pop();
    } catch (error) {
      DeploymentDeleteReceipt? pending;
      var receiptReadFailed = false;

      try {
        pending = await widget.deleteCoordinator!.outstanding();
      } catch (_) {
        receiptReadFailed = true;
      }

      if (!mounted) {
        return;
      }

      final failure = error is DeploymentDeleteException ? error.failure : null;

      setState(() {
        _busy = false;
        _error = error;
        _pendingDeletion = pending;
        _reviewDeletion =
            pending != null ||
            receiptReadFailed ||
            failure == DeploymentDeleteFailure.uncertain;
        _review = _reviewDeletion;
        _needsReload = failure == DeploymentDeleteFailure.conflict;
      });
    }
  }

  Future<void> _recover() async {
    if (_busy || _scopeChanged) {
      return;
    }

    setState(() {
      _busy = true;
      _error = null;
    });

    try {
      final result = await _writer.recover();

      if (mounted) {
        _finish(result);
      }
    } catch (error) {
      if (mounted) {
        setState(() {
          _busy = false;
          _error = error;
          _review = true;
        });
      }
    }
  }

  String _errorText(Object error) {
    if (error is DeploymentDeleteException) {
      final failure = switch (error.failure) {
        DeploymentDeleteFailure.outstanding =>
          DeploymentWriteFailure.outstanding,
        DeploymentDeleteFailure.conflict => DeploymentWriteFailure.conflict,
        DeploymentDeleteFailure.uncertain => DeploymentWriteFailure.uncertain,
      };

      return _errorText(DeploymentWriteException(failure, cause: error.cause));
    }

    if (error is DeploymentWriteException) {
      switch (error.failure) {
        case DeploymentWriteFailure.conflict:
          return text(
            context,
            'Der Einsatz wurde geändert oder ist im bisherigen Zeitraum nicht mehr verfügbar. Lade die Planung neu.',
            'The assignment changed or is no longer available in its previous period. Reload resource planning.',
          );
        case DeploymentWriteFailure.outstanding:
          return text(
            context,
            'Für diese Anmeldung besteht ein offener Einsatzvorgang.',
            'This account has a pending assignment operation.',
          );
        case DeploymentWriteFailure.uncertain:
          return text(
            context,
            'Der Ausgang des Vorgangs ist unklar. Prüfe den offenen Vorgang und die Einsatzplanung.',
            'The operation outcome is uncertain. Check the pending operation and resource planning.',
          );
      }
    }

    return text(
      context,
      'Der Vorgang konnte nicht abgeschlossen werden.',
      'The operation could not be completed.',
    );
  }

  Widget _reviewContent(DeploymentWriteReceipt? receipt) {
    final partial = _partial;

    if (partial != null) {
      return Text(
        text(
          context,
          '${partial.ids.length} Einsätze bestätigt; ${partial.unsubmitted.length} Einsätze wurden nicht gesendet. Prüfe die Einsatzplanung vor weiteren Eingaben.',
          '${partial.ids.length} assignments confirmed; ${partial.unsubmitted.length} assignments were not submitted. Check resource planning before entering further assignments.',
        ),
      );
    }

    final unknownCreate =
        receipt != null && receipt.updateInput == null && receipt.dispatching;

    return Text(
      unknownCreate
          ? text(
              context,
              'Für eine Neuanlage fehlt die bestätigte ID. Kläre den Vorgang anhand der Einsatzplanung. Der Vorgang bleibt gespeichert.',
              'A creation has no acknowledged ID. Check the assignment in resource planning. The operation remains stored.',
            )
          : text(
              context,
              'Ein offener Einsatzvorgang muss geprüft werden. Die Prüfung liest bekannte Datensätze und sendet keine Einsätze erneut.',
              'A pending assignment operation requires verification. Verification reads known records and does not resubmit assignments.',
            ),
    );
  }

  Widget _formContent(_DeploymentSeed seed) {
    final values = _values ??= _formValues(seed);
    final baseline = seed.baseline;

    return Form(
      key: _form,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (seed.userUnavailable || seed.projectUnavailable) ...[
            Text(
              text(
                context,
                'Eine Vorauswahl konnte nicht geladen werden. Wähle die Person und das Projekt aus.',
                'A preset could not be loaded. Select the employee and project.',
              ),
            ),
            const SizedBox(height: 12),
          ],
          DeploymentFormFields(
            values: values,
            data: widget.view.data,
            identity: (widget.view.data.identity, seed.baseline?.id),
            checkCurrent: _checkOpen,
            editing: seed.baseline != null,
            enabled: !_busy,
          ),
          if (baseline != null &&
              widget.canDelete &&
              widget.deleteCoordinator != null) ...[
            const SizedBox(height: 12),
            Align(
              alignment: Alignment.centerLeft,
              child: SsButton(
                kind: SsButtonKind.ghost,
                onPressed: _busy || _needsReload
                    ? null
                    : () {
                        unawaited(_delete(baseline));
                      },
                child: Text(
                  text(context, 'Einsatz löschen', 'Delete assignment'),
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<_DeploymentSeed>(
      future: _seed,
      builder: (context, snapshot) {
        final ready = snapshot.connectionState == ConnectionState.done;
        final seed = ready ? snapshot.data : null;
        final pending = _pending ?? seed?.receipt;
        final pendingDeletion = _pendingDeletion ?? seed?.deletion;
        final reviewingDeletion = _reviewDeletion || pendingDeletion != null;
        final reviewing = _review || pending != null || reviewingDeletion;
        final unknownCreate =
            pending != null &&
            pending.updateInput == null &&
            pending.dispatching;
        final canSave =
            seed != null &&
            !reviewing &&
            !_busy &&
            !_needsReload &&
            !_scopeChanged &&
            _partial == null;
        final canRecover =
            reviewing &&
            !reviewingDeletion &&
            pending != null &&
            !unknownCreate &&
            !_busy &&
            !_scopeChanged &&
            _partial == null;
        final error = _error ?? snapshot.error;
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
              'Einsatz wird geladen …',
              'Loading assignment …',
            ),
          );
        } else if (reviewingDeletion) {
          content = DeploymentDeleteReview(
            receipt: pendingDeletion,
            busy: _busy,
            onRecover: () {
              if (pendingDeletion == null) {
                return;
              }

              unawaited(_recoverDeletion(pendingDeletion));
            },
          );
        } else if (reviewing || _partial != null) {
          content = _reviewContent(pending);
        } else if (seed != null) {
          content = _formContent(seed);
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
                      Navigator.of(context).pop(_partial);
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
            if (canRecover)
              SsButton(
                onPressed: () {
                  unawaited(_recover());
                },
                child: Text(
                  text(context, 'Vorgang prüfen', 'Verify operation'),
                ),
              ),
            if (seed != null && !reviewing && _partial == null)
              SsButton(
                onPressed: canSave
                    ? () {
                        unawaited(_save(seed));
                      }
                    : null,
                child: Text(text(context, 'Speichern', 'Save')),
              ),
          ],
        );

        return PopScope(
          canPop: !_busy,
          child: _frame(
            content: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                if (error != null) ...[
                  Semantics(liveRegion: true, child: Text(_errorText(error))),
                  const SizedBox(height: 12),
                ],
                content,
              ],
            ),
            footer: footer,
          ),
        );
      },
    );
  }

  Widget _frame({required Widget content, required Widget footer}) {
    final colors = SsTheme.of(context);
    final size = MediaQuery.sizeOf(context);
    final title = widget.deployment == null
        ? text(context, 'Einsatz hinzufügen', 'Add assignment')
        : text(context, 'Einsatz bearbeiten', 'Edit assignment');

    return Dialog(
      backgroundColor: colors.surface,
      insetPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 16),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.zero,
        side: BorderSide(color: colors.border),
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
                    title,
                    style: colors.body.copyWith(
                      fontSize: 18,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(height: 12),
                  if (scrollAll)
                    content
                  else
                    Flexible(child: SingleChildScrollView(child: content)),
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

final class _DeploymentSeed {
  const _DeploymentSeed({
    this.receipt,
    this.deletion,
    this.baseline,
    this.user,
    this.project,
    this.userUnavailable = false,
    this.projectUnavailable = false,
  });

  final DeploymentWriteReceipt? receipt;
  final DeploymentDeleteReceipt? deletion;
  final models.Deployment? baseline;
  final models.User? user;
  final models.Project? project;
  final bool userUnavailable;
  final bool projectUnavailable;
}
