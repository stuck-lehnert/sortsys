import 'dart:async';

import 'package:flutter/material.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

import '../../api/generated/models.g.dart' as models;
import '../../ui/text.dart';
import 'vendor_delete_coordinator.dart';
import 'vendor_receipt.dart';

Future<String?> showVendorDeleteDialog(
  BuildContext context, {
  required models.ProductVendor vendor,
  required VendorDeleteCoordinator coordinator,
  required Object queryIdentity,
  required bool Function() isCurrent,
  required bool Function() canDelete,
  Listenable? changes,
}) {
  final colors = SsTheme.of(context);

  Widget buildDialog(BuildContext dialogContext) {
    return SsTheme(
      colors: colors,
      child: VendorDeleteDialog(
        vendor: vendor,
        coordinator: coordinator,
        queryIdentity: queryIdentity,
        isCurrent: isCurrent,
        enabled: canDelete(),
        onDeleted: (id) {
          if (isCurrent() && id == vendor.id) {
            Navigator.of(dialogContext).pop(id);
          }
        },
        onCancel: () {
          Navigator.of(dialogContext).pop();
        },
      ),
    );
  }

  return showDialog<String>(
    context: context,
    barrierDismissible: false,
    builder: (dialogContext) {
      if (changes == null) {
        return buildDialog(dialogContext);
      }

      return ListenableBuilder(
        listenable: changes,
        builder: (context, child) {
          return buildDialog(context);
        },
      );
    },
  );
}

class VendorDeleteDialog extends StatefulWidget {
  const VendorDeleteDialog({
    super.key,
    required this.vendor,
    required this.coordinator,
    required this.queryIdentity,
    required this.isCurrent,
    required this.onDeleted,
    required this.onCancel,
    this.enabled = true,
  });

  final models.ProductVendor vendor;
  final VendorDeleteCoordinator coordinator;
  final Object queryIdentity;
  final bool Function() isCurrent;
  final ValueChanged<String> onDeleted;
  final VoidCallback onCancel;
  final bool enabled;

  @override
  State<VendorDeleteDialog> createState() {
    return _VendorDeleteDialogState();
  }
}

class _VendorDeleteDialogState extends State<VendorDeleteDialog> {
  final _form = GlobalKey<FormState>();
  int _epoch = 0;
  bool _retired = false;
  bool _checking = true;
  bool _journalKnown = false;
  bool _busy = false;
  bool _completed = false;
  bool _understood = false;
  bool _uncertain = false;
  bool _conflict = false;
  bool _error = false;
  VendorWriteReceipt? _receipt;

  @override
  void initState() {
    super.initState();

    unawaited(_loadReceipt());
  }

  @override
  void didUpdateWidget(covariant VendorDeleteDialog oldWidget) {
    super.didUpdateWidget(oldWidget);

    if (widget.queryIdentity != oldWidget.queryIdentity ||
        widget.vendor != oldWidget.vendor ||
        widget.coordinator != oldWidget.coordinator) {
      // A replacement owner must open its own dialog and inspect its journal.
      _epoch++;
      _retired = true;
      _busy = false;
    }
  }

  @override
  void dispose() {
    _epoch++;

    super.dispose();
  }

  bool _alive(int epoch) {
    return mounted && epoch == _epoch;
  }

  bool get _current {
    if (_retired || !widget.isCurrent()) {
      return false;
    }

    try {
      widget.coordinator.access.checkCurrent();

      return true;
    } catch (_) {
      return false;
    }
  }

  bool get _ready {
    return _current &&
        widget.enabled &&
        _journalKnown &&
        !_checking &&
        !_busy &&
        !_completed &&
        !_uncertain &&
        !_conflict &&
        _receipt == null;
  }

  bool _canRecover(VendorWriteReceipt receipt) {
    if (receipt.deleteInput?.id != widget.vendor.id) {
      return false;
    }

    return (!receipt.dispatching && !receipt.acknowledged) ||
        receipt.deletionConfirmed;
  }

