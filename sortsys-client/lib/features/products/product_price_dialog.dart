import 'dart:async';

import 'package:flutter/material.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

import '../../api/generated/models.g.dart' as models;
import '../../ui/text.dart';
import 'product_detail_layout.dart';
import 'product_price_form_fields.dart';
import 'product_price_receipt.dart';
import 'product_price_write_coordinator.dart';

Future<models.ProductsPriceRecordsListResultItem?> showProductPriceDialog(
  BuildContext context, {
  required models.Product product,
  required ProductPriceWriteCoordinator coordinator,
  required Object queryIdentity,
  required bool Function() isCurrent,
  required bool Function() canCreate,
  required Future<List<models.ProductVendor>> Function(String) loadVendors,
  Listenable? changes,
}) {
  final colors = SsTheme.of(context);

  Widget buildDialog(BuildContext dialogContext) {
    return SsTheme(
      colors: colors,
      child: ProductPriceDialog(
        product: product,
        coordinator: coordinator,
        queryIdentity: queryIdentity,
        isCurrent: isCurrent,
        enabled: canCreate(),
        loadVendors: loadVendors,
        onSaved: (record) {
          if (!isCurrent()) {
            return;
          }

          Navigator.of(dialogContext).pop(record);
        },
        onCancel: () {
          Navigator.of(dialogContext).pop();
        },
      ),
    );
  }

  return showDialog<models.ProductsPriceRecordsListResultItem>(
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

class ProductPriceDialog extends StatefulWidget {
  const ProductPriceDialog({
    super.key,
    required this.product,
    required this.coordinator,
    required this.queryIdentity,
    required this.isCurrent,
    required this.loadVendors,
    required this.onSaved,
    required this.onCancel,
    this.enabled = true,
  });

  final models.Product product;
  final ProductPriceWriteCoordinator coordinator;
  final Object queryIdentity;
  final bool Function() isCurrent;
  final Future<List<models.ProductVendor>> Function(String) loadVendors;
  final ValueChanged<models.ProductsPriceRecordsListResultItem> onSaved;
  final VoidCallback onCancel;
  final bool enabled;

  @override
  State<ProductPriceDialog> createState() {
    return _ProductPriceDialogState();
  }
}

class _ProductPriceDialogState extends State<ProductPriceDialog> {
  var _form = GlobalKey<FormState>();
  late ProductPriceFormValues _values;
  final _retiredValues = <ProductPriceFormValues>[];
  int _epoch = 0;

  bool _checking = true;
  bool _journalKnown = false;
  bool _busy = false;
  bool _completed = false;
  bool _uncertain = false;
  bool _error = false;
  ProductPriceWriteReceipt? _receipt;

  @override
  void initState() {
    super.initState();

    _values = ProductPriceFormValues(widget.product);
    unawaited(_loadReceipt());
  }

  @override
  void didUpdateWidget(covariant ProductPriceDialog oldWidget) {
    super.didUpdateWidget(oldWidget);

    if (widget.queryIdentity == oldWidget.queryIdentity &&
        widget.product.id == oldWidget.product.id &&
        widget.coordinator == oldWidget.coordinator) {
      return;
    }

    _epoch++;
    _retiredValues.add(_values);
    _values = ProductPriceFormValues(widget.product);
    _form = GlobalKey<FormState>();
    _checking = true;
    _journalKnown = false;
    _busy = false;
    _completed = false;
    _uncertain = false;
    _error = false;
    _receipt = null;
    unawaited(_loadReceipt());
  }

  @override
  void dispose() {
    _epoch++;
    _values.dispose();

    for (final values in _retiredValues) {
      values.dispose();
    }

    super.dispose();
  }

  bool _alive(int epoch) {
    return mounted && epoch == _epoch;
  }

  bool get _current {
    if (!widget.isCurrent()) {
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
        _receipt == null;
  }

  Future<void> _loadReceipt({bool keepError = false}) async {
    final epoch = _epoch;

    try {
      final receipt = await widget.coordinator.outstanding();

      if (!_alive(epoch)) {
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
      if (receipt == null ||
          (receipt.dispatching && receipt.acknowledgement == null)) {
        return;
      }
    } else if (!_ready || _form.currentState?.validate() != true) {
      return;
    }

    final epoch = _epoch;
    final coordinator = widget.coordinator;
    models.ProductsPriceRecordsListResultItem? record;
    setState(() {
      _busy = true;
      _error = false;
    });

    try {
      if (recover) {
        record = await coordinator.recover(expectedNonce: receipt!.nonce);
      } else {
        record = await coordinator.save(_values.draft());
      }

      if (_alive(epoch) && record == null) {
        _uncertain = false;
        await _loadReceipt();
      }
    } catch (error) {
      if (!_alive(epoch)) {
        return;
      }

      if (error is ProductPriceWriteException &&
          error.failure == ProductPriceWriteFailure.cleanup &&
          error.confirmedRecord != null) {
        record = error.confirmedRecord;
      } else {
        _error = true;

        if (error is ProductPriceWriteException &&
            error.failure == ProductPriceWriteFailure.uncertain) {
          _uncertain = true;
        }

        await _loadReceipt(keepError: true);
      }
    } finally {
      if (_alive(epoch)) {
        setState(() {
          _busy = false;
          _completed = record != null;
        });
      }
    }

    // Navigation/caller errors are not mutation failures and must not retry it.
    if (_alive(epoch) && _current && record != null) {
      widget.onSaved(record);
    }
  }

  Widget _pending(ProductPriceWriteReceipt receipt) {
    final acknowledged = receipt.acknowledgement != null;
    final canRecover = acknowledged || !receipt.dispatching;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          text(
            context,
            'Ein vorheriger Speichervorgang ist noch offen. Neue Preise bleiben '
                'gesperrt, bis sein Ergebnis geklärt ist.',
            'A previous save is unresolved. New price entries remain blocked '
                'until its outcome is confirmed.',
          ),
        ),
        const SizedBox(height: 8),
        Text(
          acknowledged
              ? text(
                  context,
                  'Der bestätigte Preis wird ausschließlich lesend überprüft. '
                      'Der Speichervorgang wird nicht wiederholt.',
                  'The acknowledged price will be verified with a read-only '
                      'request. The save will not be repeated.',
                )
              : receipt.dispatching
              ? text(
                  context,
                  'Die Serverbestätigung fehlt. Dieser Vorgang wird nicht '
                      'erneut gesendet. Ähnliche Preise gelten nicht als '
                      'Nachweis eines erfolgreichen Speicherns.',
                  'The server acknowledgement is missing. This operation '
                      'will not be resubmitted. Similar price records will '
                      'not be treated as proof of success.',
                )
              : text(
                  context,
                  'Dieser Vorgang wurde noch nicht gesendet und kann '
                      'verworfen werden.',
                  'This operation has not been sent and can be discarded.',
                ),
        ),
        if (canRecover) ...[
          const SizedBox(height: 16),
          SsButton(
            kind: SsButtonKind.secondary,
            onPressed: _busy
                ? null
                : () {
                    unawaited(_run(recover: true));
                  },
            child: Text(
              acknowledged
                  ? text(
                      context,
                      'Nur lesend prüfen',
                      'Verify with read-only request',
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
                      text(context, 'Preis verzeichnen', 'Record price'),
                      style: SsTheme.of(context).heading,
                    ),
                    if (current)
                      Text(
                        '${widget.product.customId} ${productTitle(widget.product)}',
                      ),
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
                        Form(
                          key: _form,
                          child: ProductPriceFormFields(
                            values: _values,
                            queryIdentity: widget.queryIdentity,
                            loadVendors: widget.loadVendors,
                            enabled: _ready,
                          ),
                        )
                      else
                        Text(
                          text(
                            context,
                            'Der Status des Speichervorgangs konnte nicht geprüft '
                                'werden. Es werden keine neuen Preise gesendet.',
                            'The save status could not be checked. No new price '
                                'entries will be submitted.',
                          ),
                        ),
                      if (_error && current) ...[
                        const SizedBox(height: 16),
                        Text(
                          text(
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
                      onPressed: _ready
                          ? () {
                              unawaited(_run(recover: false));
                            }
                          : null,
                      child: Text(text(context, 'Speichern', 'Save')),
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
