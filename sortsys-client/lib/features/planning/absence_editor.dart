import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

import '../../api/generated/models.g.dart' as models;
import '../../api/model.dart';
import '../../state/session_controller.dart';
import '../../ui/text.dart';
import 'absence_form_fields.dart';
import 'absence_receipt.dart';
import 'absence_write_coordinator.dart';
import 'planning_data.dart';
import 'secure_absence_receipts.dart';
import 'session_absence_access.dart';

Future<models.UsersVacationsListResultItem?> showAbsenceEditor(
  BuildContext context, {
  required PlanningViewData view,
}) async {
  final session = context.read<SessionController>();
  final binding = session.binding;
  final info = session.info;

  if (!session.authenticated || info == null || view.data.identity != binding) {
    throw StateError('STALE_PLANNING_SCOPE');
  }

  final canManage = info.can('manage:userVacations');
  var active = true;
  final access = SessionAbsenceAccess(
    session,
    isActive: () {
      return active &&
          session.binding == binding &&
          session.info?.can('manage:userVacations') == canManage;
    },
  );

  access.checkCurrent();

  final coordinator = AbsenceWriteCoordinator(
    access: access,
    receipts: SecureAbsenceReceipts(),
  );
  final themes = InheritedTheme.capture(
    from: context,
    to: Navigator.of(context, rootNavigator: true).context,
  );

  try {
    return await showGeneralDialog<models.UsersVacationsListResultItem>(
      context: context,
      barrierDismissible: false,
      pageBuilder: (routeContext, animation, secondaryAnimation) {
        return themes.wrap(
          AbsenceEditorDialog(
            coordinator: coordinator,
            data: view.data,
            currentUserId: info.userId,
            canManage: canManage,
            day: view.state.focusDay,
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

class AbsenceEditorDialog extends StatefulWidget {
  const AbsenceEditorDialog({
    super.key,
    required this.coordinator,
    required this.data,
    required this.currentUserId,
    required this.canManage,
    required this.day,
    this.scopeChanges,
    this.onDispose,
  });

  final AbsenceWriteCoordinator coordinator;
  final PlanningData data;
  final String currentUserId;
  final bool canManage;
  final DateTime day;
  final Listenable? scopeChanges;
  final VoidCallback? onDispose;

  @override
  State<AbsenceEditorDialog> createState() {
    return _AbsenceEditorDialogState();
  }
}

class _AbsenceEditorDialogState extends State<AbsenceEditorDialog> {
  final _form = GlobalKey<FormState>();
  late final AbsenceFormValues _values;
  late Future<AbsenceWriteReceipt?> _initial;
  AbsenceWriteReceipt? _pending;
  Object? _error;
  bool _busy = false;
  bool _review = false;
  bool _scopeChanged = false;
  bool _unsentCleared = false;

  AbsenceWriteCoordinator get _writer {
    return widget.coordinator;
  }

  @override
  void initState() {
    super.initState();
    _values = AbsenceFormValues(
      currentUserId: widget.currentUserId,
      canManage: widget.canManage,
      initialDay: widget.day,
    );

    widget.scopeChanges?.addListener(_scopeNotification);
    _initial = _loadInitial();
  }

  @override
  void dispose() {
    widget.scopeChanges?.removeListener(_scopeNotification);
    widget.onDispose?.call();
    _values.dispose();
    super.dispose();
  }

  void _checkOpen() {
    if (!mounted || _scopeChanged) {
      throw StateError('ABSENCE_EDITOR_CLOSED');
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

  Future<AbsenceWriteReceipt?> _loadInitial() async {
    _checkOpen();

    final receipt = await _writer.outstanding();

    _checkOpen();

    return receipt;
  }

  void _reload() {
    if (_busy || _review || _scopeChanged) {
      return;
    }

    setState(() {
      _error = null;
      _initial = _loadInitial();
    });
  }

  void _finish(models.UsersVacationsListResultItem record) {
    setState(() {
      _busy = false;
      _error = null;
    });

    Navigator.of(context).pop(record);
  }

  Future<void> _showFailure(Object error) async {
    if (!mounted) {
      return;
    }

    AbsenceWriteReceipt? pending;

    try {
      pending = await _writer.outstanding();
    } catch (_) {
      // A missing or unreadable journal must not enable another submission.
    }

    if (!mounted) {
      return;
    }

    setState(() {
      _busy = false;
      _error = error;
      _pending = pending;
      _review = true;
    });
  }

  Future<void> _save() async {
    if (_busy || _review || _scopeChanged) {
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
      final draft = _values.draft();

      final record = await _writer.save(draft);

      if (mounted) {
        _finish(record);
      }
    } catch (error) {
      await _showFailure(error);
    }
  }

  Future<void> _recover(AbsenceWriteReceipt receipt) async {
    final unknown = receipt.dispatching && receipt.acknowledgement == null;

    if (_busy || _scopeChanged || _unsentCleared || unknown) {
      return;
    }

    setState(() {
      _busy = true;
      _error = null;
    });

    try {
      final record = await _writer.recover(expectedNonce: receipt.nonce);

      if (!mounted) {
        return;
      }

      if (record != null) {
        _finish(record);

        return;
      }

      setState(() {
        _busy = false;
        _pending = null;
        _review = true;
        _unsentCleared = true;
      });
    } catch (error) {
      await _showFailure(error);
    }
  }

  String _receiptUser(AbsenceWriteReceipt receipt) {
    final id = receipt.input.userId.valueOrNull;

    for (final user in widget.data.users) {
      if (user.id == id) {
        return planningUserName(user);
      }
    }

    return id ?? '';
  }

  Widget _reviewContent(AbsenceWriteReceipt? receipt) {
    if (_unsentCleared) {
      return Text(
        text(
          context,
          'Der gespeicherte Antrag wurde nicht gesendet. Schließe dieses Fenster, '
              'bevor du eine weitere Abwesenheit eingibst.',
          'The stored request was not submitted. Close this window '
              'before entering another absence.',
        ),
      );
    }

    final unknown =
        receipt?.dispatching == true && receipt?.acknowledgement == null;
    final description = unknown
        ? text(
            context,
            'Für die Neuanlage fehlt eine bestätigte ID. Kläre den Vorgang '
                'anhand der Einsatzplanung. Der Vorgang bleibt gespeichert.',
            'The creation has no acknowledged ID. Check resource planning '
                'to resolve it. The operation remains stored.',
          )
        : text(
            context,
            'Der offene Vorgang muss geprüft werden. Die Prüfung liest '
                'bekannte Datensätze und sendet keine Abwesenheit erneut.',
            'The pending operation requires verification. Verification '
                'reads known records and does not resubmit an absence.',
          );

    if (receipt == null) {
      return Text(description);
    }

    final from = readRpcDate(receipt.input.from);
    final to = readRpcDate(receipt.input.to);
    final period = '${ssDateText(from)} – ${ssDateText(to)}';
    final summary = '${_receiptUser(receipt)} · $period';

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [Text(summary), const SizedBox(height: 12), Text(description)],
    );
  }

  Widget _formContent() {
    return Form(
      key: _form,
      child: AbsenceFormFields(
        values: _values,
        data: widget.data,
        identity: widget.data.identity,
        checkCurrent: _checkOpen,
        enabled: !_busy,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<AbsenceWriteReceipt?>(
      future: _initial,
      builder: (context, snapshot) {
        final ready = snapshot.connectionState == ConnectionState.done;
        final pending = _pending ?? snapshot.data;
        final reviewing = _review || pending != null;
        final canSave =
            ready &&
            !snapshot.hasError &&
            !reviewing &&
            !_busy &&
            !_scopeChanged;
        final canRecover =
            pending != null &&
            !_busy &&
            !_scopeChanged &&
            !_unsentCleared &&
            (pending.acknowledgement != null || !pending.dispatching);
        final error = _error ?? snapshot.error;
        Widget content;

        if (_scopeChanged) {
          content = Text(
            text(
              context,
              'Anmeldung oder Berechtigung wurde geändert. '
                  'Schließe dieses Fenster.',
              'The session or permission changed. Close this window.',
            ),
          );
        } else if (!ready) {
          content = SsSpinner(
            label: text(
              context,
              'Abwesenheit wird geladen …',
              'Loading absence …',
            ),
          );
        } else if (reviewing) {
          content = _reviewContent(pending);
        } else if (snapshot.hasError) {
          content = const SizedBox.shrink();
        } else {
          content = _formContent();
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
            if (ready && snapshot.hasError && !reviewing && !_scopeChanged)
              SsButton(
                kind: SsButtonKind.secondary,
                onPressed: _busy ? null : _reload,
                child: Text(text(context, 'Neu laden', 'Reload')),
              ),
            if (canRecover)
              SsButton(
                onPressed: () {
                  unawaited(_recover(pending));
                },
                child: Text(
                  pending.acknowledgement == null
                      ? text(
                          context,
                          'Ungesendeten Antrag verwerfen',
                          'Discard unsent request',
                        )
                      : text(context, 'Vorgang prüfen', 'Verify operation'),
                ),
              ),
            if (ready && !snapshot.hasError && !reviewing && !_scopeChanged)
              SsButton(
                onPressed: canSave
                    ? () {
                        unawaited(_save());
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
                  Semantics(
                    liveRegion: true,
                    child: Text(
                      text(
                        context,
                        'Der Vorgang konnte nicht abgeschlossen werden. '
                            'Prüfe den offenen Vorgang und die Einsatzplanung.',
                        'The operation could not be completed. '
                            'Check the pending operation and resource planning.',
                      ),
                    ),
                  ),
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
    final title = widget.canManage
        ? text(context, 'Abwesenheit eintragen', 'Add absence')
        : text(context, 'Abwesenheit beantragen', 'Request absence');

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