  Future<void> _loadReceipt({bool keepError = false}) async {
    final epoch = _epoch;

    try {
      final receipt = await widget.coordinator.outstanding();

      if (!_alive(epoch) || !_current) {
        return;
      }

      setState(() {
        _receipt = receipt;
        _journalKnown = true;
        _checking = false;

        if (!keepError) {
          _error = false;
        }
      });
    } catch (_) {
      if (!_alive(epoch)) {
        return;
      }

      setState(() {
        _journalKnown = false;
        _checking = false;
        _error = true;
      });
    }
  }

  Future<void> _run({required bool recover}) async {
    final receipt = _receipt;

    if (!_current || _busy || _checking || _completed) {
      return;
    }

    if (recover) {
      if (receipt == null || !_canRecover(receipt)) {
        return;
      }
    } else if (!_ready || _form.currentState?.validate() != true) {
      return;
    }

    final epoch = _epoch;
    final coordinator = widget.coordinator;
    String? deletedId;

    setState(() {
      _busy = true;
      _error = false;
    });

    try {
      if (recover) {
        deletedId = await coordinator.recover(expectedNonce: receipt!.nonce);
      } else {
        deletedId = await coordinator.delete(
          baseline: widget.vendor,
          confirmed: _understood,
        );
      }

      if (_alive(epoch) && _current && deletedId == null) {
        _understood = false;
        _uncertain = false;

        await _loadReceipt();
      }
    } catch (error) {
      if (!_alive(epoch)) {
        return;
      }

      if (error is VendorDeleteException &&
          error.failure == VendorDeleteFailure.cleanup &&
          error.confirmedVendorId == widget.vendor.id) {
        deletedId = error.confirmedVendorId;
      } else {
        _error = true;

        if (error is VendorDeleteException) {
          _uncertain = error.failure == VendorDeleteFailure.uncertain;
          _conflict = error.failure == VendorDeleteFailure.conflict;
        }

        if (_current) {
          await _loadReceipt(keepError: true);
        }
      }
    } finally {
      if (_alive(epoch)) {
        setState(() {
          _busy = false;
          _completed = deletedId != null;
        });
      }
    }

    // Caller/navigation faults cannot turn a genuine acknowledgement into retry.
    if (_alive(epoch) && _current && deletedId == widget.vendor.id) {
      widget.onDeleted(deletedId!);
    }
  }

