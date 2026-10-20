import 'dart:async';

import 'package:flutter/material.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

import '../../api/generated/models.g.dart' as models;
import '../../ui/text.dart';
import 'customer_form_fields.dart';
import 'customer_write.dart';

Future<String?> showCustomerDialog(
  BuildContext context, {
  models.Customer? customer,
  String initialQuery = '',
  required CustomerWriteCoordinator coordinator,
  required Future<List<models.Contact>> Function(String) loadContacts,
  Future<models.Contact?> Function(String)? createContact,
  bool Function()? canCreateContact,
  required Object queryIdentity,
  required bool Function() isCurrent,
  required bool Function() canSave,
  Listenable? changes,
}) {
  final colors = SsTheme.of(context);

  Widget buildDialog(BuildContext dialogContext) {
    return SsTheme(
      colors: colors,
      child: CustomerDialog(
        customer: customer,
        initialQuery: initialQuery,
        coordinator: coordinator,
        loadContacts: loadContacts,
        createContact: createContact,
        canCreateContact: canCreateContact,
        queryIdentity: queryIdentity,
        isCurrent: isCurrent,
        enabled: canSave(),
        onSaved: (id) {
          if (isCurrent()) {
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
          return buildDialog(dialogContext);
        },
      );
    },
  );
}

class CustomerDialog extends StatefulWidget {
  const CustomerDialog({
    super.key,
    this.customer,
    this.initialQuery = '',
    required this.coordinator,
    required this.loadContacts,
    this.createContact,
    this.canCreateContact,
    required this.queryIdentity,
    required this.isCurrent,
    required this.onSaved,
    required this.onCancel,
    this.enabled = true,
  });

  final models.Customer? customer;
  final String initialQuery;
  final CustomerWriteCoordinator coordinator;
  final Future<List<models.Contact>> Function(String) loadContacts;
  final Future<models.Contact?> Function(String)? createContact;
  final bool Function()? canCreateContact;
  final Object queryIdentity;
  final bool Function() isCurrent;
  final ValueChanged<String> onSaved;
  final VoidCallback onCancel;
  final bool enabled;

  @override
  State<CustomerDialog> createState() {
    return _CustomerDialogState();
  }
}

class _CustomerDialogState extends State<CustomerDialog> {
  var _form = GlobalKey<FormState>();
  CustomerFormValues? _values;
  final _retiredValues = <CustomerFormValues>[];
  CustomerWriteReceipt? _receipt;
  int _epoch = 0;
  bool _checking = true;
  bool _journalKnown = false;
  bool _busy = false;
  bool _completed = false;
  bool _uncertain = false;
  bool _conflict = false;
  bool _error = false;

  bool _alive(int epoch) {
    return mounted && epoch == _epoch;
  }

  bool _accept(int epoch) {
    return _alive(epoch) && widget.isCurrent();
  }

  bool get _selectionCurrent {
    final values = _values;

    return values != null &&
        (values.contacts != null) ==
            widget.coordinator.access.canSelectContacts;
  }

  bool get _ready {
    return widget.isCurrent() &&
        widget.enabled &&
        _selectionCurrent &&
        !_checking &&
        _journalKnown &&
        !_busy &&
        !_completed &&
        !_uncertain &&
        !_conflict &&
        _receipt == null;
  }

  @override
  void initState() {
    super.initState();

    unawaited(_load());
  }

  @override
  void didUpdateWidget(covariant CustomerDialog oldWidget) {
    super.didUpdateWidget(oldWidget);

    if (oldWidget.queryIdentity == widget.queryIdentity &&
        oldWidget.customer?.id == widget.customer?.id &&
        oldWidget.initialQuery == widget.initialQuery &&
        oldWidget.coordinator == widget.coordinator) {
      return;
    }

    final values = _values;

    if (values != null) {
      _retiredValues.add(values);
    }

    _epoch++;
    _values = null;
    _receipt = null;
    _form = GlobalKey<FormState>();
    _checking = true;
    _journalKnown = false;
    _busy = false;
    _completed = false;
    _uncertain = false;
    _conflict = false;
    _error = false;

    unawaited(_load());
  }

  @override
  void dispose() {
    _epoch++;
    _values?.dispose();

    for (final values in _retiredValues) {
      values.dispose();
    }

    super.dispose();
  }

  Future<void> _load() async {
    final epoch = _epoch;
    final coordinator = widget.coordinator;

    try {
      final receipt = await coordinator.outstanding();

      if (!_accept(epoch)) {
        return;
      }

      _receipt = receipt;
      _journalKnown = true;

      if (receipt == null) {
        final seed = await coordinator.load(widget.customer?.id);

        if (!_accept(epoch)) {
          return;
        }

        final values = CustomerFormValues(seed);

        if (seed.customer == null) {
          values.name.text = widget.initialQuery;
        }

        final previous = _values;

        if (previous != null) {
          _retiredValues.add(previous);
        }

        _values = values;
      }
    } catch (_) {
      if (_alive(epoch)) {
        _journalKnown = false;
        _error = true;
      }
    } finally {
      if (_alive(epoch)) {
        setState(() {
          _checking = false;
        });
      }
    }
  }

  Future<void> _run({required bool recover}) async {
    final receipt = _receipt;

    if (_busy || _completed || !widget.isCurrent()) {
      return;
    }

    if (recover) {
      if (receipt?.customerId == null) {
        return;
      }
    } else if (!_ready || _form.currentState?.validate() != true) {
      return;
    }

    final epoch = _epoch;
    final coordinator = widget.coordinator;
    String? confirmedId;

    setState(() {
      _busy = true;
      _error = false;
    });

    try {
      confirmedId = recover
          ? await coordinator.recover(receipt!)
          : await coordinator.save(_values!.draft());
    } catch (error) {
      if (!_accept(epoch)) {
        return;
      }

      if (error is CustomerWriteException &&
          error.failure == CustomerWriteFailure.cleanup &&
          error.confirmedCustomerId != null) {
        confirmedId = error.confirmedCustomerId;
      } else {
        _error = true;
        _conflict =
            error is CustomerWriteException &&
            error.failure == CustomerWriteFailure.conflict;
        _uncertain = !_conflict;

        try {
          final pending = await coordinator.outstanding();

          if (_accept(epoch)) {
            _receipt = pending;
            _journalKnown = true;
          }
        } catch (_) {
          if (_alive(epoch)) {
            _journalKnown = false;
          }
        }
      }
    } finally {
      if (_alive(epoch)) {
        setState(() {
          _busy = false;
          _completed = confirmedId != null;
        });
      }
    }

    // Navigation failures must not be classified as failed business writes.
    if (_accept(epoch) && confirmedId != null) {
      widget.onSaved(confirmedId);
    }
  }

  Widget _pending(CustomerWriteReceipt receipt) {
    final knownTarget = receipt.customerId != null;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          text(
            context,
            'Ein vorheriger Speichervorgang ist noch offen. Neue Änderungen bleiben '
                'gesperrt, bis sein Ergebnis geklärt ist.',
            'A previous save is unresolved. New changes remain blocked until its '
                'outcome is confirmed.',
          ),
        ),
        const SizedBox(height: 8),
        Text(receipt.target.name),
        if (knownTarget) Text(receipt.customerId!),
        const SizedBox(height: 8),
        Text(
          knownTarget
              ? text(
                  context,
                  'Das Ergebnis wird ausschließlich lesend überprüft. '
                      'Der Speichervorgang wird nicht wiederholt.',
                  'The result will be verified with a read-only request. '
                      'The save will not be repeated.',
                )
              : text(
                  context,
                  'Die Serverbestätigung fehlt. Dieser Vorgang wird nicht erneut '
                      'gesendet.',
                  'The server acknowledgement is missing. This operation will not '
                      'be resubmitted.',
                ),
        ),
        if (knownTarget) ...[
          const SizedBox(height: 16),
          SsButton(
            kind: SsButtonKind.secondary,
            onPressed: _busy
                ? null
                : () {
                    unawaited(_run(recover: true));
                  },
            child: Text(
              text(
                context,
                'Nur lesend prüfen',
                'Verify with read-only request',
              ),
            ),
          ),
        ],
      ],
    );
  }

  Widget _status() {
    if (!widget.isCurrent()) {
      return Text(text(context, 'Keine Berechtigung', 'No permission'));
    }

    if (_checking) {
      return const Center(child: SsSpinner());
    }

    final receipt = _receipt;

    if (receipt != null) {
      return _pending(receipt);
    }

    final values = _values;

    if (_journalKnown && values != null) {
      if (!_selectionCurrent) {
        return Text(
          text(
            context,
            'Die Formularberechtigungen haben sich geändert. Schließen Sie den '
                'Dialog und öffnen Sie ihn erneut.',
            'The form permissions changed. Close the dialog and reopen it.',
          ),
        );
      }

      return Form(
        key: _form,
        child: CustomerFormFields(
          values: values,
          queryIdentity: widget.queryIdentity,
          loadContacts: widget.loadContacts,
          createContact: widget.createContact,
          canCreateContact: widget.canCreateContact,
          enabled: _ready,
        ),
      );
    }

    return Text(
      text(
        context,
        'Der Status des Speichervorgangs konnte nicht geprüft '
            'werden. Es werden keine Änderungen gesendet.',
        'The save status could not be checked. No changes '
            'will be submitted.',
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final customer = widget.customer;

    return PopScope(
      canPop: !_busy,
      child: Dialog(
        shape: const RoundedRectangleBorder(),
        insetPadding: const EdgeInsets.all(16),
        backgroundColor: SsTheme.of(context).surface,
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
                      customer == null
                          ? text(context, 'Kunde erstellen', 'Create customer')
                          : text(context, 'Kunde bearbeiten', 'Edit customer'),
                      style: SsTheme.of(context).heading,
                    ),
                    if (customer != null) Text(customer.name),
                  ],
                ),
              ),
              Flexible(
                child: SingleChildScrollView(
                  padding: const EdgeInsets.symmetric(horizontal: 16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      _status(),
                      if (_error && widget.isCurrent()) ...[
                        const SizedBox(height: 16),
                        Text(
                          _conflict
                              ? text(
                                  context,
                                  'Der Kunde wurde zwischenzeitlich geändert. '
                                      'Schließen Sie den Dialog und laden Sie '
                                      'den Kunden vor der Bearbeitung neu.',
                                  'The customer changed. Close this dialog and '
                                      'reload the customer before editing again.',
                                )
                              : text(
                                  context,
                                  'Der Vorgang konnte nicht abgeschlossen werden.',
                                  'The operation could not be completed.',
                                ),
                        ),
                      ],
                      if (!_journalKnown && !_checking) ...[
                        const SizedBox(height: 8),
                        SsButton(
                          kind: SsButtonKind.secondary,
                          onPressed: _busy
                              ? null
                              : () {
                                  setState(() {
                                    _checking = true;
                                  });

                                  unawaited(_load());
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
                      onPressed: _ready
                          ? () {
                              unawaited(_run(recover: false));
                            }
                          : null,
                      child: Text(
                        customer == null
                            ? text(context, 'Erstellen', 'Create')
                            : text(context, 'Speichern', 'Save'),
                      ),
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
