import 'dart:async';

import 'package:flutter/material.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

import '../../api/generated/models.g.dart' as models;
import '../../ui/text.dart';
import 'product_delete_coordinator.dart';
import 'product_delete_receipt.dart';
import 'product_detail_layout.dart' show productTitle;

Future<String?> showProductDeleteDialog(
  BuildContext context, {
  required models.Product product,
  required ProductDeleteCoordinator coordinator,
  required Object queryIdentity,
  required bool Function() isCurrent,
  required bool Function() canDelete,
  Listenable? changes,
}) {
  final colors = SsTheme.of(context);

  Widget buildDialog(BuildContext dialogContext) {
    return SsTheme(
      colors: colors,
      child: ProductDeleteDialog(
        product: product,
        coordinator: coordinator,
        queryIdentity: queryIdentity,
        isCurrent: isCurrent,
        enabled: canDelete(),
        onDeleted: (id) {
          if (dialogContext.mounted &&
              ModalRoute.of(dialogContext)?.isCurrent == true &&
              isCurrent() &&
              id == product.id) {
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

class ProductDeleteDialog extends StatefulWidget {
  const ProductDeleteDialog({
    super.key,
    required this.product,
    required this.coordinator,
    required this.queryIdentity,
    required this.isCurrent,
    required this.onDeleted,
    required this.onCancel,
    this.enabled = true,
  });

  final models.Product product;
  final ProductDeleteCoordinator coordinator;
  final Object queryIdentity;
  final bool Function() isCurrent;
  final ValueChanged<String> onDeleted;
  final VoidCallback onCancel;
  final bool enabled;

  @override
  State<ProductDeleteDialog> createState() {
    return _ProductDeleteDialogState();
  }
}

class _ProductDeleteDialogState extends State<ProductDeleteDialog> {
  final _form = GlobalKey<FormState>();
  late final models.Product _baseline;
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
  ProductDeleteReceipt? _receipt;

  @override
  void initState() {
    super.initState();

    _baseline = freezeProductDeleteBaseline(widget.product);
    _scope = widget.coordinator.access.scope;

    unawaited(_loadReceipt());
  }

  @override
  void didUpdateWidget(covariant ProductDeleteDialog oldWidget) {
    super.didUpdateWidget(oldWidget);

    if (widget.queryIdentity != oldWidget.queryIdentity ||
        widget.product != oldWidget.product ||
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
          widget.coordinator.access.productId == _baseline.id &&
          widget.product.id == _baseline.id;
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

  bool _canRecover(ProductDeleteReceipt receipt) {
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

      if (error is ProductDeleteException &&
          error.failure == ProductDeleteFailure.cleanup &&
          error.confirmedProductId == _baseline.id) {
        deletedId = error.confirmedProductId;
      } else {
        _error = true;

        if (error is ProductDeleteException) {
          _uncertain = error.failure == ProductDeleteFailure.uncertain;
          _conflict = error.failure == ProductDeleteFailure.conflict;
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
                    'Alle mit diesem Produkt in Verbindung stehenden Daten '
                        'werden damit ebenfalls gelöscht. Dies betrifft '
                        'insbesondere auch Kostenschätzungen. ',
                    'All data associated with this product will also be deleted. '
                        'This includes cost estimates. ',
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

  Widget _pending(ProductDeleteReceipt receipt) {
    final epoch = _epoch;

    if (receipt.input.id != _baseline.id) {
      return Text(
        text(
          context,
          'Ein anderer Produktvorgang ist noch offen. Schließen Sie diesen '
              'Dialog und klären Sie ihn beim ursprünglichen Produkt.',
          'Another product operation is unresolved. Close this dialog '
              'and resolve it for the original product.',
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
                      text(context, 'Produkt löschen', 'Delete product'),
                      style: colors.heading,
                    ),
                    if (current) Text(productTitle(_baseline)),
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
                                'offene Produkt-, Kategorie- oder Preisänderungen '
                                'im ursprünglichen Dialog.',
                            'The operation status could not be checked. '
                                'No deletion will be submitted. Resolve pending '
                                'product, category or price changes in the original dialog.',
                          ),
                        ),
                      if (_error && current) ...[
                        const SizedBox(height: 16),
                        Text(
                          _conflict
                              ? text(
                                  context,
                                  'Das Produkt wurde zwischenzeitlich geändert. '
                                      'Schließen Sie den Dialog und laden Sie '
                                      'das Produkt vor dem Löschen neu.',
                                  'The product has changed. Close this dialog '
                                      'and reload the product before deleting.',
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