  Widget _confirmation() {
    final colors = SsTheme.of(context);

    return Form(
      key: _form,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text.rich(
            TextSpan(
              children: [
                TextSpan(
                  text: text(
                    context,
                    'Alle mit diesem Händler in Verbindung stehenden Daten '
                        'werden damit ebenfalls gelöscht. ',
                    'All data associated with this vendor will also be deleted. ',
                  ),
                ),
                TextSpan(
                  text: text(
                    context,
                    'Diese Aktion kann nicht rückgängig gemacht werden.',
                    'This action cannot be undone.',
                  ),
                  style: const TextStyle(fontWeight: FontWeight.w700),
                ),
              ],
            ),
            style: colors.body.copyWith(color: colors.secondaryText),
          ),
          const SizedBox(height: 16),
          SsCheckboxField(
            initialValue: _understood,
            enabled: _ready,
            label: text(
              context,
              'Ich habe verstanden, dass diese Aktion nicht rückgängig '
                  'gemacht werden kann.',
              'I understand that this action cannot be undone.',
            ),
            validator: (value) {
              if (value != true) {
                return text(context, 'Pflichtfeld', 'Required field');
              }

              return null;
            },
            onChanged: (value) {
              setState(() {
                _understood = value;
              });
            },
          ),
        ],
      ),
    );
  }

  Widget _pending(VendorWriteReceipt receipt) {
    if (receipt.deleteInput?.id != widget.vendor.id) {
      return Text(
        text(
          context,
          'Ein anderer Vorgang ist noch offen. Schließen Sie diesen Dialog '
              'und klären Sie sein Ergebnis im Bearbeitungsdialog.',
          'Another operation is unresolved. Close this dialog and resolve '
              'its outcome in the edit dialog.',
        ),
      );
    }

    final unsent = !receipt.dispatching && !receipt.acknowledged;
    final acknowledged = receipt.deletionConfirmed;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          acknowledged
              ? text(
                  context,
                  'Der Server hat die Löschung bestätigt. Nur der lokale '
                      'Vorgangsbeleg muss noch entfernt werden.',
                  'The server acknowledged deletion. Only the local operation '
                      'receipt remains to be removed.',
                )
              : unsent
              ? text(
                  context,
                  'Dieser Vorgang wurde noch nicht gesendet und kann '
                      'verworfen werden.',
                  'This operation has not been sent and can be discarded.',
                )
              : text(
                  context,
                  'Die Serverbestätigung fehlt. Der Vorgang wird nicht erneut '
                      'gesendet. Ein fehlender Datensatz bestätigt keine Löschung.',
                  'The server acknowledgement is missing. The operation will '
                      'not be resubmitted. A missing record does not establish '
                      'successful deletion.',
                ),
        ),
        if (_canRecover(receipt)) ...[
          const SizedBox(height: 16),
          SsButton(
            kind: SsButtonKind.secondary,
            onPressed: _busy || _completed
                ? null
                : () {
                    unawaited(_run(recover: true));
                  },
            child: Text(
              acknowledged
                  ? text(
                      context,
                      'Bestätigten Löschvorgang abschließen',
                      'Finish acknowledged deletion',
                    )
                  : text(
                      context,
                      'Nicht gesendeten Vorgang verwerfen',
                      'Discard unsent operation',
                    ),
            ),
          ),
        ],
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    final current = _current;
    final receipt = _receipt;
    final colors = SsTheme.of(context);

    return PopScope(
      canPop: !_busy,
      child: Dialog(
        shape: const RoundedRectangleBorder(),
        insetPadding: const EdgeInsets.all(16),
        backgroundColor: colors.surface,
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 640),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Padding(
                padding: const EdgeInsets.all(16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      text(context, 'Händler löschen', 'Delete vendor'),
                      style: colors.heading,
                    ),
                    if (current) Text(widget.vendor.name),
                  ],
                ),
              ),
              Flexible(
                child: SingleChildScrollView(
                  padding: const EdgeInsets.symmetric(horizontal: 16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      if (!current)
                        Text(
                          text(context, 'Keine Berechtigung', 'No permission'),
                        )
                      else if (_checking)
                        const Center(child: SsSpinner())
                      else if (receipt != null)
                        _pending(receipt)
                      else if (_journalKnown)
                        _confirmation()
                      else
                        Text(
                          text(
                            context,
                            'Der Vorgangsstatus konnte nicht geprüft werden. '
                                'Es wird keine Löschung gesendet.',
                            'The operation status could not be checked. '
                                'No deletion will be submitted.',
                          ),
                        ),
                      if (_error && current) ...[
                        const SizedBox(height: 16),
                        Text(
                          _conflict
                              ? text(
                                  context,
                                  'Der Händler wurde zwischenzeitlich geändert. '
                                      'Schließen Sie den Dialog und laden Sie '
                                      'den Händler vor dem Löschen neu.',
                                  'The vendor has changed. Close this dialog '
                                      'and reload the vendor before deleting.',
                                )
                              : text(
                                  context,
                                  'Der Vorgang konnte nicht abgeschlossen werden.',
                                  'The operation could not be completed.',
                                ),
                        ),
                      ],
                      if (!_journalKnown && !_checking && current) ...[
                        const SizedBox(height: 8),
                        SsButton(
                          kind: SsButtonKind.secondary,
                          onPressed: _busy
                              ? null
                              : () {
                                  setState(() {
                                    _checking = true;
                                  });

                                  unawaited(_loadReceipt());
                                },
                          child: Text(text(context, 'Erneut laden', 'Reload')),
                        ),
                      ],
                      const SizedBox(height: 16),
                    ],
                  ),
                ),
              ),
              Padding(
                padding: const EdgeInsets.all(16),
                child: Wrap(
                  alignment: WrapAlignment.end,
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    if (_busy) const SsSpinner(),
                    SsButton(
                      kind: SsButtonKind.secondary,
                      onPressed: _busy ? null : widget.onCancel,
                      child: Text(text(context, 'Abbrechen', 'Cancel')),
                    ),
                    SsButton(
                      kind: SsButtonKind.danger,
                      onPressed: _ready
                          ? () {
                              unawaited(_run(recover: false));
                            }
                          : null,
                      child: Text(text(context, 'Löschen', 'Delete')),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
