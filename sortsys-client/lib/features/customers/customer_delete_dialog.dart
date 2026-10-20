import 'dart:async';

import 'package:flutter/material.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

import '../../api/generated/models.g.dart' as models;
import '../../ui/text.dart';
import 'customer_delete_coordinator.dart';
import 'customer_delete_receipt.dart';
import 'customer_list_state.dart';

Future<String?> showCustomerDeleteDialog(
  BuildContext context, {
  required models.Customer customer,
  required CustomerDeleteCoordinator coordinator,
  required Object queryIdentity,
  required bool Function() isCurrent,
  required bool Function() canDelete,
  Listenable? changes,
}) {
  final colors = SsTheme.of(context);

  Widget buildDialog(BuildContext dialogContext) {
    return SsTheme(
      colors: colors,
      child: CustomerDeleteDialog(
        customer: customer,
        coordinator: coordinator,
        queryIdentity: queryIdentity,
        isCurrent: isCurrent,
        enabled: canDelete(),
        onDeleted: (id) {
          if (isCurrent() && id == customer.id) {
            Navigator.of(dialogContext).pop(id);
          }
        },
        onCancel: () {
          if (dialogContext.mounted &&
              ModalRoute.of(dialogContext)?.isCurrent == true) {
            Navigator.of(dialogContext).pop();
          }
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

class CustomerDeleteDialog extends StatefulWidget {
  const CustomerDeleteDialog({
    super.key,
    required this.customer,
    required this.coordinator,
    required this.queryIdentity,
    required this.isCurrent,
    required this.onDeleted,
    required this.onCancel,
    this.enabled = true,
  });

  final models.Customer customer;
  final CustomerDeleteCoordinator coordinator;
  final Object queryIdentity;
  final bool Function() isCurrent;
  final ValueChanged<String> onDeleted;
  final VoidCallback onCancel;
  final bool enabled;

  @override
  State<CustomerDeleteDialog> createState() {
    return _CustomerDeleteDialogState();
  }
}

class _CustomerDeleteDialogState extends State<CustomerDeleteDialog> {
  final _form = GlobalKey<FormState>();
  late final models.Customer _baseline;
  late final String _scope;

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
  CustomerDeleteReceipt? _receipt;

  @override
  void initState() {
    super.initState();

    _baseline = freezeCustomerDeleteBaseline(widget.customer);
    _scope = widget.coordinator.access.scope;

    unawaited(_loadReceipt());
  }

  @override
  void didUpdateWidget(covariant CustomerDeleteDialog oldWidget) {
    super.didUpdateWidget(oldWidget);

    if (widget.queryIdentity != oldWidget.queryIdentity ||
        widget.customer != oldWidget.customer ||
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
    if (!mounted || _retired || !widget.isCurrent()) {
      return false;
    }

    try {
      widget.coordinator.access.checkCurrent();

      return widget.coordinator.access.scope == _scope &&
          widget.customer.id == _baseline.id;
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

  bool _canRecover(CustomerDeleteReceipt receipt) {
    if (receipt.input.id != _baseline.id) {
      return false;
    }

    return (!receipt.dispatching && !receipt.acknowledged) ||
        receipt.acknowledged;
  }

  Future<void> _loadReceipt({bool keepError = false}) async {
    if (!mounted || !_current) {
      return;
    }

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

  Future<void> _run({required bool recover, String? expectedNonce}) async {
    final receipt = _receipt;

    if (!_current || _busy || _checking || _completed) {
      return;
    }

    if (recover) {
      if (receipt == null ||
          receipt.nonce != expectedNonce ||
          !_canRecover(receipt)) {
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
          baseline: _baseline,
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

      if (error is CustomerDeleteException &&
          error.failure == CustomerDeleteFailure.cleanup &&
          error.confirmedCustomerId == _baseline.id) {
        deletedId = error.confirmedCustomerId;
      } else {
        _error = true;

        if (error is CustomerDeleteException) {
          _uncertain = error.failure == CustomerDeleteFailure.uncertain;
          _conflict = error.failure == CustomerDeleteFailure.conflict;
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
    if (_alive(epoch) && _current && deletedId == _baseline.id) {
      widget.onDeleted(deletedId!);
    }
  }

  Widget _confirmation() {
    final epoch = _epoch;
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
                    'Alle mit diesem Kunden in Verbindung stehenden Daten '
                        'werden damit ebenfalls gelöscht. ',
                    'All data associated with this customer will also be deleted. ',
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
              if (!_alive(epoch) || !_ready) {
                return;
              }

              setState(() {
                _understood = value;
              });
            },
          ),
        ],
      ),
    );
  }

  Widget _pending(CustomerDeleteReceipt receipt) {
    final epoch = _epoch;

    if (receipt.input.id != _baseline.id) {
      return Text(
        text(
          context,
          'Ein anderer Kundenvorgang ist noch offen. Schließen Sie diesen '
              'Dialog und klären Sie ihn beim ursprünglichen Kunden.',
          'Another customer operation is unresolved. Close this dialog '
              'and resolve it for the original customer.',
        ),
      );
    }

    final unsent = !receipt.dispatching && !receipt.acknowledged;
    final acknowledged = receipt.acknowledged;

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
                    if (!_alive(epoch) || !_current || _busy || _completed) {
                      return;
                    }

                    unawaited(
                      _run(recover: true, expectedNonce: receipt.nonce),
                    );
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
    final epoch = _epoch;
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
                      text(context, 'Kunde löschen', 'Delete customer'),
                      style: colors.heading,
                    ),
                    if (current) Text(customerName(_baseline)),
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
                                'Es wird keine Löschung gesendet. Klären Sie '
                                'offene Kundenänderungen im Bearbeitungsdialog.',
                            'The operation status could not be checked. '
                                'No deletion will be submitted. Resolve pending '
                                'customer changes in the edit dialog.',
                          ),
                        ),
                      if (_error && current) ...[
                        const SizedBox(height: 16),
                        Text(
                          _conflict
                              ? text(
                                  context,
                                  'Der Kunde wurde zwischenzeitlich geändert. '
                                      'Schließen Sie den Dialog und laden Sie '
                                      'den Kunden vor dem Löschen neu.',
                                  'The customer has changed. Close this dialog '
                                      'and reload the customer before deleting.',
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
                                  if (!_alive(epoch) ||
                                      !_current ||
                                      _busy ||
                                      _checking) {
                                    return;
                                  }

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
                      onPressed: _busy
                          ? null
                          : () {
                              if (!_alive(epoch) || _busy) {
                                return;
                              }

                              widget.onCancel();
                            },
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
